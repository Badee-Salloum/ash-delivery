package com.ashdelivery.driver;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

/**
 * Bring tracking back after the phone reboots mid-shift.
 *
 * A foreground service does not survive a restart, so without this a driver whose phone reboots (or
 * is force-restarted by an aggressive OEM) simply stops being tracked until he next opens the app.
 * The service persists its assignment ({@link TrackerService#PREFS}); this reads it back and, if a
 * shift was live when the phone went down, starts the service again.
 *
 * It does NOT check with the server whether the shift is still live — it does not have to. If the
 * shift has since closed, the service's first flush gets the 409 stop signal, drops its buffer and
 * shuts itself down (see {@link TrackerService}). So the worst case of a stale assignment is one
 * rejected request, not a phone hammering a closed shift.
 *
 * A boot restart runs with NO visible UI, so a location foreground service can only actually get
 * fixes if the app holds `ACCESS_BACKGROUND_LOCATION` ("allow all the time"). Without it, starting
 * the service from here would show a tracking notification and drain battery while producing zero
 * fixes — worse than nothing. So on Android 10+ we start only when background location is granted;
 * otherwise we leave it, and the driver reopening the app restarts tracking with foreground
 * location while the office's "not reporting" alert covers the gap.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)) {
            return;
        }

        SharedPreferences prefs = context.getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
        String shiftId = prefs.getString(TrackerService.KEY_SHIFT_ID, null);
        String origin = prefs.getString(TrackerService.KEY_ORIGIN, null);
        if (shiftId == null || shiftId.trim().isEmpty() || origin == null || origin.trim().isEmpty()) {
            return;
        }

        // From boot the app is not visible, so only "allow all the time" location yields fixes.
        // Starting without it would be a zombie service: notification on, battery burning, no data.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                        != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        Intent service = new Intent(context, TrackerService.class);
        service.putExtra(TrackerService.EXTRA_SHIFT_ID, shiftId);
        service.putExtra(TrackerService.EXTRA_ORIGIN, origin);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
        } catch (Exception denied) {
            // Foreground-service-from-boot was refused (no background-location grant, or an OEM
            // restriction). Not fatal: reopening the app restarts tracking.
        }
    }
}
