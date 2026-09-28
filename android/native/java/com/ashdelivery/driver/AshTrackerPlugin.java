package com.ashdelivery.driver;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.List;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONObject;

/**
 * The only bridge between the web app and the tracker.
 *
 * Deliberately no GPS data path. Fixes never travel through JavaScript — the service
 * uploads them itself, because a plugin that hands positions to a callback is only as alive as the
 * WebView, and the WebView being asleep is the entire problem this app exists to solve.
 *
 * So the web side's whole job is to say which shift is live. It already knows: `Shift.tsx` polls
 * the server every twenty seconds and holds `serverState`.
 *
 *
 * WHY `start()` ASKS FOR THE PERMISSION ITSELF.
 *
 * It did not, and that was a silent deadlock. Inside the Android shell the web beacon stands down
 * (`use-gps-beacon.ts` returns early when a native tracker is present) — and the web beacon's
 * `watchPosition` was the ONLY thing in the whole product that ever raised a location prompt. So on
 * a fresh install nothing asked, nothing was granted, and `start()` answered «no permission»
 * forever with nobody to tell. The app would have looked simply broken, with no clue why.
 *
 * Asking here rather than from the web side is also what keeps the screen's half to two lines: it
 * states which shift is live, and this decides what that requires.
 */
@CapacitorPlugin(
        name = "AshTracker",
        permissions = {
                @Permission(
                        alias = AshTrackerPlugin.LOCATION,
                        strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }
                ),
                // Android 13+ will not show the foreground-service notification without this, and a
                // location service the driver cannot see is one he never agreed to.
                @Permission(
                        alias = AshTrackerPlugin.NOTIFICATIONS,
                        strings = { Manifest.permission.POST_NOTIFICATIONS }
                ),
                // «Allow all the time». Not for ordinary tracking — the foreground service works on
                // in-use location while the app has been opened — but so BootReceiver can restart
                // the service after a reboot, which the platform only permits with this grant.
                @Permission(
                        alias = AshTrackerPlugin.BACKGROUND,
                        strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }
                )
        }
)
public class AshTrackerPlugin extends Plugin {

    static final String LOCATION = "location";
    static final String NOTIFICATIONS = "notifications";
    static final String BACKGROUND = "background";
    private final Handler probeHandler = new Handler(Looper.getMainLooper());
    private PluginCall probeCall;
    private LocationCallback probeFusedCallback;
    private LocationListener probePlatformListener;
    private FusedLocationProviderClient probeFusedClient;
    private LocationManager probeLocationManager;
    private Runnable probeTimeout;
    private boolean probeSawPoorAccuracy;

    /** Probe the provider before a shift confirmation. Probe coordinates never leave this method. */
    @PluginMethod
    public void preflight(PluginCall call) {
        if (!hasLocationPermission()) {
            requestPermissionForAlias(LOCATION, call, "onPreflightPermission");
            return;
        }
        beginProbe(call);
    }

    @PermissionCallback
    private void onPreflightPermission(PluginCall call) {
        if (!hasLocationPermission()) {
            call.resolve(preflightResult(false, "permission_denied", null));
            return;
        }
        beginProbe(call);
    }

    private JSObject preflightResult(boolean ready, String reason, Location location) {
        JSObject out = new JSObject().put("ready", ready)
                .put("platform", "android").put("nativeVersionCode", appBuild(getContext()));
        if (reason != null) out.put("reason", reason);
        if (location != null) {
            out.put("capturedAtMs", location.getTime());
            if (location.hasAccuracy()) out.put("accuracyM", location.getAccuracy());
        }
        return out;
    }

