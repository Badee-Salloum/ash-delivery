package com.ashdelivery.driver;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** On-device queue for fixes captured while the network or the service process is unavailable. */
final class GpsFixStore extends SQLiteOpenHelper {
    private static final String DB_NAME = "ash_gps_fixes.db";
    private static final int VERSION = 1;

    static final class Fix {
        final long id;
        final JSONObject json;

        Fix(long id, JSONObject json) {
            this.id = id;
            this.json = json;
        }
    }

    GpsFixStore(Context context) {
        super(context.getApplicationContext(), DB_NAME, null, VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE gps_fixes (" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
                "shift_id TEXT NOT NULL, captured_at_ms INTEGER NOT NULL, " +
                "lat REAL NOT NULL, lng REAL NOT NULL, accuracy_m REAL, " +
                "UNIQUE (shift_id, captured_at_ms))");
        db.execSQL("CREATE INDEX gps_fixes_shift_capture_idx ON gps_fixes (shift_id, captured_at_ms, id)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("No GPS queue migration for " + oldVersion + " to " + newVersion);
    }

    void enqueue(String shiftId, double lat, double lng, Float accuracyM, long capturedAtMs, int maxRows) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ContentValues values = new ContentValues();
            values.put("shift_id", shiftId);
            values.put("captured_at_ms", capturedAtMs);
            values.put("lat", lat);
            values.put("lng", lng);
            if (accuracyM == null) values.putNull("accuracy_m");
            else values.put("accuracy_m", accuracyM);
            // The server has the same natural key, so retrying after a lost 202 is harmless.
            db.insertWithOnConflict("gps_fixes", null, values, SQLiteDatabase.CONFLICT_IGNORE);
            db.execSQL("DELETE FROM gps_fixes WHERE id IN (" +
                    "SELECT id FROM gps_fixes ORDER BY captured_at_ms DESC, id DESC LIMIT -1 OFFSET " + maxRows + ")");
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    List<Fix> batch(String shiftId, int limit) {
        List<Fix> result = new ArrayList<>();
        try (Cursor rows = getReadableDatabase().query(
                "gps_fixes", new String[]{"id", "lat", "lng", "accuracy_m", "captured_at_ms"},
                "shift_id = ?", new String[]{shiftId}, null, null,
                "captured_at_ms ASC, id ASC", Integer.toString(limit))) {
            while (rows.moveToNext()) {
                JSONObject json = new JSONObject();
                try {
                    json.put("lat", rows.getDouble(1));
                    json.put("lng", rows.getDouble(2));
                    json.put("accuracyM", rows.isNull(3) ? JSONObject.NULL : rows.getDouble(3));
                    json.put("capturedAtMs", rows.getLong(4));
                } catch (Exception malformed) {
                    // Values came from typed SQLite columns; this should be unreachable. Leave the
                    // row for inspection rather than falsely acknowledging it.
                    throw new IllegalStateException("Could not encode a queued GPS fix", malformed);
                }
                result.add(new Fix(rows.getLong(0), json));
            }
        }
        return result;
    }

    void acknowledge(List<Fix> sent) {
        if (sent.isEmpty()) return;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (Fix fix : sent) db.delete("gps_fixes", "id = ?", new String[]{Long.toString(fix.id)});
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    void clearShift(String shiftId) {
        getWritableDatabase().delete("gps_fixes", "shift_id = ?", new String[]{shiftId});
    }
}
