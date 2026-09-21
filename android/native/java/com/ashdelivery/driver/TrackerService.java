package com.ashdelivery.driver;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The thing the whole Android app exists for: location that keeps flowing with the screen off.
 *
 * Measured in production on 2026-09-08, with only the web beacon: of seven open shifts exactly ONE
 * was broadcasting, and its single stored fix had been captured thirty-two minutes before it
 * arrived. That is not a bug in the web beacon — the browser stops `watchPosition` the moment the
 * page is backgrounded or the screen locks, and geolocation is not available to a service worker
 * at all. No amount of JavaScript fixes it. This class is the fix.
 *
 *
 * WHY JAVA. Capacitor's Android template ships no Kotlin plugin, and adding one drags in a
 * Kotlin/AGP version matrix that somebody would have to keep matched — on a project whose Android
 * surface is two files that will be opened once a year, by people who are not Android developers.
 * Staying on the template's own rails is the cheaper thing to own.
 *
 *
 * WHY IT UPLOADS ITSELF RATHER THAN HANDING FIXES TO THE WEBVIEW.
 *
 * A plugin that delivers positions to a JavaScript callback is only as alive as the WebView, and
 * whether the WebView still runs with the screen off is precisely the uncertainty we are here to
 * remove. So the HTTP call is native. The owner asked for «مباشر» — the office learns where the
 * driver is now, not when he next unlocks his phone.
 *
 *
 * WHY IT NEEDS NO NEW CREDENTIAL.
 *
 * `httpOnly` hides a cookie from `document.cookie`. It does not hide it from the app that owns the
 * WebView: `CookieManager` is the native cookie jar. So this service sends the driver's ordinary
 * session, which means revocation, expiry and deactivation all keep working exactly as they do for
 * the console — `sessions.revoked_at` already stops a session dead, and a lost phone is a manager
 * revoking it, which is the same action as today.
 *
 * This is also why the shell loads the site over its real origin rather than bundling the assets:
 * bundled, the WebView's origin becomes `https://localhost`, the cookie is not there, and this
 * approach collapses.
 *
 *
 * WHAT STOPS IT.
 *
 * A 409 from the ingest route, and nothing else. The service outlives the WebView, so JavaScript
 * may never get the chance to call `stop()`; the server saying «this shift is no longer live» is
 * the only signal that reliably arrives. Every other failure — offline, 5xx, a timeout — means «not
 * yet», so the buffer is kept and the next tick retries. Reverse those two and a phone hammers a
 * closed shift every fifteen seconds for weeks with nobody watching.
 */
public class TrackerService extends Service {

    public static final String EXTRA_SHIFT_ID = "shiftId";
    public static final String EXTRA_ORIGIN = "origin";

    private static final String CHANNEL_ID = "ash_tracking";
    private static final int NOTIFICATION_ID = 4711;

    /** Where the assignment survives a restart. See {@link #onStartCommand}. */
    // Package-private so BootReceiver can restart from the same saved assignment after a reboot.
    static final String PREFS = "ash_tracker";
    static final String KEY_SHIFT_ID = "shiftId";
    static final String KEY_ORIGIN = "origin";

    /**
     * How often a fix is requested, and how often the buffer is flushed.
     *
     * SRS K's own non-functional target is a point every 10–30 s. Fifteen matches the web beacon it
     * replaces, so a trail does not change shape the day a driver installs the app — which matters
     * because that distance is compared against the odometer.
     */
    private static final long INTERVAL_MS = 15_000L;

    /** Never faster than this, whatever the platform decides to deliver. */
    private static final long FASTEST_INTERVAL_MS = 10_000L;

    /** The batch cap, matching the server's: a phone out of signal returns with a run, not a fix. */
    private static final int FLUSH_MAX = 500;

    /** Bounded so a phone that never regains signal cannot grow this without limit. */
    private static final int BUFFER_MAX = 2_000;

    private final ArrayDeque<JSONObject> buffer = new ArrayDeque<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler ticker = new Handler(Looper.getMainLooper());
    private FusedLocationProviderClient client;
    private String shiftId;
    private String origin;
    private volatile boolean stopped = false;

    private final LocationCallback callback = new LocationCallback() {
        @Override
        public void onLocationResult(@NonNull LocationResult result) {
            Location location = result.getLastLocation();
            if (location == null) return;
            JSONObject fix = new JSONObject();
            try {
                fix.put("lat", location.getLatitude());
                fix.put("lng", location.getLongitude());
                fix.put("accuracyM", location.hasAccuracy() ? (double) location.getAccuracy() : JSONObject.NULL);
                fix.put("capturedAtMs", location.getTime());
            } catch (Exception ignored) {
                return;
            }
            synchronized (buffer) {
                // Oldest out when full: when the buffer overflows the recent minutes are the ones
                // worth keeping, because a stale position is what the live map must never be given.
                while (buffer.size() >= BUFFER_MAX) buffer.removeFirst();
                buffer.addLast(fix);
            }
            io.execute(this_flush);
        }
    };

    /** Held as a field so both the callback and the ticker submit the same task. */
    private final Runnable this_flush = this::flush;

