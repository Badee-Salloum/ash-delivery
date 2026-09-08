package com.ashdelivery.driver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

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
 * revoking it, which is the same action as today. Inventing a device token would have meant a
 * second auth path to secure, and a second one to get wrong.
 *
 * This is also the reason the shell must load the site over its real origin rather than bundling
 * the assets: bundled, the WebView's origin becomes `https://localhost`, the cookie is not there,
 * and this approach collapses.
 *
 *
 * WHAT STOPS IT.
 *
 * A 409 from the ingest route, and nothing else. The service outlives the WebView, so JavaScript
 * may never get the chance to call `stop()`; the server saying «this shift is no longer live» is
 * the only signal that reliably arrives. Every other failure — offline, 5xx, a timeout — means «not
 * yet», so the buffer is kept and the next tick retries. Reverse those two and a phone hammers a
 * closed shift every thirty seconds for weeks with nobody watching.
 */
class TrackerService : Service() {

    companion object {
        const val EXTRA_SHIFT_ID = "shiftId"
        const val EXTRA_ORIGIN = "origin"

        private const val CHANNEL_ID = "ash_tracking"
        private const val NOTIFICATION_ID = 4711

        /**
         * How often a fix is requested, and how often the buffer is flushed.
         *
         * SRS K's own non-functional target is a point every 10–30 s. Fifteen matches the web
         * beacon it replaces, so a trail does not change shape the day a driver installs the app —
         * which matters because the distance is compared against the odometer.
         */
        private const val INTERVAL_MS = 15_000L

        /** Never faster than this, whatever the platform decides to deliver. */
        private const val FASTEST_INTERVAL_MS = 10_000L

        /**
         * The batch cap, matching the server's. A phone that has been in a dead zone comes back
         * with a run, not a single fix.
         */
        private const val FLUSH_MAX = 500

        /** Bounded so a phone that never regains signal cannot grow this without limit. */
        private const val BUFFER_MAX = 2_000
    }

    private lateinit var client: FusedLocationProviderClient
    private val buffer = ArrayDeque<JSONObject>()
    private val io = Executors.newSingleThreadExecutor()
    private var shiftId: String? = null
    private var origin: String? = null
    @Volatile private var stopped = false

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val location = result.lastLocation ?: return
            synchronized(buffer) {
                // Oldest out when full: when the buffer overflows the recent minutes are the ones
                // worth keeping, because a stale position is what the live map must never be given.
                while (buffer.size >= BUFFER_MAX) buffer.removeFirst()
                buffer.addLast(
                    JSONObject().apply {
                        put("lat", location.latitude)
                        put("lng", location.longitude)
                        put("accuracyM", if (location.hasAccuracy()) location.accuracy.toDouble() else JSONObject.NULL)
                        put("capturedAtMs", location.time)
                    }
                )
            }
            io.execute { flush() }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra(EXTRA_SHIFT_ID)
        val base = intent?.getStringExtra(EXTRA_ORIGIN)
        if (id.isNullOrBlank() || base.isNullOrBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        shiftId = id
        origin = base.trimEnd('/')
        stopped = false

        startForeground(NOTIFICATION_ID, notification())
        client = LocationServices.getFusedLocationProviderClient(this)
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVAL_MS)
            .setMinUpdateIntervalMillis(FASTEST_INTERVAL_MS)
            .build()
        try {
            client.requestLocationUpdates(request, callback, Looper.getMainLooper())
        } catch (_: SecurityException) {
            // The permission was revoked between starting and now. Stopping is the honest response:
            // a foreground notification promising tracking that cannot happen is worse than none.
            stopSelf()
            return START_NOT_STICKY
        }
        // START_STICKY: if Android reclaims us under memory pressure we want to come back. The
        // shift is still open; the driver is still out.
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        if (this::client.isInitialized) client.removeLocationUpdates(callback)
        io.shutdown()
        super.onDestroy()
    }

    /**
     * The notification is not decoration and not a formality — it is the driver's notice.
     *
     * Android requires it for a location foreground service, and that requirement happens to be
     * exactly right here: a man is being followed while he works, and he can see that he is, for
     * as long as it is happening. It disappears the moment his shift closes.
     */
    private fun notification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.tracking_channel_name),
                // LOW: it must be visible and must not buzz. He is riding.
                NotificationManager.IMPORTANCE_LOW,
            )
            channel.setShowBadge(false)
            manager.createNotificationChannel(channel)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.tracking_title))
            .setContentText(getString(R.string.tracking_text))
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    /** Take everything buffered and post it. Runs on the single IO thread, so it never overlaps. */
    private fun flush() {
        if (stopped) return
        val id = shiftId ?: return
        val base = origin ?: return

        val sending: List<JSONObject>
        synchronized(buffer) {
            if (buffer.isEmpty()) return
            sending = buffer.take(FLUSH_MAX)
        }

        val body = JSONObject().apply {
            put("source", "phone_bg")
            put("fixes", JSONArray(sending))
        }

        when (post("$base/api/shifts/$id/gps", body)) {
            Outcome.ACCEPTED -> synchronized(buffer) {
                // Remove exactly what was sent; anything captured meanwhile stays queued.
                repeat(sending.size) { if (buffer.isNotEmpty()) buffer.removeFirst() }
            }
            Outcome.SHIFT_OVER -> {
                // The server will never take these. Drop them and stop — see the class comment.
                synchronized(buffer) { buffer.clear() }
                stopped = true
                stopSelf()
            }
            Outcome.RETRY -> Unit // keep the buffer; the next fix triggers another attempt
        }
    }

    private enum class Outcome { ACCEPTED, SHIFT_OVER, RETRY }

    private fun post(url: String, body: JSONObject): Outcome {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 20_000
                doOutput = true
                setRequestProperty("content-type", "application/json")
                // The driver's ordinary session, straight from the WebView's own cookie jar.
                CookieManager.getInstance().getCookie(url)?.let { setRequestProperty("cookie", it) }
            }
            OutputStreamWriter(connection.outputStream).use { it.write(body.toString()) }
            when (connection.responseCode) {
                in 200..299 -> Outcome.ACCEPTED
                409 -> Outcome.SHIFT_OVER
                // 401/403 are RETRY on purpose rather than a stop: a session that lapses while the
                // driver is out comes back when he next opens the app, and the fixes he took in
                // between are the ones worth keeping.
                else -> Outcome.RETRY
            }
        } catch (_: Exception) {
            Outcome.RETRY
        } finally {
            connection?.disconnect()
        }
    }
}
