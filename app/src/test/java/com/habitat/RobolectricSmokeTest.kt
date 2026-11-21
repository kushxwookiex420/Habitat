package com.habitat

import android.content.Context
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RobolectricSmokeTest {
    @Test
    fun applicationContextIsAvailable() {
        val context: Context = RuntimeEnvironment.getApplication()
        assertNotNull(context)
        assertTrue(BuildConfig.HABITAT_BASE_URL.startsWith("http"))
    }
}
