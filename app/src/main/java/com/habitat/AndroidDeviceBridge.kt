package com.habitat

import android.content.Context
import android.os.Build
import android.os.BatteryManager
import android.os.PowerManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Outbound-only, foreground phone agent. It accepts only the read-only device.status
 * command; no shell, file, messaging, publishing, or UI automation is exposed.
 */
class AndroidDeviceBridge(
    context: Context,
    private val onStatus: (String) -> Unit
) {
    companion object {
        private const val PREFS = "habitat_ax_device_bridge"
        private const val KEY_ALIAS = "habitat_ax_device_bridge_v1"
        private const val BASE_URL = "https://habitat-1-szzd.onrender.com"
    }

    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private var executor: ScheduledExecutorService? = null

    val deviceId: String
        get() {
            val existing = prefs.getString("device_id", null)
            if (!existing.isNullOrBlank()) return existing
            val created = "android-" + UUID.randomUUID().toString()
            prefs.edit().putString("device_id", created).apply()
            return created
        }

    fun isConfigured(): Boolean = !readToken().isNullOrBlank()

    fun pair(code: String, onComplete: (Boolean, String) -> Unit) {
        val clean = code.trim()
        if (clean.length < 20 || clean.length > 128) {
            onComplete(false, "Pairing code format is invalid. Request a fresh code.")
            return
        }
        Thread {
            val success = try {
                val response = request(
                    "POST", "/device/pair", null,
                    JSONObject().put("deviceId", deviceId).put("code", clean)
                )
                val token = response.optJSONObject("device")?.optString("token").orEmpty()
                if (!response.optBoolean("ok") || token.length < 40) false else storeToken(token)
            } catch (_: Exception) {
                false
            }
            onComplete(success)
        }.start()
    }

    @Synchronized
    private fun storeToken(token: String): Boolean {
        val clean = token.trim()
        if (clean.length < 40 || clean.length > 512) return false
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val encrypted = cipher.doFinal(clean.toByteArray(Charsets.UTF_8))
            val packed = cipher.iv + encrypted
            prefs.edit().putString("encrypted_token", Base64.encodeToString(packed, Base64.NO_WRAP)).apply()
            true
        } catch (_: Exception) {
            false
        }
    }

    @Synchronized
    fun clearCredentials() {
        stop()
        DeviceBridgeScheduler.cancel(appContext)
        prefs.edit().remove("encrypted_token").apply()
    }

    @Synchronized
    fun start() {
        if (!isConfigured() || executor != null) return
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
        val last = prefs.getLong("last_heartbeat_at", 0L)
        if (now - last < 60_000L) return

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
                val intent = appContext.registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
                val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
                status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
            } catch (_: Exception) { false })
            put("interactive", power?.isInteractive ?: false)
        }
        request("POST", "/device/heartbeat", token, JSONObject().put("deviceId", deviceId).put("details", details))
        prefs.edit().putLong("last_heartbeat_at", now).apply()
    }

    private fun pollOnce() {
        val token = readToken() ?: return
        try {
            val next = request("GET", "/device/commands/next?deviceId=" + java.net.URLEncoder.encode(deviceId, "UTF-8"), token)
            if (next.optBoolean("ok") != true) {
                onStatus("AX bridge rejected the phone request")
                return
            }
            // A successful authenticated poll proves this phone can reach the
            // durable command queue with its paired device credential.
            onStatus("AX LINK LIVE")
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
            onStatus("AX device bridge: command completed")
        } catch (e: Exception) {
            val message = e.message.orEmpty()
            if (message.contains("401")) {
                clearCredentials()
                onStatus("AX phone link revoked; credentials cleared")
            } else {
                onStatus("AX bridge temporarily unavailable: " + message.take(100))
            }
        }
    }

    private fun request(method: String, path: String, token: String?, body: JSONObject? = null): JSONObject {
        val connection = HabitatNetwork.openConnection(BASE_URL + path)
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
                throw IllegalStateException("HTTP $code: " + reason)
            }
            return JSONObject(raw)
        } finally {
            connection.disconnect()
        }
    }

    private fun readToken(): String? {
        val packedText = prefs.getString("encrypted_token", null) ?: return null
        return try {
            val packed = Base64.decode(packedText, Base64.NO_WRAP)
            if (packed.size <= 12) return null
            val iv = packed.copyOfRange(0, 12)
            val ciphertext = packed.copyOfRange(12, packed.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }
}