    /**
     * A flush that does not depend on a fix arriving.
     *
     * The upload used to be driven only by `onLocationResult`, which strands the buffer exactly
     * when it matters: indoors, with the GPS disabled, or when the provider simply stalls, no fix
     * arrives — so nothing is sent and nothing retries. A failed POST had the same shape, waiting
     * on a fix that might never come. This ticks regardless.
     */
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (stopped) return;
            io.execute(this_flush);
            ticker.postDelayed(this, INTERVAL_MS);
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        /*
         * THE RESTART PATH, which used to kill itself.
         *
         * START_STICKY is the whole of «دائم»: it asks Android to bring the service back after it
         * is killed under memory pressure — and Android brings it back with a NULL intent. The old
         * code read `intent.getStringExtra(...)`, found nothing, and called `stopSelf()`. So the
         * one mechanism that existed to survive being killed was the one that guaranteed it would
         * not. The assignment is now persisted, and a null intent resumes from it.
         */
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String id = intent != null ? intent.getStringExtra(EXTRA_SHIFT_ID) : null;
        String base = intent != null ? intent.getStringExtra(EXTRA_ORIGIN) : null;
        if (id == null || id.trim().isEmpty()) id = prefs.getString(KEY_SHIFT_ID, null);
        if (base == null || base.trim().isEmpty()) base = prefs.getString(KEY_ORIGIN, null);
        if (id == null || id.trim().isEmpty() || base == null || base.trim().isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        prefs.edit().putString(KEY_SHIFT_ID, id).putString(KEY_ORIGIN, base).apply();

        shiftId = id;
        origin = base;
        stopped = false;

        startForeground(NOTIFICATION_ID, notification());
        client = LocationServices.getFusedLocationProviderClient(this);
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVAL_MS)
                .setMinUpdateIntervalMillis(FASTEST_INTERVAL_MS)
                .build();
        try {
            client.requestLocationUpdates(request, callback, Looper.getMainLooper());
        } catch (SecurityException denied) {
            // The permission was revoked between starting and now. Stopping is the honest response:
            // a foreground notification promising tracking that cannot happen is worse than none.
            forget();
            stopSelf();
            return START_NOT_STICKY;
        }
        ticker.removeCallbacks(tick);
        ticker.postDelayed(tick, INTERVAL_MS);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        ticker.removeCallbacks(tick);
        if (client != null) client.removeLocationUpdates(callback);
        io.shutdown();
        super.onDestroy();
    }

    /** Drop the persisted assignment, so a later restart does not resume a shift that is over. */
    private void forget() {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    /**
     * The notification is not decoration and not a formality — it is the driver's notice.
     *
     * Android requires it for a location foreground service, and that requirement happens to be
     * exactly right here: a man is being followed while he works, and he can see that he is, for as
     * long as it is happening. It disappears the moment his shift closes.
     */
    private Notification notification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.tracking_channel_name),
                    // LOW: it must be visible and must not buzz. He is riding.
                    NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(getString(R.string.tracking_title))
                .setContentText(getString(R.string.tracking_text))
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    /** Take everything buffered and post it. Runs on the single IO thread, so it never overlaps. */
    private void flush() {
        if (stopped) return;
        String id = shiftId;
        String base = origin;
        if (id == null || base == null) return;

        List<JSONObject> sending = new ArrayList<>();
        synchronized (buffer) {
            if (buffer.isEmpty()) return;
            Iterator<JSONObject> it = buffer.iterator();
            while (it.hasNext() && sending.size() < FLUSH_MAX) sending.add(it.next());
        }

        JSONObject body = new JSONObject();
        try {
            body.put("source", "phone_bg");
            body.put("fixes", new JSONArray(sending));
        } catch (Exception malformed) {
            return;
        }

        Outcome outcome = post(base + "/api/shifts/" + id + "/gps", body);
        if (outcome == Outcome.ACCEPTED) {
            synchronized (buffer) {
                // Remove exactly what was sent; anything captured meanwhile stays queued. Compared
                // by identity because the overflow rule above may have dropped from the front while
                // the request was in flight.
                for (JSONObject sent : sending) {
                    if (!buffer.isEmpty() && buffer.peekFirst() == sent) buffer.removeFirst();
                }
            }
        } else if (outcome == Outcome.SHIFT_OVER) {
            // The server will never take these. Drop them and stop — see the class comment.
            synchronized (buffer) {
                buffer.clear();
            }
            stopped = true;
            forget();
            stopSelf();
        }
        // RETRY: keep the buffer; the ticker will try again.
    }

    private enum Outcome { ACCEPTED, SHIFT_OVER, RETRY }

    private Outcome post(String url, JSONObject body) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(20_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json");
            // The driver's ordinary session, straight from the WebView's own cookie jar.
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) connection.setRequestProperty("cookie", cookie);

            try (OutputStreamWriter out = new OutputStreamWriter(connection.getOutputStream())) {
                out.write(body.toString());
            }
            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) return Outcome.ACCEPTED;
            if (status == 409) return Outcome.SHIFT_OVER;
            // 401/403 are RETRY on purpose rather than a stop: a session that lapses while the
            // driver is out comes back when he next opens the app, and the fixes he took in
            // between are the ones worth keeping.
            return Outcome.RETRY;
        } catch (Exception offline) {
            return Outcome.RETRY;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
