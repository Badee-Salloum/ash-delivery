package com.ashdelivery.driver;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
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

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

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
 * A 409 from the ingest route or an ended result from the status route stops capture. It never
 * deletes queued fixes: WorkManager can deliver points captured before the end after the service
 * and WebView have both stopped. Offline, 5xx, and timeouts preserve the queue.
 *
 *
 * KEEPING IT ALIVE. Background-reliability hardenings close ways location silently
 * stops: a fallback to the platform `LocationManager` when Google Play Services is absent (Huawei
 * and any GMS-less device), a watchdog that re-arms the location request when fixes stop arriving,
 * a wake lock spanning the upload so an in-flight POST is not frozen when the CPU suspends, and a
 * guarded `startForeground` so a permission-less restart on Android 14+ stops cleanly rather than
 * crash-looping. SQLite keeps queued fixes across process death and reboot.
 */
public class TrackerService extends Service {

    public static final String EXTRA_SHIFT_ID = "shiftId";
    public static final String EXTRA_ORIGIN = "origin";

    private static final String CHANNEL_ID = "ash_tracking";
    private static final int NOTIFICATION_ID = 4711;
    private static final String ALERT_CHANNEL_ID = "ash_tracking_alerts_v1";
    static final int ALERT_NOTIFICATION_ID = 4712;
    private static final long ALERT_INTERVAL_MS = 10 * 60_000L;
    private static final String ALERT_STARTED_KEY = "alertStartedAtMs:";
    private static final String ALERT_LAST_KEY = "alertLastAtMs:";

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

    private static final long STATUS_INTERVAL_MS = 60_000L;
    static volatile boolean serviceRunning = false;
    static volatile String activeShiftId;