    private void beginProbe(PluginCall call) {
        if (probeCall != null) {
            call.resolve(preflightResult(false, "provider_error", null));
            return;
        }
        if (!locationEnabled(getContext())) {
            call.resolve(preflightResult(false, "location_disabled", null));
            return;
        }
        probeCall = call;
        probeSawPoorAccuracy = false;
        probeTimeout = () -> finishProbe(null, probeSawPoorAccuracy ? "poor_accuracy" : "no_recent_fix");
        probeHandler.postDelayed(probeTimeout, 60_000L);
        try {
            boolean gms = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext()) == ConnectionResult.SUCCESS;
            if (gms) {
                probeFusedClient = LocationServices.getFusedLocationProviderClient(getContext());
                probeFusedCallback = new LocationCallback() {
                    @Override public void onLocationResult(LocationResult result) {
                        for (Location location : result.getLocations()) checkProbeLocation(location);
                    }
                };
                LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1_000L)
                        .setMinUpdateIntervalMillis(1_000L).build();
                probeFusedClient.requestLocationUpdates(request, probeFusedCallback, Looper.getMainLooper())
                        .addOnFailureListener(error -> {
                            stopProbeUpdates();
                            startPlatformProbe();
                        });
            } else startPlatformProbe();
        } catch (Exception error) {
            stopProbeUpdates();
            startPlatformProbe();
        }
    }

    private void startPlatformProbe() {
        if (probeCall == null) return;
        probeLocationManager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (probeLocationManager == null) {
            finishProbe(null, "provider_error");
            return;
        }
        probePlatformListener = new LocationListener() {
            @Override public void onLocationChanged(Location location) { checkProbeLocation(location); }
            @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
            @Override public void onProviderEnabled(String provider) {}
            @Override public void onProviderDisabled(String provider) {}
        };
        try {
            boolean requested = false;
            for (String provider : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                if (probeLocationManager.isProviderEnabled(provider)) {
                    probeLocationManager.requestLocationUpdates(provider, 1_000L, 0f, probePlatformListener, Looper.getMainLooper());
                    requested = true;
                }
            }
            if (!requested) finishProbe(null, "provider_error");
        } catch (Exception error) { finishProbe(null, "provider_error"); }
    }

    private void checkProbeLocation(Location location) {
        if (probeCall == null || location == null) return;
        long age = System.currentTimeMillis() - location.getTime();
        if (age < -5_000L || age > 30_000L) return;
        if (!location.hasAccuracy() || location.getAccuracy() > 100f) {
            probeSawPoorAccuracy = true;
            return;
        }
        finishProbe(location, null);
    }

    private void finishProbe(Location location, String reason) {
        PluginCall call = probeCall;
        if (call == null) return;
        probeCall = null;
        if (probeTimeout != null) probeHandler.removeCallbacks(probeTimeout);
        stopProbeUpdates();
        call.resolve(preflightResult(location != null, reason, location));
    }

    private void stopProbeUpdates() {
        if (probeFusedClient != null && probeFusedCallback != null)
            try { probeFusedClient.removeLocationUpdates(probeFusedCallback); } catch (Exception ignored) {}
        if (probeLocationManager != null && probePlatformListener != null)
            try { probeLocationManager.removeUpdates(probePlatformListener); } catch (Exception ignored) {}
        probeFusedCallback = null;
        probePlatformListener = null;
    }

    /** Optional reliability setup. It never delays or gates capture at shift confirmation. */
    @PluginMethod
    public void setupReliability(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasBackgroundPermission() && !askedBackground()) {
            markAskedBackground();
            requestPermissionForAlias(BACKGROUND, call, "onReliabilityBackground");
            return;
        }
        requestReliabilityNotification(call);
    }

    @PermissionCallback
    private void onReliabilityBackground(PluginCall call) { requestReliabilityNotification(call); }

    private void requestReliabilityNotification(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotificationPermission()) {
            requestPermissionForAlias(NOTIFICATIONS, call, "onReliabilityNotification");
            return;
        }
        call.resolve(new JSObject().put("backgroundPermission", hasBackgroundPermission())
                .put("notificationPermission", hasNotificationPermission()));
    }

    @PermissionCallback
    private void onReliabilityNotification(PluginCall call) {
        call.resolve(new JSObject().put("backgroundPermission", hasBackgroundPermission())
                .put("notificationPermission", hasNotificationPermission()));
    }

    /**
     * Start tracking one shift.
     *
     * Idempotent: `startForegroundService` on an already-running service just re-delivers the
     * intent, so the web side may call this on every state change without tracking what it has
     * already asked for. It states what should be true; this makes it true.
     */
    @PluginMethod
    public void start(PluginCall call) {
        String shiftId = call.getString("shiftId");
        if (shiftId == null || shiftId.trim().isEmpty()) {
            call.reject("shiftId is required");
            return;
        }
        if (!hasLocationPermission()) {
            // `call` is saved by the helper and handed back to the callback below, so the driver
            // sees one system dialog and tracking begins the moment he accepts.
            requestPermissionForAlias(LOCATION, call, "onLocationPermission");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void onLocationPermission(PluginCall call) {
        if (!hasLocationPermission()) {
            // A denied or approximate-only grant cannot start precise tracking.
            call.resolve(new JSObject().put("started", false).put("reason", "permission_denied"));
            return;
        }
        startService(call);
    }

    private void startService(PluginCall call) {
        String shiftId = call.getString("shiftId");
        if (shiftId == null || shiftId.trim().isEmpty()) {
            call.reject("shiftId is required");
            return;
        }
        Intent intent = new Intent(getContext(), TrackerService.class);
        intent.putExtra(TrackerService.EXTRA_SHIFT_ID, shiftId);
        // The origin the WebView is on, so the service posts to the same host whose cookie it is
        // about to send. Passed in rather than hardcoded: staging and production differ.
        String origin = call.getString("origin");
        intent.putExtra(TrackerService.EXTRA_ORIGIN, origin != null ? origin : getBridge().getServerUrl());
        intent.putExtra(TrackerService.EXTRA_PROVISIONAL, Boolean.TRUE.equals(call.getBoolean("provisional")));
        if (!locationEnabled(getContext())) {
            call.resolve(new JSObject().put("started", false).put("reason", "location_disabled"));
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(intent);
            else getContext().startService(intent);
        } catch (Exception denied) {
            call.resolve(new JSObject().put("started", false).put("reason", "service_start_failed"));
            return;
        }
        GpsUploadWorker.schedule(getContext());
        // startForegroundService returns before onStartCommand. Observe the actual service outcome.
        probeHandler.postDelayed(() -> {
            boolean running = TrackerService.serviceRunning && shiftId.equals(TrackerService.activeShiftId);
            JSObject result = new JSObject().put("started", running);
            if (!running) result.put("reason", "service_start_failed");
            call.resolve(result);
            if (running) {
                boolean batteryStepDone = batteryStepDone();
                maybeRequestBatteryExemption();
                if (batteryStepDone) maybeGuideAutostart();
            }
        }, 750L);
    }

    /** Stop tracking. Also happens on its own when the server answers 409 — see TrackerService. */
    @PluginMethod
    public void stop(PluginCall call) {
        getContext().getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE).edit()
                .remove(TrackerService.KEY_SHIFT_ID).remove(TrackerService.KEY_ORIGIN)
                .remove(TrackerService.KEY_PROVISIONAL_SHIFT_ID)
                .remove(TrackerService.KEY_PROVISIONAL_STARTED_AT_MS).apply();
        getContext().stopService(new Intent(getContext(), TrackerService.class));
        // The service may already be dead when the WebView sees the closed shift. Clear its
        // separate reminder in that case too; the ongoing foreground notice is OS-managed.
        android.app.NotificationManager notifications = (android.app.NotificationManager)
                getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (notifications != null) notifications.cancel(TrackerService.ALERT_NOTIFICATION_ID);
        GpsUploadWorker.schedule(getContext());
        call.resolve();
    }

    /**
     * Whether a native capture layer exists at all.
     *
     * The web beacon reads this to stand down: two layers writing the same shift would double the
     * battery cost of a ride and produce duplicate route points.
     */
    @PluginMethod
    public void status(PluginCall call) {
        GpsFixStore store = new GpsFixStore(getContext());
        try {
            JSONObject queue = new JSONObject();
            boolean queueAvailable = true;
            try {
                store.fillMissingOrigin(getBridge().getServerUrl());
                store.prune();
                queue = store.diagnostics();
            } catch (Exception storageError) {
                queueAvailable = false;
            }
            android.content.SharedPreferences prefs = getContext().getSharedPreferences(
                    TrackerService.PREFS, Context.MODE_PRIVATE);
            String activeShiftId = TrackerService.activeShiftId;
            String captureKey = activeShiftId == null ? "lastCapturedAtMs" : "lastCapturedAtMs:" + activeShiftId;
            String uploadKey = activeShiftId == null ? "lastUploadedAtMs" : "lastUploadedAtMs:" + activeShiftId;
            long lastCapture = prefs.getLong(captureKey, 0);
            long lastStorageFailure = activeShiftId == null ? 0 :
                    prefs.getLong("lastStorageFailureAtMs:" + activeShiftId, 0);
            String lastFailure = !queueAvailable ? "sqlite_unavailable" :
                    lastStorageFailure > lastCapture ? "sqlite_write_failed" :
                    queue.optString("lastFailureReason", "");
            JSObject result = new JSObject()
                    .put("available", true)
                    .put("platform", "android")
                    .put("nativeVersionCode", appBuild(getContext()))
                    .put("permission", hasLocationPermission())
                    .put("permissionState", permissionLabel(getContext()))
                    .put("backgroundPermission", hasBackgroundPermission())
                    .put("notificationPermission", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasNotificationPermission())
                    .put("locationEnabled", locationEnabled(getContext()))
                    .put("network", GpsUploader.networkLabel(getContext()))
                    .put("serviceRunning", TrackerService.serviceRunning)
                    .put("activeShiftId", activeShiftId == null ? JSONObject.NULL : activeShiftId)
                    .put("lastCapturedAtMs", nullablePositive(prefs.getLong(captureKey, 0)))
                    .put("lastUploadedAtMs", nullablePositive(prefs.getLong(uploadKey, 0)))
                    .put("queueAvailable", queueAvailable)
                    .put("pendingCount", queueAvailable ? queue.optInt("pendingCount", 0) : JSONObject.NULL)
                    .put("rejectedCount", queue.optInt("rejectedCount", 0))
                    .put("rejectionReasons", queue.optJSONObject("rejectionReasons") == null
                            ? new JSONObject() : queue.optJSONObject("rejectionReasons"))
                    .put("droppedExpired", queue.optInt("event_expired", 0))
                    .put("droppedCapacity", queue.optInt("event_capacity", 0))
                    .put("storageFailedCount", prefs.getInt(activeShiftId == null ? "storageFailedCount" :
                            "storageFailedCount:" + activeShiftId, 0))
                    .put("lastFailureReason", lastFailure);
            GpsUploadWorker.schedule(getContext());
            call.resolve(result);
        } finally { store.close(); }
    }

    private static Object nullablePositive(long value) { return value > 0 ? value : JSONObject.NULL; }

    /** A fresh login should retry retained fixes immediately, including from completed shifts. */
    @PluginMethod
    public void retryUploads(PluginCall call) {
        GpsUploadWorker.kickNow(getContext());
        call.resolve();
    }

    static int appBuild(Context context) {
        try {
            android.content.pm.PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return (int) info.getLongVersionCode();
            return info.versionCode;
        } catch (Exception error) { return 0; }
    }

    static String permissionLabel(Context context) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED)
            return "precise";
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED)
            return "approximate";
        return "denied";
    }

    static boolean locationEnabled(Context context) {
        LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return manager.isLocationEnabled();
        return manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasBackgroundPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true;
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean askedBackground() {
        return getContext().getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE)
                .getBoolean("askedBackground", false);
    }

    private void markAskedBackground() {
        getContext().getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean("askedBackground", true).apply();
    }

    /**
     * Ask ONCE for exemption from battery optimisation.
     *
     * This is the single biggest reason a foreground service is killed in the field: OEM power
     * managers (MIUI, ColorOS, EMUI, One UI) stop even a foreground service unless the app is
     * whitelisted. The system dialog is shown once per install and only when not already exempt; if
     * the driver declines we do not nag him every shift. Fired after the service starts, so tracking
     * is never delayed waiting on it.
     */
    private void maybeRequestBatteryExemption() {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        String pkg = getContext().getPackageName();
        if (pm != null && pm.isIgnoringBatteryOptimizations(pkg)) return;
        SharedPreferences prefs = getContext().getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean("askedBattery", false)) return;
        prefs.edit().putBoolean("askedBattery", true).apply();
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + pkg));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (Exception ignored) {
            // No activity to handle it (rare). The service still runs; it is just more killable.
        }
    }

    /** True once the battery-optimisation step has happened (asked, or already exempt). */
    private boolean batteryStepDone() {
        SharedPreferences prefs = getContext().getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean("askedBattery", false)) return true;
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    /**
     * Send the driver, ONCE, to his OEM's «autostart» screen so he can allow-list the app.
     *
     * The last background-reliability gap that cannot be closed in code: MIUI, ColorOS, EMUI,
     * FuntouchOS and One UI block BOOT_COMPLETED and force-stop apps that are not on their own
     * autostart / «don't kill» list — a switch only the user can flip, buried in the OEM security
     * centre. Stock Android has no such screen, so this fires only on those makers, best-effort: it
     * tries the known component for the device and falls back to the app's own settings page, always
     * showing a one-line Arabic reason first so the driver knows why he is there.
     */
    private void maybeGuideAutostart() {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
        List<Intent> candidates = autostartCandidates(maker);
        if (candidates.isEmpty()) return; // stock Android or an unknown maker: nothing to open
        SharedPreferences prefs = getContext().getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean("askedAutostart", false)) return;
        prefs.edit().putBoolean("askedAutostart", true).apply();

        // Last resort: the app's own settings page, where every OEM buries these controls somewhere.
        Intent details = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        details.setData(Uri.parse("package:" + getContext().getPackageName()));
        candidates.add(details);

        for (Intent candidate : candidates) {
            try {
                if (getContext().getPackageManager().resolveActivity(candidate, 0) != null) {
                    showAutostartHint();
                    candidate.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(candidate);
                    return;
                }
            } catch (Exception unavailable) {
                // Try the next candidate; a component that does not exist on this build just fails.
            }
        }
    }

    private void showAutostartHint() {
        try {
            if (getActivity() != null) {
                getActivity().runOnUiThread(() ->
                        Toast.makeText(getContext(), getContext().getString(R.string.tracking_autostart_hint), Toast.LENGTH_LONG).show());
            }
        } catch (Exception ignored) {
            // A missing UI thread just means no toast; the settings screen still opens.
        }
    }

    private static Intent componentIntent(String pkg, String cls) {
        Intent intent = new Intent();
        intent.setComponent(new ComponentName(pkg, cls));
        return intent;
    }

    /** The known «autostart / don't-kill» screens per OEM. Empty for stock Android. */
    private List<Intent> autostartCandidates(String maker) {
        List<Intent> list = new ArrayList<>();
        if (maker.contains("xiaomi") || maker.contains("redmi") || maker.contains("poco")) {
            list.add(componentIntent("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"));
        } else if (maker.contains("oppo") || maker.contains("realme")) {
            list.add(componentIntent("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"));
            list.add(componentIntent("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"));
            list.add(componentIntent("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"));
        } else if (maker.contains("vivo") || maker.contains("iqoo")) {
            list.add(componentIntent("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"));
            list.add(componentIntent("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"));
        } else if (maker.contains("huawei") || maker.contains("honor")) {
            list.add(componentIntent("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"));
            list.add(componentIntent("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"));
        } else if (maker.contains("oneplus")) {
            list.add(componentIntent("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"));
        } else if (maker.contains("samsung")) {
            list.add(componentIntent("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"));
            list.add(componentIntent("com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity"));
        } else if (maker.contains("letv")) {
            list.add(componentIntent("com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity"));
        } else if (maker.contains("asus")) {
            list.add(componentIntent("com.asus.mobilemanager", "com.asus.mobilemanager.MainActivity"));
        } else if (maker.contains("meizu")) {
            list.add(componentIntent("com.meizu.safe", "com.meizu.safe.security.SHOW_APPSEC"));
        }
        return list;
    }
}
