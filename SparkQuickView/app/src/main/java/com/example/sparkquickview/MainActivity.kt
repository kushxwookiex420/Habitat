package com.example.sparkquickview

import android.app.Activity
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (20 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            gravity = Gravity.CENTER_HORIZONTAL
        }
        root.addView(TextView(this).apply {
            text = "SPARK QUICK VIEW"; textSize = 24f; setPadding(0, 0, 0, pad)
        })
        root.addView(TextView(this).apply {
            text = "Shows Spark Driver offer details only when Spark includes them in an Android notification. It does not access Spark's private feed or accept offers."
            textSize = 16f; setPadding(0, 0, 0, pad)
        })
        val status = TextView(this).apply { textSize = 15f; setPadding(0, 0, 0, pad) }
        val permission = Button(this).apply {
            text = "Enable notification access"
            setOnClickListener { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
        }
        val openSpark = Button(this).apply {
            text = "Open Spark Driver"
            setOnClickListener {
                val launch = packageManager.getLaunchIntentForPackage("com.walmart.sparkdriver")
                if (launch != null) startActivity(launch)
                else Toast.makeText(this@MainActivity, "Open Spark Driver manually from your app list.", Toast.LENGTH_LONG).show()
            }
        }
        val refresh = Button(this).apply {
            text = "Refresh widget"
            setOnClickListener { SparkWidgetProvider.refreshAll(this@MainActivity) }
        }
        root.addView(status); root.addView(permission); root.addView(openSpark); root.addView(refresh)
        setContentView(root)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val cn = ComponentName(this, SparkNotificationListener::class.java)
        status.text = if (nm.isNotificationListenerAccessGranted(cn)) "Notification access: enabled" else "Notification access: not enabled"
    }
}
