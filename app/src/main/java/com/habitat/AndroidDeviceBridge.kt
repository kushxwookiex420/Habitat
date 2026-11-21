package com.habitat

import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Outbound-only, foreground phone agent. It accepts only the read-only device.status
 * command; no shell, file, messaging, publishing, or UI automation is exposed.
 *
 * Link states are explicit because the previous build showed a paired button and "success" as
 * soon as a token was stored, before the backend had ever authenticated this phone. Nothing here
 * reports LIVE until an authenticated poll has actually succeeded.
 */
class AndroidDeviceBridge(
    context: Context,
    baseUrl: String = BuildConfig.HABITAT_BASE_URL,
    private val credentials: CredentialStore = KeystoreCredentialStore(context),
    private val environment: String = BuildConfig.HABITAT_ENVIRONMENT,
    private val onStatus: (String) -> Unit
) {
    enum class LinkState { UNPAIRED, PAIRING, PAIRED_UNVERIFIED, LIVE, REVOKED }

    class HttpStatusException(val code: Int, message: String) : Exception(message)

    companion object {
        private const val PREFS = "habitat_ax_device_bridge"
        private const val DEVICE_ID_KEY = "device_id"
        private const val STATE_KEY = "link_state"
        private const val PAIRED_AT_KEY = "paired_at"
        private const val CONFIRMED_AT_KEY = "last_confirmed_at"
        private const val HEARTBEAT_AT_KEY = "last_heartbeat_at"
        private const val PAIRING_AT_KEY = "pairing_started_at"
        private const val NONPROD_ENDPOINT_KEY = "nonproduction_endpoint"
        private const val HEARTBEAT_INTERVAL_MS = 60_000L
        // A pairing attempt interrupted by process death is reported as PAIRING for this long,
        // then honestly falls back to UNPAIRED instead of showing a stale in-progress state.
        private const val PAIRING_WINDOW_MS = 5 * 60 * 1000L
    }

    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val diagnostics = BridgeDiagnostics(appContext)
    private val isProductionBuild = environment.trim().equals(HabitatEndpointPolicy.PRODUCTION, ignoreCase = true)

    // Nonproduction builds may be repointed at a different isolated service from inside the app;
    // production builds read only the compiled endpoint and have no override key at all.
    @Volatile
    private var endpoint: String = resolveInitialEndpoint(baseUrl)
    private var executor: ScheduledExecutorService? = null

    /** Non-null when this build must not talk to its configured endpoint. Nothing is sent then. */
    val configurationError: String?
        get() = HabitatEndpointPolicy.validate(endpoint, environment)

    val environmentName: String
        get() = if (isProductionBuild) HabitatEndpointPolicy.PRODUCTION else HabitatEndpointPolicy.NONPRODUCTION

    private fun resolveInitialEndpoint(compiled: String): String {
        val clean = compiled.trim().trimEnd('/')
        if (isProductionBuild) return clean
        val stored = prefs.getString(NONPROD_ENDPOINT_KEY, null)?.trim()?.trimEnd('/')
        if (!stored.isNullOrBlank() && HabitatEndpointPolicy.validate(stored, environment) == null) {
            return stored
        }
        return clean
    }

    init {
        diagnostics.record("INFO", "bridge environment " + environmentName + " endpoint " + endpoint)
        configurationError?.let { diagnostics.record("ERROR", "endpoint refused: " + it) }
    }

    val deviceId: String
        get() {
            val existing = prefs.getString(DEVICE_ID_KEY, null)
            if (!existing.isNullOrBlank()) return existing
            val created = "android-" + UUID.randomUUID().toString()
            prefs.edit().putString(DEVICE_ID_KEY, created).apply()
            return created
        }

    val baseUrl: String get() = endpoint

    fun isConfigured(): Boolean = !credentials.read().isNullOrBlank()

    /** Used by the in-app chat adapter so task and chat requests carry the same paired identity. */
    fun currentToken(): String? = credentials.read()

    fun linkState(): LinkState {
        val stored = prefs.getString(STATE_KEY, null)
        if (!isConfigured()) {
            if (stored == LinkState.REVOKED.name) return LinkState.REVOKED
            val pairingAt = prefs.getLong(PAIRING_AT_KEY, 0L)
            val pairingFresh = pairingAt > 0L && System.currentTimeMillis() - pairingAt < PAIRING_WINDOW_MS
            return if (pairingFresh) LinkState.PAIRING else LinkState.UNPAIRED
        }
        return when (stored) {
            LinkState.LIVE.name -> LinkState.LIVE
            LinkState.REVOKED.name -> LinkState.REVOKED
            else -> LinkState.PAIRED_UNVERIFIED
        }
    }

    fun lastConfirmedAt(): Long = prefs.getLong(CONFIRMED_AT_KEY, 0L)

    fun diagnosticsLines(limit: Int = 12): List<String> = diagnostics.lines(limit)

    fun recordLifecycle(event: String) = diagnostics.record("INFO", event)

    /**
     * Redeem a one-time pairing code. A true result means the credential was saved, not that the
     * backend has confirmed this phone; the caller must wait for the authenticated poll.
     */
    fun pair(code: String, onComplete: (Boolean, String) -> Unit) {
        val clean = code.trim()
        if (clean.length < 20 || clean.length > 128) {
            onComplete(false, "Pairing code format is invalid. Request a fresh code.")
            return
        }
        configurationError?.let { refusal ->
            diagnostics.record("ERROR", "pairing refused: " + refusal)
            onComplete(false, refusal)
            return
        }
        // PAIRING is written before the request leaves the phone, so a recreation or process death
        // still shows an in-progress attempt instead of an unexplained idle screen.
        prefs.edit().putLong(PAIRING_AT_KEY, System.currentTimeMillis()).apply()
        diagnostics.record("INFO", "pairing request started for " + deviceId + " at " + endpoint)
        Thread({
            var failureReason = "Pairing failed. Check the code and phone ID."
            val success = try {
                val response = request(
                    "POST", "/device/pair", null,
                    JSONObject().put("deviceId", deviceId).put("code", clean)
                )
                val token = response.optJSONObject("device")?.optString("token").orEmpty()
                if (!response.optBoolean("ok") || token.length < 40) {
                    failureReason = response.optString("error")
                        .ifBlank { "Server returned an invalid pairing response." }
                    diagnostics.record("ERROR", "pairing rejected: " + failureReason)
                    false
                } else if (!credentials.write(token)) {
                    failureReason = "Android Keystore could not save the phone credential."
                    diagnostics.record("ERROR", failureReason)
                    false
                } else {
                    prefs.edit()
                        .putString(STATE_KEY, LinkState.PAIRED_UNVERIFIED.name)
                        .putLong(PAIRED_AT_KEY, System.currentTimeMillis())
                        .remove(PAIRING_AT_KEY)
                        .remove(HEARTBEAT_AT_KEY)
                        .apply()
                    diagnostics.record("INFO", "credential stored; awaiting authenticated poll")
                    true
                }
            } catch (error: HttpStatusException) {
                failureReason = pairingFailureMessage(error.code, error.message.orEmpty())
                diagnostics.record("ERROR", "pairing HTTP " + error.code + ": " + error.message)
                false
            } catch (error: Throwable) {
                failureReason = (error.message ?: error.javaClass.simpleName).take(180)
                diagnostics.record("ERROR", "pairing transport failure: " + failureReason)
                false
            }
            if (!success) prefs.edit().remove(PAIRING_AT_KEY).apply()
            try {
                onComplete(success, if (success) "Credential saved; verifying with Ax…" else failureReason)
            } catch (_: Throwable) {
                // A destroyed Activity must not crash the pairing worker.
            }
        }, "Habitat-Phone-Pair").apply {
            isDaemon = true
            start()
        }
    }

    private fun pairingFailureMessage(code: Int, reason: String): String = when (code) {
        400 -> "Pairing code was rejected as malformed. Request a fresh code."
        401, 403 -> "Pairing was refused. Request a fresh code from Ax."
        409 -> reason.ifBlank { "This pairing code is expired, used, or belongs to another phone." }
        404 -> "This endpoint is not a Habitat backend (HTTP 404). Check the nonproduction URL."
        429 -> "Too many pairing attempts. Wait, then request a fresh code."
        503 -> "Habitat is temporarily unavailable. The screen stays open; try again shortly."
        else -> if (reason.isBlank()) "Pairing failed (HTTP $code)." else "Pairing failed (HTTP $code): $reason"
    }

    @Synchronized
    fun clearCredentials() {
        stop()
        DeviceBridgeScheduler.cancel(appContext)
        credentials.clear()
        // A re-pair must send a fresh heartbeat rather than inheriting the previous timestamp.
        prefs.edit()
            .remove(HEARTBEAT_AT_KEY)
            .remove(CONFIRMED_AT_KEY)
            .remove(PAIRING_AT_KEY)
            .putString(STATE_KEY, LinkState.UNPAIRED.name)
            .apply()
        diagnostics.record("INFO", "credentials cleared by user")
    }

    /**
     * Point a nonproduction build at a different isolated backend.
     *
     * Returns null on success or a refusal. A production build can never be repointed, and a
     * nonproduction build refuses the production host. Changing the backend clears any credential
     * from the previous service, because a token is only meaningful to the backend that issued it.
     */
    @Synchronized
    fun configureEndpoint(candidate: String): String? {
        if (isProductionBuild) {
            return "This production build cannot change its backend endpoint."
        }
        val clean = candidate.trim().trimEnd('/')
        val rejection = HabitatEndpointPolicy.validate(clean, environment)
        if (rejection != null) {
            diagnostics.record("ERROR", "endpoint change refused: " + rejection)
            return rejection
        }
        if (clean == endpoint) {
            prefs.edit().putString(NONPROD_ENDPOINT_KEY, clean).apply()
            return null
        }
        stop()
        DeviceBridgeScheduler.cancel(appContext)
        credentials.clear()
        prefs.edit()
            .putString(NONPROD_ENDPOINT_KEY, clean)
            .putString(STATE_KEY, LinkState.UNPAIRED.name)
            .remove(PAIRED_AT_KEY)
            .remove(CONFIRMED_AT_KEY)
            .remove(HEARTBEAT_AT_KEY)
            .remove(PAIRING_AT_KEY)
            .apply()
        endpoint = clean
        diagnostics.record("INFO", "nonproduction endpoint set to " + clean)
        onStatus("Endpoint set to " + clean + "; pair this phone again")
        return null
    }

    @Synchronized
    fun start() {
        if (!isConfigured() || executor != null) return
        configurationError?.let { refusal ->
            diagnostics.record("ERROR", "polling not started: " + refusal)
            onStatus(refusal)
            return
        }
        executor = Executors.newSingleThreadScheduledExecutor()
        executor?.scheduleWithFixedDelay({ pollOnce() }, 0, 5, TimeUnit.SECONDS)
        onStatus("AX device bridge polling started")
    }

    @Synchronized
    fun stop() {
        executor?.shutdownNow()
        executor = null
    }

    fun pollOnceNow() = pollOnce()

    private fun sendHeartbeat(token: String) {
        val now = System.currentTimeMillis()
        val last = prefs.getLong(HEARTBEAT_AT_KEY, 0L)
        if (now - last < HEARTBEAT_INTERVAL_MS) return

        val battery = appContext.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val power = appContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val details = JSONObject().apply {
            put("manufacturer", Build.MANUFACTURER)
            put("model", Build.MODEL)
            put("androidSdk", Build.VERSION.SDK_INT)
            put("androidRelease", Build.VERSION.RELEASE)
            put("appVersion", try {
                appContext.packageManager.getPackageInfo(appContext.packageName, 0).versionName.orEmpty()
            } catch (_: Exception) { "unknown" })
            val capacity = battery?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
            if (capacity in 0..100) put("batteryPercent", capacity)
            put("charging", try {
                val intent = appContext.registerReceiver(
                    null,
                    android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED)
                )
                val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
                status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
            } catch (_: Exception) { false })
            put("interactive", power?.isInteractive ?: false)
        }
        try {
            request(
                "POST", "/device/heartbeat", token,
                JSONObject().put("deviceId", deviceId).put("details", details)
            )
            prefs.edit().putLong(HEARTBEAT_AT_KEY, now).apply()
        } catch (error: HttpStatusException) {
            diagnostics.record("WARN", "heartbeat HTTP " + error.code)
        } catch (error: Throwable) {
            diagnostics.record("WARN", "heartbeat failed: " + (error.message ?: "unknown"))
        }
    }

    private fun pollOnce() {
        val token = credentials.read()
        if (token.isNullOrBlank()) return
        configurationError?.let { refusal ->
            markNotLive(refusal)
            return
        }
        try {
            val next = request(
                "GET",
                "/device/commands/next?deviceId=" + URLEncoder.encode(deviceId, "UTF-8"),
                token
            )
            if (next.optBoolean("ok") != true) {
                diagnostics.record("WARN", "poll returned ok=false")
                markNotLive("AX bridge rejected the phone request")
                return
            }
            // A successful authenticated poll proves this phone can reach the durable command
            // queue with its paired credential. Only now is the link reported LIVE.
            markLive()
            sendHeartbeat(token)
            val command = next.optJSONObject("command") ?: return
            val id = command.optString("id")
            val type = command.optString("type")
            if (id.isBlank()) return
            val result = when (type) {
                "device.status" -> JSONObject().apply {
                    put("ok", true)
                    put("summary", "Habitat Android device is online and responding")
                    put("details", JSONObject().apply {
                        put("deviceId", deviceId)
                        put("manufacturer", Build.MANUFACTURER)
                        put("model", Build.MODEL)
                        put("androidSdk", Build.VERSION.SDK_INT)
                        put("androidRelease", Build.VERSION.RELEASE)
                        put("app", "Habitat Android")
                    })
                }
                else -> JSONObject().apply {
                    put("ok", false)
                    put("summary", "Unsupported command rejected by Android agent")
                    put("details", JSONObject().put("type", type))
                }
            }
            val body = JSONObject().put("deviceId", deviceId).put("result", result)
            request("POST", "/device/commands/$id/result", token, body)
            diagnostics.record("INFO", "command " + type + " completed")
            onStatus("AX device bridge: command completed")
        } catch (error: HttpStatusException) {
            when {
                error.code == 401 || error.code == 403 -> {
                    credentials.clear()
                    prefs.edit()
                        .putString(STATE_KEY, LinkState.REVOKED.name)
                        .remove(CONFIRMED_AT_KEY)
                        .apply()
                    diagnostics.record("ERROR", "phone link revoked (HTTP " + error.code + "); credentials cleared")
                    onStatus("AX phone link revoked; credentials cleared")
                }
                error.code == 409 -> {
                    // The command was already completed or expired. The credential is still valid.
                    diagnostics.record("WARN", "command result rejected (HTTP 409)")
                }
                else -> markNotLive("AX bridge temporarily unavailable: HTTP " + error.code)
            }
        } catch (error: Throwable) {
            markNotLive("AX bridge temporarily unavailable: " + (error.message ?: "unknown").take(100))
        }
    }

    private fun markLive() {
        val alreadyLive = prefs.getString(STATE_KEY, null) == LinkState.LIVE.name
        prefs.edit()
            .putString(STATE_KEY, LinkState.LIVE.name)
            .putLong(CONFIRMED_AT_KEY, System.currentTimeMillis())
            .apply()
        if (!alreadyLive) diagnostics.record("INFO", "authenticated poll confirmed; link LIVE")
        onStatus("AX LINK LIVE")
    }

    private fun markNotLive(message: String) {
        if (prefs.getString(STATE_KEY, null) == LinkState.LIVE.name) {
            prefs.edit().putString(STATE_KEY, LinkState.PAIRED_UNVERIFIED.name).apply()
        }
        diagnostics.record("WARN", message)
        onStatus(message)
    }

    private fun request(
        method: String,
        path: String,
        token: String?,
        body: JSONObject? = null
    ): JSONObject {
        val connection = HabitatNetwork.openConnection(endpoint + path)
        try {
            connection.requestMethod = method
            connection.connectTimeout = 12000
            connection.readTimeout = 12000
            if (!token.isNullOrBlank()) connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Accept", "application/json")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val raw = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) {
                val reason = try {
                    JSONObject(raw).optString("error").takeIf { it.isNotBlank() } ?: raw.take(180)
                } catch (_: Exception) { raw.take(180) }
                throw HttpStatusException(code, reason)
            }
            return JSONObject(raw)
        } finally {
            connection.disconnect()
        }
    }
}
