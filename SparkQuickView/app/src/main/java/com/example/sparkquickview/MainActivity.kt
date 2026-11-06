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
  val pad=(20*resources.displayMetrics.density).toInt()
  val root=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(pad,pad,pad,pad); gravity=Gravity.CENTER_HORIZONTAL }
  root.addView(TextView(this).apply { text="SPARK QUICK VIEW"; textSize=24f; setPadding(0,0,0,pad) })
  root.addView(TextView(this).apply { text="Reads visible offer text only while Spark Driver is open. It never taps, accepts, or rejects offers."; textSize=16f; setPadding(0,0,0,pad) })
  root.addView(Button(this).apply { text="Enable offer reading"; setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) } })
  root.addView(Button(this).apply { text="Enable notification access"; setOnClickListener { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) } })
  root.addView(Button(this).apply { text="Open Spark Driver"; setOnClickListener {
   val launch=packageManager.getLaunchIntentForPackage("com.walmart.sparkdriver")
   if(launch!=null) startActivity(launch) else Toast.makeText(this@MainActivity,"Open Spark Driver manually.",Toast.LENGTH_LONG).show()
  } })
  root.addView(Button(this).apply { text="Refresh widget"; setOnClickListener { SparkWidgetProvider.refreshAll(this@MainActivity) } })
  setContentView(root)
 }
}