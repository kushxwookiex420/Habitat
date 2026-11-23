package com.habitat

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Android 15 restricts starting a dataSync foreground service directly from BOOT_COMPLETED, so the
 * persisted job is always restored first and the service start is best effort. Either path uses the
 * same Android Keystore credential; no new secret is created at boot.
 */
class HabitatBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
        val configured = runCatching {
            AndroidDeviceBridge(context.applicationContext) {}.isConfigured()
        }.getOrDefault(false)
        if (!configured) return
        DeviceBridgeScheduler.schedule(context)
        HabitatPresenceService.start(context)
    }
}
