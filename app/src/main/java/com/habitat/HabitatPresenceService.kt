package com.habitat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the paired device credential alive outside the Activity.
 *
 * Before this service existed, MainActivity stopped the bridge in onPause. The only background
 * fallback was a 15-minute JobScheduler job, which Samsung/Doze can defer past the 45-minute
 * presence window. The result was a phone that looked present right after opening Habitat and
 * then expired to UNVERIFIED. This service owns the polling loop; the job stays as a fallback.
 */
class HabitatPresenceService : Service() {
    companion object {
        private const val CHANNEL_ID = "habitat_presence"
        private const val NOTIFICATION_ID = 4201

        fun start(context: Context): Boolean {
            if (!AndroidDeviceBridge(context.applicationContext) {}.isConfigured()) return false
            return runCatching {
                ContextCompat.startForegroundService(
                    context.applicationContext,
                    Intent(context.applicationContext, HabitatPresenceService::class.java)
                )
                true
            }.getOrDefault(false)
        }

        fun stop(context: Context) {
            runCatching {
                context.applicationContext.stopService(
                    Intent(context.applicationContext, HabitatPresenceService::class.java)
                )
            }
        }
    }

    private var bridge: AndroidDeviceBridge? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIFICATION_ID, notification())
        val agent = AndroidDeviceBridge(applicationContext) {}
        bridge = agent
        if (agent.isConfigured()) {
            agent.start()
        } else {
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (bridge?.isConfigured() != true) {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        bridge?.stop()
        bridge = null
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Habitat phone presence",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Authenticated check-in with your Habitat backend"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Habitat AX presence")
            .setContentText("Authenticated phone check-in is active")
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
