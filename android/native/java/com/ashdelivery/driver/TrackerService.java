package com.ashdelivery.driver;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
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
import java.util.concurrent.RejectedExecutionException;

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
 * surface is a few files that will be opened once a year, by people who are not Android developers.
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
 *
 *
 * KEEPING IT ALIVE. Three background-reliability hardenings, each closing a way location silently
 * stops: a fallback to the platform `LocationManager` when Google Play Services is absent (Huawei
 * and any GMS-less device), a watchdog that re-arms the location request when fixes stop arriving,
 * a wake lock spanning the upload so an in-flight POST is not frozen when the CPU suspends, and a
 * guarded `startForeground` so a permission-less restart on Android 14+ stops cleanly rather than
 * crash-looping.
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

    /**
     * How long with NO fix before the watchdog assumes the provider callback was silently dropped
     * (a Play-services background update, a long Doze, an OEM hiccup) and re-arms the request.
     */
    private static final long STALE_AFTER_MS = 6 * INTERVAL_MS;

    /** The batch cap, matching the server's: a phone out of signal returns with a run, not a fix. */
    private static final int FLUSH_MAX = 500;

    /** Bounded so a phone that never regains signal cannot grow this without limit. */
    private static final int BUFFER_MAX = 2_000;

    private final ArrayDeque<JSONObject> buffer = new ArrayDeque<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler ticker = new Handler(Looper.getMainLooper());

    private FusedLocationProviderClient client;
    private LocationRequest fusedRequest;
    private LocationManager platformManager;
    private LocationListener platformListener;
    private boolean usingPlatform = false;

    private String shiftId;
    private String origin;
    private volatile boolean stopped = false;
    /** Elapsed-realtime of the last fix, for the watchdog. Set when updates start so it does not fire early. */
    private volatile long lastFixElapsedMs = 0L;

    private final LocationCallback callback = new LocationCallback() {
        @Override
        public void onLocationResult(@NonNull LocationResult result) {
            enqueue(result.getLastLocation());
        }
    };

    /** Held as a field so both the callback and the ticker submit the same task. */
    private final Runnable this_flush = this::flush;

    /**
     * The heartbeat: flush regardless of a fix arriving, and re-arm the provider if it went silent.
     *
     * The upload used to be driven only by `onLocationResult`, which strands the buffer exactly when
     * it matters: indoors, with the GPS disabled, or when the provider simply stalls, no fix arrives
     * — so nothing is sent and nothing retries. A failed POST had the same shape. This ticks
     * regardless, and if fixes have stopped entirely it re-establishes the location request.
     */
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (stopped) return;
            if (SystemClock.elapsedRealtime() - lastFixElapsedMs > STALE_AFTER_MS) rearmUpdates();
            submitFlush();
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

        /*
         * A permission-less restart must stop, not crash. On Android 14+ the location foreground
         * service type is validated INSIDE startForeground(): if the runtime location permission was
         * revoked while the app process was dead, startForeground() itself throws. A sticky null
         * intent (memory kill) or a BootReceiver restart can land here in exactly that state, and an
         * uncaught throw crash-loops a START_STICKY service. Gate first, then guard.
         */
        if (!hasLocationPermission()) {
            forget();
            stopSelf();
            return START_NOT_STICKY;
        }

        prefs.edit().putString(KEY_SHIFT_ID, id).putString(KEY_ORIGIN, base).apply();
        shiftId = id;
        origin = base;
        stopped = false;

        try {
            startForeground(NOTIFICATION_ID, notification());
        } catch (Exception startDenied) {
            // Location FGS-type validation (API 34+) or an OEM restriction refused the start. A plain
            // stopSelf() after a failed startForeground is the sanctioned abort and does not trip the
            // "did not call startForeground in time" crash.
            forget();
            stopSelf();
            return START_NOT_STICKY;
        }

        lastFixElapsedMs = SystemClock.elapsedRealtime();
        startLocationUpdates();

        ticker.removeCallbacks(tick);
        ticker.postDelayed(tick, INTERVAL_MS);
        return START_STICKY;
    }

    /**
     * Start the fixes, preferring the fused provider but falling back to the platform.
     *
     * `FusedLocationProviderClient` is a Google Play Services API. On a GMS-less device (Huawei/EMUI
     * since 2019, or any phone where Play Services is disabled or stale) `getFusedLocationProviderClient`
     * still returns a client, but its `requestLocationUpdates` task fails and NO callback ever fires —
     * the service shows its notification and flushes empty batches while location silently never
     * flows. So: use fused only when Play Services is actually available, and hand any failure — sync
     * or async — to the platform `LocationManager`, which every Android phone has.
     */
    private void startLocationUpdates() {
        boolean gms = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this) == ConnectionResult.SUCCESS;
        if (!gms) {
            startPlatformUpdates();
            return;
        }
        usingPlatform = false;
        client = LocationServices.getFusedLocationProviderClient(this);
        fusedRequest = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVAL_MS)
                .setMinUpdateIntervalMillis(FASTEST_INTERVAL_MS)
                .build();
        try {
            client.requestLocationUpdates(fusedRequest, callback, Looper.getMainLooper())
                    .addOnFailureListener(e -> startPlatformUpdates());
        } catch (SecurityException denied) {
            forget();
            stopSelf();
        }
    }

    /** The universal fallback: raw GPS/network providers, delivered to the same buffer. */
    private void startPlatformUpdates() {
        if (stopped) return;
        if (platformManager == null) platformManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (platformManager == null) return;
        usingPlatform = true;
        if (platformListener == null) {
            platformListener = new LocationListener() {
                @Override
                public void onLocationChanged(@NonNull Location location) {
                    enqueue(location);
                }

                // Abstract on API 24–29, so all three must be implemented even though newer Android
                // no longer calls onStatusChanged.
                @Override
                public void onStatusChanged(String provider, int status, Bundle extras) {}

                @Override
                public void onProviderEnabled(@NonNull String provider) {}

                @Override
                public void onProviderDisabled(@NonNull String provider) {}
            };
        }
        try {
            for (String provider : new String[]{ LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
                if (platformManager.getAllProviders().contains(provider) && platformManager.isProviderEnabled(provider)) {
                    platformManager.requestLocationUpdates(provider, INTERVAL_MS, 0f, platformListener, Looper.getMainLooper());
                }
            }
        } catch (SecurityException denied) {
            forget();
            stopSelf();
        }
    }

    /** Tear down whichever provider is running, then start it again — the watchdog's re-arm. */
    private void rearmUpdates() {
        // Bump first, so a provider that is simply out of signal is not re-armed on every tick.
        lastFixElapsedMs = SystemClock.elapsedRealtime();
        removeUpdates();
        startLocationUpdates();
    }

    private void removeUpdates() {
        if (client != null) {
            try { client.removeLocationUpdates(callback); } catch (Exception ignored) {}
        }
        if (platformManager != null && platformListener != null) {
            try { platformManager.removeUpdates(platformListener); } catch (Exception ignored) {}
        }
    }

    /** One place both providers hand a fix to: buffer it, note it for the watchdog, and flush. */
    private void enqueue(Location location) {
        if (stopped || location == null) return;
        lastFixElapsedMs = SystemClock.elapsedRealtime();
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
            // Oldest out when full: when the buffer overflows the recent minutes are the ones worth
            // keeping, because a stale position is what the live map must never be given.
            while (buffer.size() >= BUFFER_MAX) buffer.removeFirst();
            buffer.addLast(fix);
        }
        submitFlush();
    }

    /** Submit a flush, tolerating the teardown window where the IO executor is already shut down. */
    private void submitFlush() {
        if (stopped) return;
        try {
            io.execute(this_flush);
        } catch (RejectedExecutionException shuttingDown) {
            // A fix already on the main looper can arrive after onDestroy()'s io.shutdown(). Not an
            // error — the shift is ending; there is nothing left to flush to.
        }
    }

    @Override
    public void onDestroy() {
        stopped = true;
        ticker.removeCallbacks(tick);
        removeUpdates();
        io.shutdown();
        super.onDestroy();
    }

    /** Drop the persisted assignment, so a later restart does not resume a shift that is over. */
    private void forget() {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
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

        /*
         * Hold a partial wake lock across the upload.
         *
         * A location fix briefly wakes the CPU (the location HAL holds its own wakelock while
         * delivering), which is what let us reach this flush with the screen off. But nothing keeps
         * the CPU awake for the network round-trip: it can suspend mid-POST, freezing the socket
         * until the next fix wakes it — on a bad connection the upload never completes and the buffer
         * only grows. The lock is timed as a safety valve so a wedged request can never hold it open.
         */
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock lock = pm != null ? pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ash:gps-flush") : null;
        if (lock != null) {
            try { lock.acquire(40_000L); } catch (Exception ignored) { lock = null; }
        }

        try {
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
        } finally {
            if (lock != null && lock.isHeld()) {
                try { lock.release(); } catch (Exception ignored) {}
            }
        }
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
