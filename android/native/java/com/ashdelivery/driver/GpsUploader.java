package com.ashdelivery.driver;

import android.content.Context;
import android.content.SharedPreferences;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Uploads one persisted batch. Never infers that a whole batch succeeded from an HTTP code. */
final class GpsUploader {
    enum Outcome { COMPLETE, PARTIAL, RETRY, SHIFT_OVER, AUTH_REQUIRED }
    static final int BATCH_SIZE = 500;
    private GpsUploader() {}

    static Outcome flushOnce(Context context, GpsFixStore store, String shiftId, String origin) {
        List<GpsFixStore.Fix> sending = store.batch(shiftId, origin, BATCH_SIZE);
        if (sending.isEmpty()) return Outcome.COMPLETE;
        if ("offline".equals(networkLabel(context))) return Outcome.RETRY;
        JSONObject body = new JSONObject();
        try {
            body.put("source", "phone_bg");
            JSONArray fixes = new JSONArray();
            for (GpsFixStore.Fix fix : sending) fixes.put(fix.json);
            body.put("fixes", fixes);
        } catch (Exception error) {
            store.recordFailure("encode_error");
            return Outcome.RETRY;
        }

        String url = origin + "/api/shifts/" + shiftId + "/gps";
        HttpURLConnection connection = null;
        try {
            connection = open(url, "POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json");
            try (OutputStreamWriter out = new OutputStreamWriter(connection.getOutputStream(), "UTF-8")) {
                out.write(body.toString());
            }
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) {
                store.recordFailure("session_required");
                return Outcome.AUTH_REQUIRED;
            }
            if (status == 409) {
                store.recordFailure("shift_not_live");
                return Outcome.SHIFT_OVER;
            }
            if (status < 200 || status >= 300) {
                store.recordFailure("http_" + status);
                return Outcome.RETRY;
            }
            writeBackCookies(url, connection);
            JSONObject response = new JSONObject(readBody(connection));
            JSONArray results = response.optJSONArray("results");
            if (results == null) {
                // A legacy 202 with aggregate counts proves nothing about individual points.
                store.recordFailure("missing_point_receipts");
                return Outcome.RETRY;
            }
            List<String> accepted = new ArrayList<>();
            Map<String, String> rejected = new HashMap<>();
            for (int i = 0; i < results.length(); i++) {
                JSONObject item = results.optJSONObject(i);
                if (item == null) continue;
                String pointId = item.optString("pointId", "");
                String receipt = item.optString("status", "");
                if ("stored".equals(receipt) || "duplicate".equals(receipt)) accepted.add(pointId);
                else if ("rejected".equals(receipt)) rejected.put(pointId, item.optString("reason", "unspecified"));
            }
            store.acknowledge(sending, accepted, rejected);
            if (!accepted.isEmpty()) {
                store.recordUploadSuccess();
                long uploadedAtMs = System.currentTimeMillis();
                context.getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE)
                        .edit().putLong("lastUploadedAtMs", uploadedAtMs)
                        .putLong("lastUploadedAtMs:" + shiftId, uploadedAtMs).apply();
            }
            if (accepted.size() + rejected.size() < sending.size()) {
                store.recordFailure("incomplete_point_receipts");
                return Outcome.RETRY;
            }
            return Outcome.PARTIAL;
        } catch (Exception offline) {
            store.recordFailure(networkFailureReason(offline));
            return Outcome.RETRY;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    static boolean isShiftLive(Context context, String shiftId, String origin) {
        if ("offline".equals(networkLabel(context))) return true;
        HttpURLConnection connection = null;
        String url = origin + "/api/shifts/" + shiftId + "/gps/status";
        try {
            connection = open(url, "GET");
            int code = connection.getResponseCode();
            if (code == 404 || code == 409) return false;
            if (code != 200) return true;
            writeBackCookies(url, connection);
            return new JSONObject(readBody(connection)).optBoolean("live", true);
        } catch (Exception error) {
            return true; // Offline is never evidence that the shift ended.
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Resolve a pre-confirmation tracker after a lost start-package response or WebView exit.
     * Draft and network/auth failures keep its SQLite capture running without uploading.
     */
    static String provisionalShiftStatus(Context context, String shiftId, String origin) {
        if ("offline".equals(networkLabel(context))) return "unknown";
        HttpURLConnection connection = null;
        String url = origin + "/api/shifts/" + shiftId + "/gps/status";
        try {
            connection = open(url, "GET");
            int code = connection.getResponseCode();
            if (code == 404 || code == 409) return "ended";
            if (code != 200) return "unknown";
            writeBackCookies(url, connection);
            JSONObject response = new JSONObject(readBody(connection));
            if (!response.has("live")) return "unknown";
            if (response.optBoolean("live", false)) return "live";
            return "draft".equals(response.optString("state")) ? "draft" : "ended";
        } catch (Exception error) {
            return "unknown";
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    static boolean sendDiagnostics(Context context, GpsFixStore store, String shiftId, String origin, String serviceState) {
        HttpURLConnection connection = null;
        try {
            if ("offline".equals(networkLabel(context))) return false;
            JSONObject queue = store.diagnosticsForShift(shiftId);
            SharedPreferences prefs = context.getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
            JSONObject body = new JSONObject();
            body.put("appBuild", AshTrackerPlugin.appBuild(context));
            body.put("service", serviceState);
            body.put("permission", AshTrackerPlugin.permissionLabel(context));
            body.put("locationEnabled", AshTrackerPlugin.locationEnabled(context));
            body.put("backgroundPermission", AshTrackerPlugin.backgroundPermission(context));
            body.put("notificationPermission", AshTrackerPlugin.notificationPermission(context));
            body.put("batteryOptimizationExempt", AshTrackerPlugin.batteryOptimizationExempt(context));
            body.put("autostartAcknowledged", AshTrackerPlugin.autostartAcknowledged(context));
            body.put("network", networkLabel(context));
            body.put("pendingCount", queue.optInt("pendingCount", 0));
            body.put("lastCapturedAtMs", nullablePositive(prefs.getLong("lastCapturedAtMs:" + shiftId, 0)));
            body.put("lastUploadedAtMs", nullablePositive(prefs.getLong("lastUploadedAtMs:" + shiftId, 0)));
            body.put("droppedExpired", queue.optInt("droppedExpired", 0));
            body.put("droppedCapacity", queue.optInt("droppedCapacity", 0));
            body.put("droppedStorage", prefs.getInt("storageFailedCount:" + shiftId, 0));
            body.put("rejectionReasons", queue.optJSONObject("rejectionReasons") == null
                    ? new JSONObject() : queue.optJSONObject("rejectionReasons"));
            String url = origin + "/api/shifts/" + shiftId + "/gps/diagnostics";
            connection = open(url, "POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json");
            try (OutputStreamWriter out = new OutputStreamWriter(connection.getOutputStream(), "UTF-8")) {
                out.write(body.toString());
            }
            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) {
                writeBackCookies(url, connection);
                return true;
            }
            return false;
        } catch (Exception ignored) {
            // A heartbeat must never delay capture or delete queued points.
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static Object nullablePositive(long value) { return value > 0 ? value : JSONObject.NULL; }

    private static String networkFailureReason(Exception error) {
        if (error instanceof SocketTimeoutException) return "network_timeout";
        if (error instanceof UnknownHostException) return "dns_failure";
        if (error instanceof javax.net.ssl.SSLException) return "tls_failure";
        return "network_or_server_error";
    }

    static String networkLabel(Context context) {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return "unknown";
        try {
            Network active = manager.getActiveNetwork();
            NetworkCapabilities cap = manager.getNetworkCapabilities(active);
            return cap != null && cap.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ? "online" : "offline";
        } catch (Exception error) { return "unknown"; }
    }

    private static HttpURLConnection open(String url, String method) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(20_000);
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) connection.setRequestProperty("cookie", cookie);
        return connection;
    }

    private static String readBody(HttpURLConnection connection) throws Exception {
        StringBuilder body = new StringBuilder();
        try (BufferedReader in = new BufferedReader(new InputStreamReader(connection.getInputStream(), "UTF-8"))) {
            String line;
            while ((line = in.readLine()) != null) body.append(line);
        }
        return body.toString();
    }

    private static void writeBackCookies(String url, HttpURLConnection connection) {
        try {
            Map<String, List<String>> headers = connection.getHeaderFields();
            if (headers == null) return;
            CookieManager cm = CookieManager.getInstance();
            boolean any = false;
            for (Map.Entry<String, List<String>> header : headers.entrySet()) {
                if (header.getKey() != null && header.getKey().equalsIgnoreCase("Set-Cookie") && header.getValue() != null) {
                    for (String cookie : header.getValue()) cm.setCookie(url, cookie);
                    any = true;
                }
            }
            if (any) cm.flush();
        } catch (Exception ignored) {}
    }
}
