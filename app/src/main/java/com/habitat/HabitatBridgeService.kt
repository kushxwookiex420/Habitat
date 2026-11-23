package com.habitat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Keeps the paired bridge connected while the phone is not showing Habitat.
 *
 * The 5-second poll was only alive while MainActivity was in front, and the JobScheduler fallback
 * runs at best every 15 minutes. This service owns the same outbound-only poll behind a visible
 * notification, so the owner can see that Habitat is connected and can stop it. Android may still
 * cap long-running dataSync services; the scheduled job remains the fallback.
 */
class HabitatBridgeService : Service() {

    companion object {
        private const val CHANNEL_ID = "habitat_bridge"
        private const val NOTIFICATION_ID = 27032

        fun start(context: Context) {
            try {
                val intent = Intent(context, HabitatBridgeService::class.java)
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
            } catch (_: Throwable) {
                // A denied foreground start must never crash the launcher; the periodic job still runs.
            }
        }

        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, HabitatBridgeService::class.java))
            } catch (_: Throwable) {
            }
        }
    }

    private var bridge: AndroidDeviceBridge? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Habitat AX")
            .setContentText("Phone bridge connected — waiting for owner commands")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        // The service owns the foreground connection; the bridge must not try to start it again.
        bridge = AndroidDeviceBridge(applicationContext, {}, startForegroundService = false)
        bridge?.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (bridge?.isConfigured() != true) {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        bridge?.stop()
        bridge = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Habitat bridge", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps the paired phone reachable for owner-approved commands."
                setShowBadge(false)
            }
        )
    }
}

/** Restarts the bridge after a reboot without waiting for the owner to open the app. */
class HabitatBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
        HabitatBridgeService.start(context)
    }
}
