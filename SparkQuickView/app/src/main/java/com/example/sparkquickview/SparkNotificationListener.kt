package com.example.sparkquickview

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.app.Notification

class SparkNotificationListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val pkg = sbn.packageName.lowercase()
        val extras = sbn.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.takeIf { it.isNotBlank() }
            ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        val combined = "$title $text".lowercase()
        val looksLikeSpark = pkg.contains("spark") ||
            (pkg.contains("walmart") && (combined.contains("offer") || combined.contains("spark")))
        if (!looksLikeSpark || (title.isBlank() && text.isBlank())) return
        getSharedPreferences(SparkWidgetProvider.PREFS, MODE_PRIVATE).edit()
            .putString("offer_title", title.ifBlank { "Spark notification" })
            .putString("offer_text", text.ifBlank { "Open Spark Driver to view details." })
            .putLong("offer_time", System.currentTimeMillis()).apply()
        SparkWidgetProvider.refreshAll(this)
    }
}
