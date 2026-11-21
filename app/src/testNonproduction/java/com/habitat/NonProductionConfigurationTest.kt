package com.habitat

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Compile-time and runtime proof that the nonproduction artifact cannot target production.
 *
 * These assertions run only in the nonproduction variant (src/testNonproduction). A production
 * build never compiles this file, and a nonproduction build cannot pass it while pointing at the
 * production host, because Gradle refuses that build before compilation.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NonProductionConfigurationTest {
    private lateinit var context: Context

    @Before
    fun resetLinkState() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("habitat_ax_device_bridge", Context.MODE_PRIVATE)
            .edit().clear().commit()
    }

    @Test
    fun theArtifactIdentifiesItselfAsNonProduction() {
        assertEquals(HabitatEndpointPolicy.NONPRODUCTION, BuildConfig.HABITAT_ENVIRONMENT)
        assertTrue(
            "a nonproduction install must not share the production package: " + BuildConfig.APPLICATION_ID,
            BuildConfig.APPLICATION_ID.endsWith(".nonprod")
        )
        assertEquals(BuildConfig.APPLICATION_ID, context.packageName)
    }

    @Test
    fun theCompiledBackendIsNotProduction() {
        assertFalse(
            "compiled endpoint is production: " + BuildConfig.HABITAT_BASE_URL,
            HabitatEndpointPolicy.isProductionEndpoint(BuildConfig.HABITAT_BASE_URL)
        )
        assertNull(
            HabitatEndpointPolicy.validate(BuildConfig.HABITAT_BASE_URL, BuildConfig.HABITAT_ENVIRONMENT)
        )
        assertTrue(BuildConfig.HABITAT_BASE_URL.startsWith("https://"))
    }

    @Test
    fun aProductionEndpointIsRefusedBeforeAnyRequestLeavesThePhone() {
        val store = InMemoryCredentialStore()
        val statuses = mutableListOf<String>()
        val bridge = AndroidDeviceBridge(
            context,
            "https://habitat-1-szzd.onrender.com",
            store,
            HabitatEndpointPolicy.NONPRODUCTION
        ) { statuses.add(it) }

        assertNotNull("the bridge must refuse the production endpoint", bridge.configurationError)
        assertTrue(bridge.configurationError!!.contains("production", ignoreCase = true))

        val done = CountDownLatch(1)
        val result = AtomicReference(false to "")
        bridge.pair("p".repeat(32)) { success, reason ->
            result.set(success to reason)
            done.countDown()
        }
        assertTrue("pairing must answer immediately", done.await(5, TimeUnit.SECONDS))
        assertFalse(result.get().first)
        assertTrue(result.get().second.contains("production", ignoreCase = true))
        assertNull("no credential may be stored", store.read())
        assertNotEquals(AndroidDeviceBridge.LinkState.LIVE, bridge.linkState())
    }

    @Test
    fun theEndpointOverrideAcceptsAnIsolatedServiceAndStillRefusesProduction() {
        val bridge = AndroidDeviceBridge(context, BuildConfig.HABITAT_BASE_URL, InMemoryCredentialStore()) {}
        assertNull(bridge.configurationError)

        val refused = bridge.configureEndpoint("https://habitat-1-szzd.onrender.com")
        assertNotNull("production must be refused at runtime too", refused)
        assertEquals(BuildConfig.HABITAT_BASE_URL, bridge.baseUrl)

        val accepted = bridge.configureEndpoint("https://habitat-nonprod-recheck.example.dev")
        assertNull(accepted)
        assertEquals("https://habitat-nonprod-recheck.example.dev", bridge.baseUrl)
        assertNull(bridge.configurationError)
    }

    @Test
    fun changingTheBackendClearsThePreviousCredential() {
        val store = InMemoryCredentialStore("t".repeat(48))
        val bridge = AndroidDeviceBridge(context, BuildConfig.HABITAT_BASE_URL, store) {}
        assertEquals(AndroidDeviceBridge.LinkState.PAIRED_UNVERIFIED, bridge.linkState())

        assertNull(bridge.configureEndpoint("https://habitat-nonprod-other.example.dev"))

        assertNull("a token from another service must not survive the switch", store.read())
        assertEquals(AndroidDeviceBridge.LinkState.UNPAIRED, bridge.linkState())
    }
}
