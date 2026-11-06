package com.example.sparkquickview

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.Locale

class SparkOfferAccessibilityService : AccessibilityService() {
    private var lastSeen = ""

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || event.packageName?.toString() != "com.walmart.sparkdriver") return

        val collected = ArrayList<String>()
        event.text?.forEach { value ->
            value?.toString()?.takeIf { it.isNotBlank() }?.let { collected.add(it) }
        }
        val root = rootInActiveWindow ?: event.source
        collect(root, collected)
        val screen = collected.distinct().joinToString(" ").replace(Regex("\\s+"), " ").trim()
        if (screen.isBlank()) return

        val amount = Regex("""\\$\\s?(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?)""")
            .find(screen)?.groupValues?.get(1)
        val miles = Regex("""(?i)(\\d+(?:\\.\\d+)?)\\s*(?:mi|miles?)\\b""")
            .find(screen)?.groupValues?.get(1)?.toDoubleOrNull()
            ?: Regex("""(?i)\\b(?:miles?|mi)\\s*[:\\-]?\\s*(\\d+(?:\\.\\d+)?)\\b""")
                .find(screen)?.groupValues?.get(1)?.toDoubleOrNull()

        val title: String
        val detail: String
        if (amount != null && miles != null && miles > 0) {
            val pay = amount.replace(",", "").toDoubleOrNull()
            val rate = pay?.div(miles)
            title = "OFFER DETAILS FOUND"
            detail = "$" + amount + "  •  " + miles + " mi" +
                (rate?.let { "  •  $" + String.format(Locale.US, "%.2f", it) + "/mi" } ?: "")
        } else {
            title = "SPARK SCREEN TEXT (CHECK)"
            detail = "Reader is active, but could not identify both pay and miles. Text seen: " +
                screen.take(190)
        }

        val key = title + "|" + detail
        if (key == lastSeen) return
        lastSeen = key
        getSharedPreferences(SparkWidgetProvider.PREFS, Context.MODE_PRIVATE).edit()
            .putString("offer_title", title)
            .putString("offer_text", detail)
            .putLong("offer_time", System.currentTimeMillis())
            .apply()
        SparkWidgetProvider.refreshAll(this)
    }

    private fun collect(node: AccessibilityNodeInfo?, out: MutableList<String>) {
        if (node == null) return
        node.text?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it) }
        node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it) }
        for (i in 0 until node.childCount) collect(node.getChild(i), out)
    }

    override fun onInterrupt() {}
}