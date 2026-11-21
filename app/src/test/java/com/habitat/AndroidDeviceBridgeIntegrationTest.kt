package com.habitat

import android.content.Context
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.net.HttpURLConnection
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.net.URL

/**
 * Android client integration against a real nonproduction HTTP listener.
 *
 * Real: the shipped AndroidDeviceBridge code, its HTTP requests, credential handling, link state
 * machine, the bridge routes on the other side, the durable queue, SQLite storage.
 *
 * Not real: a physical phone, an emulator, Android Keystore (an in-memory CredentialStore stands in
 * for it because Robolectric has no AndroidKeyStore provider), Cloudflare D1, Render.
 *
 * The listener is started by scripts/nonprod-acceptance-server.mjs. When its environment variables
 * are absent the suite is skipped rather than reported as passing.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidDeviceBridgeIntegrationTest {
    private lateinit var context: Context
    private lateinit var baseUrl: String
    private lateinit var axToken: String
    private lateinit var acceptanceToken: String

    private data class HttpResult(val status: Int, val body: JSONObject?)

    @Before
    fun requireHarness() {
        context = RuntimeEnvironment.getApplication()
        baseUrl = System.getenv("HABITAT_ACCEPTANCE_BASE_URL").orEmpty().trimEnd('/')
        axToken = System.getenv("HABITAT_ACCEPTANCE_AX_TOKEN").orEmpty()
        acceptanceToken = System.getenv("HABITAT_ACCEPTANCE_TOKEN").orEmpty()
        assumeTrue(
            "nonproduction acceptance server not configured",
            baseUrl.isNotEmpty() && axToken.isNotEmpty() && acceptanceToken.isNotEmpty()
        )
        // Start from an unpaired phone for every test.
        prefs().edit().clear().commit()
    }

    private fun prefs() = context.getSharedPreferences("habitat_ax_device_bridge", Context.MODE_PRIVATE)

    private fun http(
        method: String,
        path: String,
        token: String? = null,
        body: JSONObject? = null,
        extraHeaders: Map<String, String> = emptyMap(),
        base: String = baseUrl
    ): HttpResult {
        val connection = URL(base + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 5000
            connection.readTimeout = 15000
            connection.setRequestProperty("Accept", "application/json")
            if (!token.isNullOrBlank()) connection.setRequestProperty("Authorization", "Bearer $token")
            extraHeaders.forEach { (key, value) -> connection.setRequestProperty(key, value) }
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val raw = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = try { JSONObject(raw) } catch (_: Exception) { null }
            return HttpResult(code, json)
        } finally {
            connection.disconnect()
        }
    }

    private fun mint(codeDeviceId: String): String {
        val minted = http(
            "POST", "/ax/device/pairings", axToken,
            JSONObject().put("deviceId", codeDeviceId)
        )
        assertEquals("pairing mint failed: " + minted.body, 201, minted.status)
        return minted.body!!.getJSONObject("pairing").getString("code")
    }

    private fun pairAwait(bridge: AndroidDeviceBridge, code: String): Pair<Boolean, String> {
        val done = CountDownLatch(1)
        val result = AtomicReference<Pair<Boolean, String>>(false to "no callback")
        bridge.pair(code) { success, reason ->
            result.set(success to reason)
            done.countDown()
        }
        assertTrue("pairing callback never returned", done.await(20, TimeUnit.SECONDS))
        return result.get()
    }

    private fun newBridge(deviceId: String, store: CredentialStore = InMemoryCredentialStore(), statuses: MutableList<String>? = null, base: String = baseUrl): AndroidDeviceBridge {
        prefs().edit().putString("device_id", deviceId).commit()
        return AndroidDeviceBridge(context, base, store) { status -> statuses?.add(status) }
    }

    private fun waitFor(maxMillis: Long = 4000, condition: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + maxMillis
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return true
            Thread.sleep(50)
        }
        return condition()
    }

    @Test
    fun pairingIsSavedThenConfirmedByAnAuthenticatedPollAndRunsDeviceStatus() {
        val deviceId = "android-robo-" + System.nanoTime()
        val store = InMemoryCredentialStore()
        val statuses = mutableListOf<String>()
        val bridge = newBridge(deviceId, store, statuses)

        assertEquals(AndroidDeviceBridge.LinkState.UNPAIRED, bridge.linkState())

        val code = mint(deviceId)
        val (paired, reason) = pairAwait(bridge, code)
        assertTrue("pairing should succeed: $reason", paired)
        assertNotNull(store.read())
        // A stored credential is not proof of authentication.
        assertEquals(AndroidDeviceBridge.LinkState.PAIRED_UNVERIFIED, bridge.linkState())
        assertFalse("no LIVE status may be reported before authentication", statuses.contains("AX LINK LIVE"))

        bridge.pollOnceNow()
        assertEquals(AndroidDeviceBridge.LinkState.LIVE, bridge.linkState())
        assertTrue(statuses.contains("AX LINK LIVE"))

        // The same credential still identifies the phone in a new instance (app restart).
        val restarted = newBridge(deviceId, store)
        assertEquals(AndroidDeviceBridge.LinkState.LIVE, restarted.linkState())
        restarted.pollOnceNow()
        assertEquals(AndroidDeviceBridge.LinkState.LIVE, restarted.linkState())

        // A read-only device.status command queued by the relay is claimed and completed.
        val queued = http(
            "POST", "/acceptance/queue-device-status", null,
            JSONObject().put("deviceId", deviceId),
            mapOf("x-acceptance-token" to acceptanceToken)
        )
        assertEquals("queue failed: " + queued.body, 201, queued.status)
        val commandId = queued.body!!.getString("commandId")

        bridge.pollOnceNow()
        val stored = http("GET", "/ax/device/commands/$commandId", axToken)
        assertEquals(200, stored.status)
        val command = stored.body!!.getJSONObject("command")
        assertEquals("completed", command.getString("status"))
        assertEquals("device.status", command.getString("type"))
        val details = command.getJSONObject("result").getJSONObject("details")
        assertEquals(deviceId, details.getString("deviceId"))
        assertTrue(details.optString("model").isNotEmpty())

        // Revocation ends the link and destroys the stored credential.
        val revoked = http("POST", "/ax/device/$deviceId/revoke", axToken)
        assertEquals(200, revoked.status)
        bridge.pollOnceNow()
        assertEquals(AndroidDeviceBridge.LinkState.REVOKED, bridge.linkState())
        assertNull(store.read())
    }

    @Test
    fun aConsumedPairingCodeCannotPairASecondPhone() {
        val firstDevice = "android-robo-a-" + System.nanoTime()
        val secondDevice = "android-robo-b-" + System.nanoTime()
        val code = mint(firstDevice)

        val first = newBridge(firstDevice)
        val (firstPaired, firstReason) = pairAwait(first, code)
        assertTrue("first pairing should succeed: $firstReason", firstPaired)

        val second = newBridge(secondDevice)
        val (secondPaired, secondReason) = pairAwait(second, code)
        assertFalse(secondPaired)
        assertTrue(
            "the refusal should explain the code was already used: $secondReason",
            secondReason.contains("already used", ignoreCase = true) ||
                secondReason.contains("409") ||
                secondReason.contains("fresh code", ignoreCase = true)
        )
        assertNull(second.currentToken())
        assertEquals(AndroidDeviceBridge.LinkState.UNPAIRED, second.linkState())
    }

    @Test
    fun anUnreachableBackendNeverThrowsAndNeverClaimsLive() {
        val store = InMemoryCredentialStore("t".repeat(48))
        val notes = mutableListOf<String>()
        val bridge = newBridge("android-robo-offline", store, notes, base = "http://127.0.0.1:1")

        bridge.pollOnceNow()

        assertEquals(AndroidDeviceBridge.LinkState.PAIRED_UNVERIFIED, bridge.linkState())
        assertFalse(notes.contains("AX LINK LIVE"))
        assertNotNull("the offline failure should be recorded", store.read())
        assertTrue(
            "diagnostics must explain the failure: " + bridge.diagnosticsLines(),
            bridge.diagnosticsLines().any { it.contains("unavailable", ignoreCase = true) || it.contains("failed", ignoreCase = true) }
        )
    }

    @Test
    fun aRejectedCredentialIsClearedAndReportedAsRevoked() {
        val store = InMemoryCredentialStore("z".repeat(48))
        val notes = mutableListOf<String>()
        val bridge = newBridge("android-robo-rejected", store, notes)

        bridge.pollOnceNow()

        assertEquals(AndroidDeviceBridge.LinkState.REVOKED, bridge.linkState())
        assertNull(store.read())
        assertTrue(notes.any { it.contains("revoked") })
    }

    @Test
    fun pairingAgainstAnUnreachableBackendKeepsTheUserInformed() {
        val bridge = newBridge("android-robo-pair-offline", InMemoryCredentialStore(), base = "http://127.0.0.1:1")
        val (paired, reason) = pairAwait(bridge, "p".repeat(32))
        assertFalse(paired)
        assertTrue("reason should describe the failure: $reason", reason.isNotEmpty())
        assertEquals(AndroidDeviceBridge.LinkState.UNPAIRED, bridge.linkState())
    }
}
