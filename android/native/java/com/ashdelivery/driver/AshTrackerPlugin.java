package com.ashdelivery.driver;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The only bridge between the web app and the tracker.
 *
 * Deliberately three methods and no data path. Fixes never travel through JavaScript — the service
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
        afterForeground(call);
    }

    @PermissionCallback
    private void onLocationPermission(PluginCall call) {
        if (!hasLocationPermission()) {
            /*
             * He said no. Not an error, and not something to interrupt a man on a motorbike about:
             * the shift itself is unaffected and he keeps working. The manager simply gets no pin,
             * and the coverage figure on the finished shift is where that shows up honestly —
             * measured from the server rather than taken from anyone's account of his own phone.
             */
            call.resolve(new JSObject().put("started", false).put("reason", "permission_denied"));
            return;
        }
        afterForeground(call);
    }

    /**
     * Between foreground location and launching, ask ONCE for «allow all the time».
     *
     * This is only so tracking can come back on its own after a reboot (BootReceiver). It is
     * best-effort and never gates the service: tracking proceeds whether or not it is granted,
     * because the foreground service runs on in-use location while the app has been opened. Asked at
     * most once per install so a decline does not turn into a prompt every shift.
     */
    private void afterForeground(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasBackgroundPermission() && !askedBackground()) {
            markAskedBackground();
            requestPermissionForAlias(BACKGROUND, call, "onBackgroundPermission");
            return;
        }
        launch(call);
    }

    @PermissionCallback
    private void onBackgroundPermission(PluginCall call) {
        // Granted or not, tracking proceeds; background only helps the post-reboot restart.
        launch(call);
    }

    private void launch(PluginCall call) {
        // Asked for separately and never gated on: without it the service still runs, it is only
        // the driver's notice that goes missing — so a refusal must not stop the tracking.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotificationPermission()) {
            requestPermissionForAlias(NOTIFICATIONS, call, "onNotificationPermission");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void onNotificationPermission(PluginCall call) {
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        maybeRequestBatteryExemption();
        call.resolve(new JSObject().put("started", true));
    }

    /** Stop tracking. Also happens on its own when the server answers 409 — see TrackerService. */
    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), TrackerService.class));
        call.resolve();
    }

    /**
     * Whether a native capture layer exists at all.
     *
     * The web beacon reads this to stand down: two layers writing the same shift would double the
     * battery cost of a ride to produce rows the server then discards on `(shift_id, captured_at)`.
     */
    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(new JSObject()
                .put("available", true)
                .put("permission", hasLocationPermission()));
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotificationPermission() {
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
}
