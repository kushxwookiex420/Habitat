package com.habitat

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** The production variant keeps its compiled backend and offers no runtime repointing. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ProductionConfigurationTest {
    private lateinit var context: Context

    @Before
    fun resetLinkState() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("habitat_ax_device_bridge", Context.MODE_PRIVATE)
            .edit().clear().commit()
    }

    @Test
    fun theProductionArtifactKeepsItsCompiledBackend() {
        assertEquals(HabitatEndpointPolicy.PRODUCTION, BuildConfig.HABITAT_ENVIRONMENT)
        assertEquals("https://habitat-1-szzd.onrender.com", BuildConfig.HABITAT_BASE_URL)
        assertEquals("com.habitat.axbridge", BuildConfig.APPLICATION_ID)
        assertEquals(BuildConfig.APPLICATION_ID, context.packageName)
        assertNull(HabitatEndpointPolicy.validate(BuildConfig.HABITAT_BASE_URL, BuildConfig.HABITAT_ENVIRONMENT))
    }

    @Test
    fun aProductionBuildCannotBeRepointedAtRuntime() {
        val bridge = AndroidDeviceBridge(context, BuildConfig.HABITAT_BASE_URL, InMemoryCredentialStore()) {}
        assertNull(bridge.configurationError)

        val refusal = bridge.configureEndpoint("https://habitat-nonprod.example.dev")

        assertNotNull(refusal)
        assertEquals(BuildConfig.HABITAT_BASE_URL, bridge.baseUrl)
        assertEquals(HabitatEndpointPolicy.PRODUCTION, bridge.environmentName)
    }
}
