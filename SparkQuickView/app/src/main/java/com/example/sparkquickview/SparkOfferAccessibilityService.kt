package com.example.sparkquickview
import android.accessibilityservice.AccessibilityService
import android.appwidget.AppWidgetManager
import android.content.Context
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class SparkOfferAccessibilityService : AccessibilityService() {
 private var lastSeen=""
 override fun onAccessibilityEvent(event: AccessibilityEvent?) {
  if(event==null || event.packageName?.toString()!="com.walmart.sparkdriver") return
  val root=rootInActiveWindow ?: return
  val text=ArrayList<String>()
  collect(root,text)
  val screen=text.distinct().joinToString(" ")
  val amount=Regex("""\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?""").find(screen)?.value?.replace(" ","") ?: return
  val miles=Regex("""(?i)(\d+(?:\.\d+)?)\s*(?:mi|miles)\b""").find(screen)?.groupValues?.get(1)?.toDoubleOrNull() ?: return
  if(miles<=0) return
  val key=amount+"|"+miles
  if(key==lastSeen) return
  lastSeen=key
  val pay=amount.removePrefix("$").replace(",","").toDoubleOrNull()
  val rate=pay?.div(miles)
  val detail=amount+"  •  "+miles+" mi"+(rate?.let { "  •  $"+String.format(Locale.US,"%.2f",it)+"/mi" } ?: "")
  getSharedPreferences(SparkWidgetProvider.PREFS,Context.MODE_PRIVATE).edit()
   .putString("offer_title","OFFER DETAILS FOUND")
   .putString("offer_text",detail)
   .putLong("offer_time",System.currentTimeMillis()).apply()
  SparkWidgetProvider.refreshAll(this)
 }
 private fun collect(node:AccessibilityNodeInfo?,out:MutableList<String>) {
  if(node==null) return
  node.text?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it) }
  node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it) }
  for(i in 0 until node.childCount) collect(node.getChild(i),out)
 }
 override fun onInterrupt() {}
}