package com.ashdelivery.driver;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.WorkManager;

import java.util.List;
import java.util.concurrent.TimeUnit;

/** Network-constrained sync that runs after service/shift/app closure and after reboot. */
public final class GpsUploadWorker extends Worker {
    private static final String ONE_TIME = "ash-gps-upload";
    private static final String PERIODIC = "ash-gps-upload-periodic";

    public GpsUploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context context) {
        enqueue(context, ExistingWorkPolicy.KEEP);
    }

    /** App reopen or successful login resets a delayed retry without touching the durable queue. */
    static void kickNow(Context context) {
        enqueue(context, ExistingWorkPolicy.REPLACE);
    }

    private static void enqueue(Context context, ExistingWorkPolicy policy) {
        Constraints network = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        WorkManager wm = WorkManager.getInstance(context.getApplicationContext());
        wm.enqueueUniqueWork(ONE_TIME, policy,
                new OneTimeWorkRequest.Builder(GpsUploadWorker.class)
                        .setConstraints(network)
                        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                        .build());
        wm.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
                new PeriodicWorkRequest.Builder(GpsUploadWorker.class, 15, TimeUnit.MINUTES)
                        .setConstraints(network)
                        .build());
    }

    @NonNull @Override
    public Result doWork() {
        Context context = getApplicationContext();
        GpsFixStore store = new GpsFixStore(context);
        try {
            store.fillMissingOrigin(GpsFixStore.configuredOrigin(context));
            store.prune();
            List<GpsFixStore.Assignment> assignments = store.pendingAssignments();
            boolean retry = false;
            for (GpsFixStore.Assignment assignment : assignments) {
                SharedPreferences prefs = context.getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
                // Foreground capture may begin while start-package is still a draft. The server
                // has no tracking window then; wait for the service's confirmed transition.
                if (assignment.shiftId.equals(prefs.getString(TrackerService.KEY_PROVISIONAL_SHIFT_ID, null))) continue;
                boolean sameActive = assignment.shiftId.equals(prefs.getString(TrackerService.KEY_SHIFT_ID, null));
                String serviceState = TrackerService.serviceRunning &&
                        assignment.shiftId.equals(TrackerService.activeShiftId) ? "running" :
                        sameActive ? "unknown" : "stopped";
                GpsUploader.sendDiagnostics(context, store, assignment.shiftId, assignment.origin, serviceState);
                // Bound each invocation. WorkManager can stop a worker that runs too long; the
                // remaining points will be retried without losing their original capture time.
                for (int batch = 0; batch < 5; batch++) {
                    GpsUploader.Outcome outcome = GpsUploader.flushOnce(
                            context, store, assignment.shiftId, assignment.origin);
                    if (outcome == GpsUploader.Outcome.COMPLETE) break;
                    if (outcome == GpsUploader.Outcome.PARTIAL) continue;
                    retry = true;
                    break;
                }
                // Report the new queue size and upload time even if this was the final batch.
                int reportVersion = store.reportVersion(assignment.shiftId);
                if (GpsUploader.sendDiagnostics(context, store, assignment.shiftId, assignment.origin, serviceState)) {
                    store.markReported(assignment.shiftId, reportVersion);
                }
            }
            // An exclusively provisional queue is intentionally held, not a failed upload.
            SharedPreferences prefs = context.getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
            String provisionalId = prefs.getString(TrackerService.KEY_PROVISIONAL_SHIFT_ID, null);
            for (GpsFixStore.Assignment assignment : store.pendingAssignments()) {
                if (!assignment.shiftId.equals(provisionalId)) { retry = true; break; }
            }
            return retry ? Result.retry() : Result.success();
        } catch (Exception error) {
            store.recordFailure("worker_error");
            return Result.retry();
        } finally { store.close(); }
    }
}