    private GpsFixStore fixStore;
    /** SQLite writes never wait for HTTP timeouts. */
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService uploads = Executors.newSingleThreadExecutor();
    private final AtomicBoolean flushScheduled = new AtomicBoolean(false);
    private final AtomicBoolean alertCheckScheduled = new AtomicBoolean(false);
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
    /** A provider callback is not a captured point until SQLite has committed it. */
    private volatile boolean storageFailed = false;
    private volatile long lastRearmElapsedMs = 0L;
    private long lastStatusCheckElapsedMs = 0L;
    private int lastNoticeText = R.string.tracking_text;
    private int lastAlertText = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        fixStore = new GpsFixStore(this);
        GpsUploadWorker.schedule(this);
    }

    private final LocationCallback callback = new LocationCallback() {
        @Override
        public void onLocationResult(@NonNull LocationResult result) {
            // Fused can deliver several points after Doze/network recovery. Keep every capture.
            for (Location location : result.getLocations()) enqueue(location);
        }
    };

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
            long now = SystemClock.elapsedRealtime();
            if (now - lastFixElapsedMs > STALE_AFTER_MS && now - lastRearmElapsedMs > STALE_AFTER_MS) rearmUpdates();
            updateNotice(now);
            checkTrackingAlert();
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

        if (serviceRunning && id.equals(activeShiftId) && base.equals(origin)) {
            // Polling the shift may ask for start again. Do not reset the no-fix timer or
            // register a second provider callback: both would hide a real tracking outage.
            submitFlush();
            return START_STICKY;
        }
        if (serviceRunning) {
            removeUpdates();
            cancelAlertNotification();
        }

        prefs.edit().putString(KEY_SHIFT_ID, id).putString(KEY_ORIGIN, base).apply();
        shiftId = id;
        origin = base;
        stopped = false;
        lastNoticeText = R.string.tracking_text;
        serviceRunning = true;
        activeShiftId = id;
        lastStatusCheckElapsedMs = 0L;
        fixStore.fillMissingOrigin(base);

        try {
            startForeground(NOTIFICATION_ID, notification());
        } catch (Exception startDenied) {
            // Location FGS-type validation (API 34+) or an OEM restriction refused the start. A plain
            // stopSelf() after a failed startForeground is the sanctioned abort and does not trip the
            // "did not call startForeground in time" crash.
            forget();
            serviceRunning = false;
            activeShiftId = null;
            stopSelf();
            return START_NOT_STICKY;
        }

        // A repeated start or START_STICKY restart must keep the original ten-minute clock.
        if (prefs.getLong(ALERT_STARTED_KEY + id, 0L) <= 0L) {
            prefs.edit().putLong(ALERT_STARTED_KEY + id, System.currentTimeMillis()).apply();
        }

        lastFixElapsedMs = SystemClock.elapsedRealtime();
        startLocationUpdates();

        ticker.removeCallbacks(tick);
        ticker.postDelayed(tick, INTERVAL_MS);
        submitFlush(); // Check an empty queue immediately after a sticky restart.
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
        // Re-arm throttle is separate from last fix: a failed provider must stay visibly stale.
        lastRearmElapsedMs = SystemClock.elapsedRealtime();
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
        String assignedShift = shiftId;
        String assignedOrigin = origin;
        if (assignedShift == null || assignedOrigin == null) return;
        try {
            final double lat = location.getLatitude();
            final double lng = location.getLongitude();
            final Float accuracy = location.hasAccuracy() ? location.getAccuracy() : null;
            final long capturedAtMs = location.getTime();
            io.execute(() -> {
                // A stop may race this queued task. The captured point still belongs on disk and
                // WorkManager will upload it even after the service has stopped.
                SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                try {
                    fixStore.enqueue(assignedShift, assignedOrigin, lat, lng, accuracy, capturedAtMs);
                } catch (Exception storageError) {
                    storageFailed = true;
                    prefs.edit()
                            .putLong("lastStorageFailureAtMs:" + assignedShift, System.currentTimeMillis())
                            .putInt("storageFailedCount", prefs.getInt("storageFailedCount", 0) + 1)
                            .putInt("storageFailedCount:" + assignedShift,
                                    prefs.getInt("storageFailedCount:" + assignedShift, 0) + 1)
                            .apply();
                    return;
                }
                storageFailed = false;
                lastFixElapsedMs = SystemClock.elapsedRealtime();
                prefs.edit()
                        .putLong("lastCapturedAtMs", Math.max(capturedAtMs, prefs.getLong("lastCapturedAtMs", 0)))
                        .putLong("lastCapturedAtMs:" + assignedShift,
                                Math.max(capturedAtMs, prefs.getLong("lastCapturedAtMs:" + assignedShift, 0))).apply();
                GpsUploadWorker.schedule(this);
                submitFlush();
            });
        } catch (RejectedExecutionException shuttingDown) {
            // The service is already stopping; a callback posted earlier may arrive after teardown.
        }
    }

    /** Upload on a separate thread so offline HTTP cannot delay SQLite commits. */
    private void submitFlush() {
        if (stopped || !flushScheduled.compareAndSet(false, true)) return;
        try {
            uploads.execute(() -> {
                try { flush(); }
                finally { flushScheduled.set(false); }
            });
        } catch (RejectedExecutionException shuttingDown) {
            flushScheduled.set(false);
            GpsUploadWorker.schedule(this);
        }
    }
    /**
     * The driver swiped the app off the recents list.
     *
     * With `stopWithTask="false"` the service already keeps running on stock Android after a swipe;
     * this is the belt-and-suspenders for OEMs that kill it anyway. It schedules a near-future
     * restart from the saved assignment (not exact — no special alarm permission — but wake-while-
     * idle so Doze does not swallow it). If the shift has since closed, the restarted service's first
     * status check shuts capture down cleanly. It cannot beat a deliberate force-stop, which
     * cancels the alarm too — that is what the office's "not reporting" alert is for.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (!stopped && shiftId != null && origin != null) {
            Intent restart = new Intent(getApplicationContext(), TrackerService.class);
            restart.putExtra(EXTRA_SHIFT_ID, shiftId);
            restart.putExtra(EXTRA_ORIGIN, origin);
            int flags = PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pending = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? PendingIntent.getForegroundService(this, 42, restart, flags)
                    : PendingIntent.getService(this, 42, restart, flags);
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am != null && pending != null) {
                try {
                    am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + 3_000L, pending);
                } catch (Exception ignored) {
                    // Some OEMs cap alarms; nothing else to do, and stopWithTask already covers stock.
                }
            }
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        stopped = true;
        serviceRunning = false;
        activeShiftId = null;
        cancelAlertNotification();
        ticker.removeCallbacks(tick);
        removeUpdates();
        io.shutdown();
        uploads.shutdown();
        GpsUploadWorker.schedule(this);
        super.onDestroy();
    }

    /** Drop the persisted assignment, so a later restart does not resume a shift that is over. */
    private void forget() {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_SHIFT_ID).remove(KEY_ORIGIN).apply();
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
                .setContentText(getString(lastNoticeText))
                .setContentIntent(PendingIntent.getActivity(this, 0,
                        new Intent(this, MainActivity.class),
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void updateNotice(long nowElapsedMs) {
        int next;
        if (storageFailed) next = R.string.tracking_storage_failed;
        else if (!"precise".equals(AshTrackerPlugin.permissionLabel(this))) next = R.string.tracking_permission_lost;
        else if (!AshTrackerPlugin.locationEnabled(this)) next = R.string.tracking_location_disabled;
        else if (nowElapsedMs - lastFixElapsedMs > 2 * 60_000L) next = R.string.tracking_no_fix;
        else if ("offline".equals(GpsUploader.networkLabel(this))) next = R.string.tracking_offline;
        else next = R.string.tracking_text;
        if (next == lastNoticeText) return;
        lastNoticeText = next;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION_ID, notification());
    }

    /**
     * Alert the driver only after ten minutes without a point committed to SQLite, or ten minutes
     * without an accepted upload while this shift actually has queued points. The foreground
     * notification changes sooner; this separate channel can visibly remind the driver every ten
     * minutes while the outage persists. Android may defer a tick or suppress heads-up display.
     */
    private void checkTrackingAlert() {
        String id = shiftId;
        if (stopped || id == null) return;
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        long started = prefs.getLong(ALERT_STARTED_KEY + id, now);
        long captured = prefs.getLong("lastCapturedAtMs:" + id, 0L);
        long uploaded = prefs.getLong("lastUploadedAtMs:" + id, 0L);
        if (now - Math.max(started, captured) >= ALERT_INTERVAL_MS) {
            int reason;
            if (storageFailed || prefs.getLong("lastStorageFailureAtMs:" + id, 0L) > captured)
                reason = R.string.tracking_alert_storage_failed;
            else if (!"precise".equals(AshTrackerPlugin.permissionLabel(this)))
                reason = R.string.tracking_alert_permission_lost;
            else if (!AshTrackerPlugin.locationEnabled(this))
                reason = R.string.tracking_alert_location_disabled;
            else reason = R.string.tracking_alert_no_fix;
            showTrackingAlert(id, reason);
            return;
        }
        if (now - Math.max(started, uploaded) < ALERT_INTERVAL_MS) {
            clearTrackingAlert(id);
            return;
        }

        // A missing upload timestamp alone is not an outage: a shift may have no pending points.
        // Keep the SQLite read off the main thread; the location callback uses this same executor.
        if (!alertCheckScheduled.compareAndSet(false, true)) return;
        try {
            io.execute(() -> {
                int pending = -1;
                int rejected = 0;
                try {
                    JSONObject queue = fixStore.diagnosticsForShift(id);
                    pending = queue.optInt("pendingCount", 0);
                    rejected = queue.optInt("rejectedCount", 0);
                }
                catch (Exception ignored) { /* The capture check will report a sustained write failure. */ }
                final int pendingCount = pending;
                final int rejectedCount = rejected;
                ticker.post(() -> {
                    alertCheckScheduled.set(false);
                    if (stopped || !id.equals(shiftId)) return;
                    SharedPreferences latest = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                    long time = System.currentTimeMillis();
                    long begun = latest.getLong(ALERT_STARTED_KEY + id, time);
                    long lastCapture = latest.getLong("lastCapturedAtMs:" + id, 0L);
                    long lastUpload = latest.getLong("lastUploadedAtMs:" + id, 0L);
                    if (time - Math.max(begun, lastCapture) >= ALERT_INTERVAL_MS) {
                        checkTrackingAlert();
                    } else if (time - Math.max(begun, lastUpload) < ALERT_INTERVAL_MS ||
                            (pendingCount == 0 && rejectedCount == 0)) {
                        clearTrackingAlert(id);
                    } else if (pendingCount > 0) {
                        int reason = "offline".equals(GpsUploader.networkLabel(this))
                                ? R.string.tracking_alert_offline : R.string.tracking_alert_upload_stalled;
                        showTrackingAlert(id, reason);
                    } else if (rejectedCount > 0) {
                        showTrackingAlert(id, R.string.tracking_alert_rejected);
                    }
                });
            });
        } catch (RejectedExecutionException shuttingDown) {
            alertCheckScheduled.set(false);
        }
    }

    private void showTrackingAlert(String id, int reason) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || !canShowTrackingAlerts(manager)) return;
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        long last = prefs.getLong(ALERT_LAST_KEY + id, 0L);
        boolean due = last <= 0L || now < last || now - last >= ALERT_INTERVAL_MS;
        if (!due && lastAlertText == reason) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(ALERT_CHANNEL_ID,
                    getString(R.string.tracking_alert_channel_name), NotificationManager.IMPORTANCE_HIGH);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
            NotificationChannel activeChannel = manager.getNotificationChannel(ALERT_CHANNEL_ID);
            if (activeChannel == null || activeChannel.getImportance() == NotificationManager.IMPORTANCE_NONE) return;
        }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(getString(R.string.tracking_alert_title))
                .setContentText(getString(reason))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(getString(reason)))
                .setContentIntent(PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class),
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ERROR)
                .setOnlyAlertOnce(!due)
                .setAutoCancel(false);
        if (!due) builder.setSilent(true);
        try {
            if (due) manager.cancel(ALERT_NOTIFICATION_ID);
            manager.notify(ALERT_NOTIFICATION_ID, builder.build());
            lastAlertText = reason;
            if (due) prefs.edit().putLong(ALERT_LAST_KEY + id, now).apply();
        } catch (SecurityException denied) {
            // Android 13+ notification permission may have been revoked between check and notify.
        }
    }

    private boolean canShowTrackingAlerts(NotificationManager manager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) return false;
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.N || manager.areNotificationsEnabled();
    }

    private void clearTrackingAlert(String id) {
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (lastAlertText == 0 && prefs.getLong(ALERT_LAST_KEY + id, 0L) == 0L) return;
        cancelAlertNotification();
        prefs.edit().remove(ALERT_LAST_KEY + id).apply();
    }

    private void cancelAlertNotification() {
        lastAlertText = 0;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(ALERT_NOTIFICATION_ID);
    }

    /** The foreground service uploads promptly; WorkManager owns delayed retries after it stops. */
    private void flush() {
        if (stopped || shiftId == null || origin == null) return;
        String id = shiftId;
        String base = origin;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock lock = pm != null ? pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ash:gps-flush") : null;
        if (lock != null) {
            try { lock.acquire(45_000L); } catch (Exception ignored) { lock = null; }
        }
        try {
            GpsUploader.Outcome outcome = GpsUploader.flushOnce(this, fixStore, id, base);
            if (outcome == GpsUploader.Outcome.SHIFT_OVER) {
                stopEndedShift(id);
                return;
            }
            long now = SystemClock.elapsedRealtime();
            if (lastStatusCheckElapsedMs == 0 || now - lastStatusCheckElapsedMs >= STATUS_INTERVAL_MS) {
                lastStatusCheckElapsedMs = now;
                GpsUploader.sendDiagnostics(this, fixStore, id, base, "running");
                if (!GpsUploader.isShiftLive(this, id, base)) stopEndedShift(id);
            }
        } finally {
            if (lock != null && lock.isHeld()) {
                try { lock.release(); } catch (Exception ignored) {}
            }
        }
    }

    private void stopEndedShift(String id) {
        if (!id.equals(shiftId)) return;
        // The shift ended, not the queue. WorkManager can still deliver captured fixes.
        stopped = true;
        serviceRunning = false;
        activeShiftId = null;
        forget();
        GpsUploadWorker.schedule(this);
        stopSelf();
    }
}
