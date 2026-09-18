package com.ashdelivery.driver;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

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
                )
        }
)
public class AshTrackerPlugin extends Plugin {

    static final String LOCATION = "location";
    static final String NOTIFICATIONS = "notifications";

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
        launch(call);
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
}
