package com.habitat

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors

class BrainAdapter(private val context: Context) {
    enum class State { CONNECTED, DISCONNECTED, ERROR, CONNECTING }
    data class Result(val state: State, val text: String = "", val detail: String = "")
    companion object {
        private const val LIVE_ENDPOINT = "https://habitat-1-szzd.onrender.com/chat"
        private const val DROPPILOT_ENDPOINT = "https://habitat-1-szzd.onrender.com/orchestrate/dropilot"
        private const val PREFS = "habitat_brain"
        private const val HISTORY_KEY = "conversation_history"
        private const val MAX_HISTORY = 20
    }
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val executor = Executors.newSingleThreadExecutor()

    fun endpoint(): String = LIVE_ENDPOINT

    private fun loadHistory(): JSONArray {
        val saved = prefs.getString(HISTORY_KEY, "[]") ?: "[]"
        return try { JSONArray(saved) } catch (_: Exception) { JSONArray() }
    }

    private fun saveHistory(history: JSONArray) {
        prefs.edit().putString(HISTORY_KEY, history.toString()).apply()
    }

    private fun addToHistory(userMessage: String, assistantMessage: String) {
        val history = loadHistory()
        history.put(JSONObject().apply {
            put("user", userMessage)
            put("assistant", assistantMessage)
        })
        while (history.length() > MAX_HISTORY) history.remove(0)
        saveHistory(history)
    }

    fun clearMemory() { prefs.edit().remove(HISTORY_KEY).apply() }

    fun sendDropPilot(mission: String, storeContext: JSONObject, callback: (Result) -> Unit) {
        callback(Result(State.CONNECTING))
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = URL(DROPPILOT_ENDPOINT).openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 15000
                connection.readTimeout = 90000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Accept", "application/json")
                val body = JSONObject().apply {
                    put("mission", mission)
                    put("storeContext", storeContext)
                }.toString()
                connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val responseText = stream?.bufferedReader()?.use { it.readText() } ?: ""
                if (code !in 200..299) {
                    callback(Result(State.ERROR, detail = "HTTP $code: $responseText"))
                    return@execute
                }
                val json = JSONObject(responseText)
                val synthesis = json.optString("synthesis", "")
                if (synthesis.isBlank()) {
                    callback(Result(State.ERROR, detail = "DropPilot returned no synthesis."))
                    return@execute
                }
                callback(Result(State.CONNECTED, text = synthesis))
            } catch (e: Exception) {
                callback(Result(State.ERROR, detail = e.message ?: e.javaClass.simpleName))
            } finally {
                connection?.disconnect()
            }
        }
    }


    fun send(message: String, callback: (Result) -> Unit) {
        callback(Result(State.CONNECTING))
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = URL(LIVE_ENDPOINT).openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 15000
                connection.readTimeout = 120000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Accept", "application/json")
                val body = JSONObject().apply {
                    put("message", message)
                    put("history", loadHistory())
                }.toString()
                connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val responseText = stream?.bufferedReader()?.use { it.readText() } ?: ""
                if (code !in 200..299) {
                    callback(Result(State.ERROR, detail = "HTTP $code: $responseText"))
                    return@execute
                }
                val parsed = JSONObject(responseText)
                var reply = parsed.optString("response",
                    parsed.optString("message",
                        parsed.optString("content", "")))

                // Defense in depth: never display provider safety/status
                // metadata as though it were Ax's conversational reply.
                if (reply.trim().equals("usersafety: safe", ignoreCase = true)) {
                    reply = "Yes — Ax is online and the Habitat brain is connected. I'm ready to work."
                }

                if (reply.isBlank()) {
                    callback(Result(State.ERROR, detail = "Brain returned an empty response."))
                    return@execute
                }
                addToHistory(message, reply)
                callback(Result(State.CONNECTED, text = reply))
            } catch (e: Exception) {
                callback(Result(State.ERROR, detail = e.message ?: e.javaClass.simpleName))
            } finally {
                connection?.disconnect()
            }
        }
    }

    fun shutdown() { executor.shutdownNow() }
}
