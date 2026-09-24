package com.habitat.core

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors

class BrainAdapter(private val context: Context) {

    enum class State {
        CONNECTED,
        DISCONNECTED,
        ERROR,
        CONNECTING
    }

    data class Result(
        val state: State,
        val text: String = "",
        val detail: String = ""
    )

    companion object {
        private const val LIVE_ENDPOINT =
            "https://habitat-1-szzd.onrender.com/chat"

        private const val PREFS =
            "habitat_brain"

        private const val HISTORY_KEY =
            "conversation_history"

        private const val MAX_HISTORY =
            20
    }

    private val prefs =
        context.getSharedPreferences(
            PREFS,
            Context.MODE_PRIVATE
        )

    private val executor =
        Executors.newSingleThreadExecutor()

    fun endpoint(): String {
        return LIVE_ENDPOINT
    }

    fun setEndpoint(value: String) {
        // Habitat always uses the live brain endpoint.
    }

    private fun loadHistory(): JSONArray {
        val saved =
            prefs.getString(
                HISTORY_KEY,
                "[]"
            ) ?: "[]"

        return try {
            JSONArray(saved)
        } catch (error: Exception) {
            JSONArray()
        }
    }

    private fun saveHistory(history: JSONArray) {
        prefs.edit()
            .putString(
                HISTORY_KEY,
                history.toString()
            )
            .apply()
    }

    private fun addToHistory(
        userMessage: String,
        assistantMessage: String
    ) {
        val history = loadHistory()

        history.put(
            JSONObject().apply {
                put(
                    "user",
                    userMessage
                )

                put(
                    "assistant",
                    assistantMessage
                )
            }
        )

        while (history.length() > MAX_HISTORY) {
            history.remove(0)
        }

        saveHistory(history)
    }

    fun clearMemory() {
        prefs.edit()
            .remove(HISTORY_KEY)
            .apply()
    }

    fun send(
        message: String,
        callback: (Result) -> Unit
    ) {
        callback(
            Result(
                state = State.CONNECTING
            )
        )

        executor.execute {
            var connection: HttpURLConnection? = null

            try {
                val url =
                    URL(LIVE_ENDPOINT)

                connection =
                    url.openConnection()
                        as HttpURLConnection

                connection.requestMethod =
                    "POST"

                connection.connectTimeout =
                    15000

                connection.readTimeout =
                    60000

                connection.doOutput =
                    true

                connection.setRequestProperty(
                    "Content-Type",
                    "application/json"
                )

                connection.setRequestProperty(
                    "Accept",
                    "application/json"
                )

                val history =
                    loadHistory()

                val body =
                    JSONObject().apply {

                        put(
                            "message",
                            message
                        )

                        put(
                            "history",
                            history
                        )

                    }.toString()

                connection.outputStream.use { output ->
                    output.write(
                        body.toByteArray(
                            StandardCharsets.UTF_8
                        )
                    )
                }

                val responseCode =
                    connection.responseCode

                val stream =
                    if (responseCode in 200..299) {
                        connection.inputStream
                    } else {
                        connection.errorStream
                    }

                val responseText =
                    stream
                        ?.bufferedReader()
                        ?.use {
                            it.readText()
                        }
                        ?: ""

                if (responseCode !in 200..299) {

                    callback(
                        Result(
                            state =
                                State.ERROR,

                            detail =
                                "HTTP $responseCode: $responseText"
                        )
                    )

                    return@execute
                }

                val json =
                    JSONObject(responseText)

                val reply =
                    json.optString(
                        "response",
                        ""
                    )

                if (reply.isBlank()) {

                    callback(
                        Result(
                            state =
                                State.ERROR,

                            detail =
                                "Brain returned an empty response."
                        )
                    )

                    return@execute
                }

                addToHistory(
                    userMessage =
                        message,

                    assistantMessage =
                        reply
                )

                callback(
                    Result(
                        state =
                            State.CONNECTED,

                        text =
                            reply
                    )
                )

            } catch (error: Exception) {

                callback(
                    Result(
                        state =
                            State.ERROR,

                        detail =
                            error.message
                                ?: error.javaClass.simpleName
                    )
                )

            } finally {

                connection?.disconnect()
            }
        }
    }

    fun shutdown() {
        executor.shutdownNow()
    }
}
