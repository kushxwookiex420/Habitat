package com.habitat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The policy is the last line of defence when an endpoint reaches the bridge. Flavor tests prove
 * the compiled values; these tests prove the rules for every URL shape an operator can type.
 */
class HabitatEndpointPolicyTest {
    private val nonProduction = HabitatEndpointPolicy.NONPRODUCTION
    private val production = HabitatEndpointPolicy.PRODUCTION

    @Test
    fun aNonProductionBuildRefusesTheProductionHostInEveryForm() {
        assertNotNull(HabitatEndpointPolicy.validate("https://habitat-1-szzd.onrender.com", nonProduction))
        assertNotNull(HabitatEndpointPolicy.validate("https://habitat-1-szzd.onrender.com/", nonProduction))
        assertNotNull(HabitatEndpointPolicy.validate("HTTPS://HABITAT-1-SZZD.ONRENDER.COM", nonProduction))
        assertNotNull(HabitatEndpointPolicy.validate("https://edge.habitat-1-szzd.onrender.com", nonProduction))
        assertTrue(HabitatEndpointPolicy.isProductionEndpoint("https://habitat-1-szzd.onrender.com"))
    }

    @Test
    fun anIsolatedHttpsBackendIsAcceptedForNonProduction() {
        assertNull(HabitatEndpointPolicy.validate("https://ax-nexus-habitat-nonprod.onrender.com", nonProduction))
        assertNull(HabitatEndpointPolicy.validate("https://habitat-nonprod.example.dev", nonProduction))
        assertFalse(HabitatEndpointPolicy.isProductionEndpoint("https://habitat-nonprod.example.dev"))
    }

    @Test
    fun cleartextIsOnlyAllowedForLoopbackTesting() {
        assertNull(HabitatEndpointPolicy.validate("http://127.0.0.1:8787", nonProduction))
        assertNull(HabitatEndpointPolicy.validate("http://10.0.2.2:8787", nonProduction))
        assertNotNull(HabitatEndpointPolicy.validate("http://habitat-nonprod.example.dev", nonProduction))
    }

    @Test
    fun malformedOrCredentialedEndpointsAreRejected() {
        assertNotNull(HabitatEndpointPolicy.validate(null, nonProduction))
        assertNotNull(HabitatEndpointPolicy.validate("", nonProduction))
        assertNotNull(HabitatEndpointPolicy.validate("not a url", nonProduction))
        assertNotNull(HabitatEndpointPolicy.validate("ftp://habitat-nonprod.example.dev", nonProduction))
        assertNotNull(HabitatEndpointPolicy.validate("https://habitat-nonprod.example.dev/?token=1", nonProduction))
        assertNotNull(HabitatEndpointPolicy.validate("https://user:pass@habitat-nonprod.example.dev", nonProduction))
    }

    @Test
    fun theProductionBuildStillAcceptsItsCompiledEndpoint() {
        assertNull(HabitatEndpointPolicy.validate("https://habitat-1-szzd.onrender.com", production))
        assertTrue(HabitatEndpointPolicy.isProductionHost("habitat-1-szzd.onrender.com"))
    }
}
