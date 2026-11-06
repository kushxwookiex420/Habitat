package com.example.sparkquickview

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class SparkWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { updateOne(context, manager, it) }
    }
    companion object {
        const val PREFS = "spark_quick_view"
        fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, SparkWidgetProvider::class.java))
            ids.forEach { updateOne(context, manager, it) }
        }
        private fun updateOne(context: Context, manager: AppWidgetManager, id: Int) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val title = prefs.getString("offer_title", "Waiting for Spark offer notifications") ?: "Waiting for Spark offer notifications"
            val body = prefs.getString("offer_text", "Enable notification access, then keep Spark Driver notifications turned on.") ?: ""
            val time = prefs.getLong("offer_time", 0L)
            val whenText = if (time > 0) "Received " + SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(time)) else "No offer notification captured yet"
            val views = RemoteViews(context.packageName, R.layout.spark_widget)
            views.setTextViewText(R.id.widget_title, title)
            views.setTextViewText(R.id.widget_body, body)
            views.setTextViewText(R.id.widget_time, whenText)
            val launch = context.packageManager.getLaunchIntentForPackage("com.walmart.sparkdriver") ?: Intent(context, MainActivity::class.java)
            val pi = PendingIntent.getActivity(context, 10, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            views.setOnClickPendingIntent(R.id.widget_root, pi)
            manager.updateAppWidget(id, views)
        }
    }
}
