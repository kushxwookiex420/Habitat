package com.habitat.core

import android.content.Context
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Thin network boundary between Habitat and a future real AI brain.
 * No API key is stored in the app.
 *
 * Expected request JSON:
 * { "message":"...", "source":"Habitat", "client":"Ax" }
 *
 * The response may be JSON with one of: response, reply, message, text.
 * A plain-text response is also accepted.
 */
class BrainAdapter(private val context: Context) {
    enum class State { DISCONNECTED, CONNECTING, CONNECTED, ERROR }

    data class Result(val state: State, val text: String, val detail: String = "")

    private val executor = Executors.newSingleThreadExecutor()

    fun endpoint(): String = context
        .getSharedPreferences("habitat", Context.MODE_PRIVATE)
        .getString("brain_endpoint", "")
        ?.trim()
        .orEmpty()

    fun setEndpoint(value: String) {
        context.getSharedPreferences("habitat", Context.MODE_PRIVATE)
            .edit()
            .putString("brain_endpoint", value.trim())
            .apply()
    }

    fun send(message: String, callback: (Result) -> Unit) {
        val endpoint = endpoint()
        if (endpoint.isBlank()) {
            callback(Result(State.DISCONNECTED, "", "No brain endpoint is configured."))
            return
        }

        executor.execute {
            val result = try {
                post(endpoint, message)
            } catch (e: Exception) {
                Result(State.ERROR, "", e.message ?: "Connection error")
            }
            callback(result)
        }
    }

    fun shutdown() {
        executor.shutdownNow()
    }

    private fun post(endpoint: String, message: String): Result {
        val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 8000
            readTimeout = 15000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            setRequestProperty("Accept", "application/json, text/plain, */*")
        }

        return try {
            val body = JSONObject().apply {
                put("message", message)
                put("source", "Habitat")
                put("client", "Ax")
            }.toString()

            OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { it.write(body) }

            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.let { input ->
                BufferedReader(InputStreamReader(input, Charsets.UTF_8)).use { reader ->
                    buildString {
                        var line: String?
                        while (reader.readLine().also { line = it } != null) append(line)
                    }
                }
            }.orEmpty()

            if (code !in 200..299) {
                Result(State.ERROR, "", "HTTP $code${if (response.isNotBlank()) ": $response" else ""}")
            } else {
                Result(State.CONNECTED, extractText(response).ifBlank { "Brain connected, but returned no text." })
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun extractText(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.isBlank()) return ""
        return try {
            val json = JSONObject(trimmed)
            listOf("response", "reply", "message", "text")
                .firstNotNullOfOrNull { key ->
                    if (json.has(key) && !json.isNull(key)) json.optString(key) else null
                }
                ?: trimmed
        } catch (_: Exception) {
            trimmed
        }
    }
}
