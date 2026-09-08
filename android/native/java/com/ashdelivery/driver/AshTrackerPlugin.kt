package com.ashdelivery.driver

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission

/**
 * The only bridge between the web app and the tracker.
 *
 * Deliberately three methods and no data path. Fixes never travel through JavaScript — the service
 * uploads them itself, because a plugin that hands positions to a callback is only as alive as the
 * WebView, and the WebView being asleep is the entire problem this app exists to solve.
 *
 * So the web side's whole job is to say which shift is live. It already knows: `Shift.tsx` polls
 * the server every twenty seconds and holds `serverState`.
 */
@CapacitorPlugin(
    name = "AshTracker",
    permissions = [
        Permission(
            alias = "location",
            strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION],
        ),
        // Android 13+ refuses to show the foreground-service notification without this, and a
        // location service the driver cannot see is one he never agreed to.
        Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]),
    ],
)
class AshTrackerPlugin : Plugin() {

    /**
     * Start tracking one shift.
     *
     * Idempotent: `startForegroundService` on an already-running service just re-delivers the
     * intent, so the web side may call this on every poll tick without thinking about it. That is
     * the property that makes the JS side simple — it states what should be true rather than
     * tracking what it has already done.
     */
    @PluginMethod
    fun start(call: PluginCall) {
        val shiftId = call.getString("shiftId")
        if (shiftId.isNullOrBlank()) {
            call.reject("shiftId is required")
            return
        }
        if (!hasLocationPermission()) {
            // Not an error the driver should see mid-ride. The web beacon keeps working while he is
            // looking at the app, and the manager simply does not get a pin while the screen is off.
            call.resolve(JSObject().put("started", false).put("reason", "permission"))
            return
        }
        val intent = Intent(context, TrackerService::class.java).apply {
            putExtra(TrackerService.EXTRA_SHIFT_ID, shiftId)
            // The origin the WebView is on, so the service posts to the same host whose cookie it
            // is about to send. Passed in rather than hardcoded: staging and production differ.
            putExtra(TrackerService.EXTRA_ORIGIN, call.getString("origin") ?: bridge.serverUrl)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
        call.resolve(JSObject().put("started", true))
    }

    /** Stop tracking. Also happens on its own when the server answers 409 — see `TrackerService`. */
    @PluginMethod
    fun stop(call: PluginCall) {
        context.stopService(Intent(context, TrackerService::class.java))
        call.resolve()
    }

    /**
     * Whether a native capture layer exists at all.
     *
     * The web beacon reads this to stand down: two layers writing the same shift would double the
     * battery cost to produce rows the server then dedupes on `(shift_id, captured_at)` anyway.
     */
    @PluginMethod
    fun status(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("available", true)
                .put("permission", hasLocationPermission()),
        )
    }

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
}
