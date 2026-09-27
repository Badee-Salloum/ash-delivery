package com.ashdelivery.driver;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Durable, bounded queue. A server receipt is the only normal reason to delete a fix. */
final class GpsFixStore extends SQLiteOpenHelper {
    private static final String DB_NAME = "ash_gps_fixes.db";
    private static final int VERSION = 2;
    static final int MAX_ROWS = 60_000;
    static final long MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000;
    private final Context context;

    static final class Fix {
        final long id;
        final String pointId;
        final JSONObject json;
        final String shiftId;
        final String origin;
        Fix(long id, String pointId, JSONObject json, String shiftId, String origin) {
            this.id = id;
            this.pointId = pointId;
            this.json = json;
            this.shiftId = shiftId;
            this.origin = origin;
        }
    }

    static final class Assignment {
        final String shiftId;
        final String origin;
        Assignment(String shiftId, String origin) {
            this.shiftId = shiftId;
            this.origin = origin;
        }
    }

    GpsFixStore(Context context) {
        super(context.getApplicationContext(), DB_NAME, null, VERSION);
        this.context = context.getApplicationContext();
    }

    /** The bundled Capacitor URL also works before any shift has started after an upgrade. */
    static String configuredOrigin(Context context) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                context.getAssets().open("capacitor.config.json"), "UTF-8"))) {
            StringBuilder json = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) json.append(line);
            String url = new JSONObject(json.toString()).getJSONObject("server").getString("url");
            if (!url.startsWith("https://")) return "";
            while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
            return url;
        } catch (Exception unavailable) { return ""; }
    }

    private static void createSchema(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE gps_fixes (" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT, point_id TEXT NOT NULL UNIQUE, " +
                "shift_id TEXT NOT NULL, origin TEXT NOT NULL, captured_at_ms INTEGER NOT NULL, " +
                "lat REAL NOT NULL, lng REAL NOT NULL, accuracy_m REAL, rejected_reason TEXT)");
        db.execSQL("CREATE INDEX gps_fixes_pending_idx ON gps_fixes (shift_id, rejected_reason, captured_at_ms, id)");
        db.execSQL("CREATE INDEX gps_fixes_age_idx ON gps_fixes (captured_at_ms, id)");
        db.execSQL("CREATE TABLE gps_queue_events (id INTEGER PRIMARY KEY AUTOINCREMENT, " +
                "occurred_at_ms INTEGER NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, detail TEXT)");
        db.execSQL("CREATE INDEX gps_queue_events_time_idx ON gps_queue_events (occurred_at_ms)");
        db.execSQL("CREATE TABLE gps_shift_stats (shift_id TEXT PRIMARY KEY, origin TEXT NOT NULL DEFAULT '', " +
                "dropped_expired INTEGER NOT NULL DEFAULT 0, dropped_capacity INTEGER NOT NULL DEFAULT 0, " +
                "needs_report INTEGER NOT NULL DEFAULT 0, report_version INTEGER NOT NULL DEFAULT 0)");
    }

    @Override public void onCreate(SQLiteDatabase db) { createSchema(db); }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion != 1 || newVersion != VERSION) throw new IllegalStateException("Unknown GPS queue migration");
        // Rebuild the v1 unique timestamp table. Preserve all fixes, assigning stable IDs once.
        db.execSQL("ALTER TABLE gps_fixes RENAME TO gps_fixes_v1");
        db.execSQL("DROP INDEX IF EXISTS gps_fixes_shift_capture_idx");
        createSchema(db);
        String origin = context.getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE)
                .getString(TrackerService.KEY_ORIGIN, "");
        if (origin == null || origin.isEmpty()) origin = configuredOrigin(context);
        if (origin == null) origin = "";
        try (Cursor rows = db.query("gps_fixes_v1",
                new String[]{"shift_id", "captured_at_ms", "lat", "lng", "accuracy_m"},
                null, null, null, null, "id ASC")) {
            while (rows.moveToNext()) {
                ContentValues v = new ContentValues();
                v.put("point_id", UUID.randomUUID().toString());
                v.put("shift_id", rows.getString(0));
                v.put("captured_at_ms", rows.getLong(1));
                v.put("lat", rows.getDouble(2));
                v.put("lng", rows.getDouble(3));
                if (rows.isNull(4)) v.putNull("accuracy_m"); else v.put("accuracy_m", rows.getDouble(4));
                v.put("origin", origin);
                db.insertOrThrow("gps_fixes", null, v);
            }
        }
        db.execSQL("DROP TABLE gps_fixes_v1");
    }

    void fillMissingOrigin(String origin) {
        if (origin == null || origin.isEmpty()) return;
        while (origin.endsWith("/")) origin = origin.substring(0, origin.length() - 1);
        ContentValues values = new ContentValues();
        values.put("origin", origin);
        getWritableDatabase().update("gps_fixes", values, "origin = ''", null);
        getWritableDatabase().update("gps_shift_stats", values, "origin = ''", null);
    }

    void enqueue(String shiftId, String origin, double lat, double lng, Float accuracyM, long capturedAtMs) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ContentValues v = new ContentValues();
            v.put("point_id", UUID.randomUUID().toString());
            v.put("shift_id", shiftId);
            v.put("origin", origin);
            v.put("captured_at_ms", capturedAtMs);
            v.put("lat", lat);
            v.put("lng", lng);
            if (accuracyM == null) v.putNull("accuracy_m"); else v.put("accuracy_m", accuracyM);
            db.insertOrThrow("gps_fixes", null, v);
            pruneWithin(db, System.currentTimeMillis());
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    void prune() {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try { pruneWithin(db, System.currentTimeMillis()); db.setTransactionSuccessful(); }
        finally { db.endTransaction(); }
    }

    private static void pruneWithin(SQLiteDatabase db, long nowMs) {
        String cutoff = Long.toString(nowMs - MAX_AGE_MS);
        recordDroppedByShift(db, "captured_at_ms < ?", new String[]{cutoff}, "dropped_expired");
        int expired = db.delete("gps_fixes", "captured_at_ms < ?", new String[]{cutoff});
        event(db, nowMs, "expired", expired, null);
        long excess = Math.max(0, DatabaseUtils.queryNumEntries(db, "gps_fixes") - MAX_ROWS);
        if (excess > 0) {
            String oldest = "id IN (SELECT id FROM gps_fixes ORDER BY captured_at_ms ASC, id ASC LIMIT " + excess + ")";
            recordDroppedByShift(db, oldest, null, "dropped_capacity");
            db.execSQL("DELETE FROM gps_fixes WHERE id IN (SELECT id FROM gps_fixes " +
                    "ORDER BY captured_at_ms ASC, id ASC LIMIT ?)", new Object[]{excess});
            event(db, nowMs, "capacity", (int) excess, null);
        }
        db.delete("gps_queue_events", "occurred_at_ms < ?", new String[]{Long.toString(nowMs - 30L * 24 * 60 * 60 * 1000)});
    }

    private static void recordDroppedByShift(SQLiteDatabase db, String where, String[] args, String column) {
        try (Cursor rows = db.rawQuery("SELECT shift_id, origin, COUNT(*) FROM gps_fixes WHERE " + where +
                " GROUP BY shift_id, origin", args)) {
            while (rows.moveToNext()) {
                markReportNeeded(db, rows.getString(0), rows.getString(1));
                db.execSQL("UPDATE gps_shift_stats SET " + column + " = " + column + " + ? WHERE shift_id = ?",
                        new Object[]{rows.getInt(2), rows.getString(0)});
            }
        }
    }

    private static void markReportNeeded(SQLiteDatabase db, String shiftId, String origin) {
        ContentValues key = new ContentValues();
        key.put("shift_id", shiftId);
        key.put("origin", origin);
        db.insertWithOnConflict("gps_shift_stats", null, key, SQLiteDatabase.CONFLICT_IGNORE);
        db.execSQL("UPDATE gps_shift_stats SET origin = ?, needs_report = 1, " +
                "report_version = report_version + 1 WHERE shift_id = ?", new Object[]{origin, shiftId});
    }

    int reportVersion(String shiftId) {
        try (Cursor row = getReadableDatabase().query("gps_shift_stats", new String[]{"report_version"},
                "shift_id = ?", new String[]{shiftId}, null, null, null)) {
            return row.moveToFirst() ? row.getInt(0) : 0;
        }
    }

    void markReported(String shiftId, int version) {
        getWritableDatabase().execSQL("UPDATE gps_shift_stats SET needs_report = 0 " +
                "WHERE shift_id = ? AND report_version = ?", new Object[]{shiftId, version});
    }

    private static void event(SQLiteDatabase db, long now, String kind, int count, String detail) {
        if (count <= 0) return;
        // Aggregate by UTC day/reason: a week offline must not create one diagnostic row per fix.
        long dayStart = now - now % (24L * 60 * 60 * 1000);
        String where = detail == null
                ? "kind = ? AND detail IS NULL AND occurred_at_ms >= ?"
                : "kind = ? AND detail = ? AND occurred_at_ms >= ?";
        String[] args = detail == null
                ? new String[]{kind, Long.toString(dayStart)}
                : new String[]{kind, detail, Long.toString(dayStart)};
        try (Cursor rows = db.query("gps_queue_events", new String[]{"id", "count"}, where, args,
                null, null, "id DESC", "1")) {
            if (rows.moveToFirst()) {
                ContentValues update = new ContentValues();
                update.put("count", rows.getInt(1) + count);
                update.put("occurred_at_ms", now);
                db.update("gps_queue_events", update, "id = ?", new String[]{Long.toString(rows.getLong(0))});
                return;
            }
        }
        ContentValues v = new ContentValues();
        v.put("occurred_at_ms", now);
        v.put("kind", kind);
        v.put("count", count);
        v.put("detail", detail);
        db.insertOrThrow("gps_queue_events", null, v);
    }

    void recordFailure(String reason) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try { event(db, System.currentTimeMillis(), "failure", 1, reason); db.setTransactionSuccessful(); }
        finally { db.endTransaction(); }
    }

    void recordUploadSuccess() {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try { event(db, System.currentTimeMillis(), "upload_success", 1, null); db.setTransactionSuccessful(); }
        finally { db.endTransaction(); }
    }

    List<Assignment> pendingAssignments() {
        List<Assignment> result = new ArrayList<>();
        try (Cursor rows = getReadableDatabase().rawQuery(
                "SELECT shift_id, origin FROM gps_fixes WHERE rejected_reason IS NULL AND origin <> '' " +
                        "GROUP BY shift_id, origin UNION SELECT shift_id, origin FROM gps_shift_stats " +
                        "WHERE needs_report = 1 AND origin <> ''", null)) {
            while (rows.moveToNext()) result.add(new Assignment(rows.getString(0), rows.getString(1)));
        }
        return result;
    }

    List<Fix> batch(String shiftId, String origin, int limit) {
        List<Fix> result = new ArrayList<>();
        try (Cursor rows = getReadableDatabase().query("gps_fixes",
                new String[]{"id", "point_id", "lat", "lng", "accuracy_m", "captured_at_ms"},
                "shift_id = ? AND origin = ? AND rejected_reason IS NULL", new String[]{shiftId, origin},
                null, null, "captured_at_ms ASC, id ASC", Integer.toString(limit))) {
            while (rows.moveToNext()) {
                JSONObject json = new JSONObject();
                try {
                    json.put("pointId", rows.getString(1));
                    json.put("lat", rows.getDouble(2));
                    json.put("lng", rows.getDouble(3));
                    json.put("accuracyM", rows.isNull(4) ? JSONObject.NULL : rows.getDouble(4));
                    json.put("capturedAtMs", rows.getLong(5));
                } catch (Exception malformed) {
                    throw new IllegalStateException("Could not encode a queued GPS fix", malformed);
                }
                result.add(new Fix(rows.getLong(0), rows.getString(1), json, shiftId, origin));
            }
        }
        return result;
    }

    void acknowledge(List<Fix> sent, List<String> acceptedIds, Map<String, String> rejected) {
        if (sent.isEmpty()) return;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            boolean changed = false;
            for (Fix fix : sent) {
                if (acceptedIds.contains(fix.pointId)) {
                    changed |= db.delete("gps_fixes", "id = ? AND point_id = ?", new String[]{Long.toString(fix.id), fix.pointId}) > 0;
                } else if (rejected.containsKey(fix.pointId)) {
                    ContentValues v = new ContentValues();
                    v.put("rejected_reason", rejected.get(fix.pointId));
                    int updated = db.update("gps_fixes", v, "id = ? AND rejected_reason IS NULL",
                            new String[]{Long.toString(fix.id)});
                    event(db, System.currentTimeMillis(), "rejected", updated, rejected.get(fix.pointId));
                    if (updated > 0) changed = true;
                }
            }
            if (changed) markReportNeeded(db, sent.get(0).shiftId, sent.get(0).origin);
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    JSONObject diagnostics() {
        JSONObject out = new JSONObject();
        SQLiteDatabase db = getReadableDatabase();
        try {
            try (Cursor c = db.rawQuery("SELECT COUNT(*), SUM(CASE WHEN rejected_reason IS NOT NULL THEN 1 ELSE 0 END), MAX(captured_at_ms) FROM gps_fixes", null)) {
                if (c.moveToFirst()) {
                    out.put("pendingCount", c.getInt(0) - c.getInt(1));
                    out.put("rejectedCount", c.getInt(1));
                    out.put("lastQueuedCapturedAtMs", c.isNull(2) ? JSONObject.NULL : c.getLong(2));
                }
            }
            try (Cursor c = db.rawQuery("SELECT kind, COALESCE(SUM(count),0) FROM gps_queue_events GROUP BY kind", null)) {
                while (c.moveToNext()) out.put("event_" + c.getString(0), c.getInt(1));
            }
            JSONObject reasons = new JSONObject();
            try (Cursor c = db.rawQuery("SELECT rejected_reason, COUNT(*) FROM gps_fixes " +
                    "WHERE rejected_reason IS NOT NULL GROUP BY rejected_reason", null)) {
                while (c.moveToNext()) reasons.put(c.getString(0), c.getInt(1));
            }
            out.put("rejectionReasons", reasons);
            try (Cursor c = db.rawQuery("SELECT kind, detail FROM gps_queue_events " +
                    "WHERE kind IN ('failure', 'rejected', 'upload_success') " +
                    "ORDER BY occurred_at_ms DESC, id DESC LIMIT 1", null)) {
                if (c.moveToFirst() && !"upload_success".equals(c.getString(0))) {
                    out.put("lastFailureReason", c.getString(1));
                }
            }
        } catch (Exception invalid) { throw new IllegalStateException("Queue diagnostics failed", invalid); }
        return out;
    }

    JSONObject diagnosticsForShift(String shiftId) {
        JSONObject out = new JSONObject();
        SQLiteDatabase db = getReadableDatabase();
        try {
            try (Cursor c = db.rawQuery("SELECT COUNT(*), SUM(CASE WHEN rejected_reason IS NOT NULL THEN 1 ELSE 0 END) " +
                    "FROM gps_fixes WHERE shift_id = ?", new String[]{shiftId})) {
                if (c.moveToFirst()) {
                    out.put("pendingCount", c.getInt(0) - c.getInt(1));
                    out.put("rejectedCount", c.getInt(1));
                }
            }
            JSONObject reasons = new JSONObject();
            try (Cursor c = db.rawQuery("SELECT rejected_reason, COUNT(*) FROM gps_fixes " +
                    "WHERE shift_id = ? AND rejected_reason IS NOT NULL GROUP BY rejected_reason", new String[]{shiftId})) {
                while (c.moveToNext()) reasons.put(c.getString(0), c.getInt(1));
            }
            out.put("rejectionReasons", reasons);
            try (Cursor c = db.query("gps_shift_stats", new String[]{"dropped_expired", "dropped_capacity"},
                    "shift_id = ?", new String[]{shiftId}, null, null, null)) {
                if (c.moveToFirst()) {
                    out.put("droppedExpired", c.getInt(0));
                    out.put("droppedCapacity", c.getInt(1));
                }
            }
        } catch (Exception invalid) { throw new IllegalStateException("Shift queue diagnostics failed", invalid); }
        return out;
    }
}
