package com.habitat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Small, durable on-device log for pairing and bridge failures.
 *
 * The reported "pairing sends the app to the home screen" failure could not be reproduced without
 * the physical device, so the app now records what happened around pairing instead of discarding
 * it. Entries contain no credentials, only status text, HTTP codes, and lifecycle events.
 */
class BridgeDiagnostics(context: Context) {
    companion object {
        private const val PREFS = "habitat_ax_diagnostics"
        private const val KEY = "entries"
        private const val MAX_ENTRIES = 40
    }

    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun record(level: String, message: String) {
        val clean = message.replace("\n", " ").take(400)
        val entry = JSONObject().apply {
            put("at", SimpleDateFormat("HH:mm:ss", Locale.US).format(Date()))
            put("level", level)
            put("message", clean)
        }
        val entries = readArray()
        entries.put(entry)
        while (entries.length() > MAX_ENTRIES) entries.remove(0)
        prefs.edit().putString(KEY, entries.toString()).apply()
    }

    @Synchronized
    fun lines(limit: Int = 12): List<String> {
        val entries = readArray()
        val start = maxOf(0, entries.length() - limit)
        val out = mutableListOf<String>()
        for (i in start until entries.length()) {
            val item = entries.optJSONObject(i) ?: continue
            out.add(item.optString("at") + "  " + item.optString("level") + "  " + item.optString("message"))
        }
        return out
    }

    @Synchronized
    fun lastError(): String? {
        val entries = readArray()
        for (i in entries.length() - 1 downTo 0) {
            val item = entries.optJSONObject(i) ?: continue
            if (item.optString("level") != "INFO") return item.optString("message")
        }
        return null
    }

    @Synchronized
    fun clear() {
        prefs.edit().remove(KEY).apply()
    }

    private fun readArray(): JSONArray {
        val raw = prefs.getString(KEY, "[]") ?: "[]"
        return try { JSONArray(raw) } catch (_: Exception) { JSONArray() }
    }
}

/** Records an uncaught crash so the next launch can show it instead of losing the cause. */
object HabitatCrashHandler {
    fun install(context: Context) {
        val appContext = context.applicationContext
        val diagnostics = BridgeDiagnostics(appContext)
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        if (previous is RecordingHandler) return
        Thread.setDefaultUncaughtExceptionHandler(RecordingHandler(diagnostics, previous))
    }

    private class RecordingHandler(
        private val diagnostics: BridgeDiagnostics,
        private val previous: Thread.UncaughtExceptionHandler?
    ) : Thread.UncaughtExceptionHandler {
        override fun uncaughtException(thread: Thread, error: Throwable) {
            try {
                diagnostics.record(
                    "CRASH",
                    (error.javaClass.simpleName + ": " + (error.message ?: "") + " @ " +
                        error.stackTrace.take(3).joinToString(" < ")).take(400)
                )
            } catch (_: Throwable) {
                // Never mask the original crash.
            }
            previous?.uncaughtException(thread, error)
        }
    }
}
