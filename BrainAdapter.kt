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
        private const val PREFS = "habitat_brain"
        private const val ENDPOINT_KEY = "endpoint"

        private const val DEFAULT_ENDPOINT =
            "https://habitat-cr46.onrender.com/chat"
    }

    private val prefs =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val executor =
        Executors.newSingleThreadExecutor()

    fun endpoint(): String {
        val saved = prefs.getString(ENDPOINT_KEY, "") ?: ""

        return if (saved.isBlank()) {
            DEFAULT_ENDPOINT
        } else {
            saved
        }
    }

    fun setEndpoint(value: String) {
        prefs.edit()
            .putString(
                ENDPOINT_KEY,
                value.trim()
            )
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
            try {
                val url = URL(endpoint())

                val connection =
                    url.openConnection() as HttpURLConnection

                connection.requestMethod = "POST"
                connection.connectTimeout = 15000
                connection.readTimeout = 30000
                connection.doOutput = true

                connection.setRequestProperty(
                    "Content-Type",
                    "application/json"
                )

                connection.setRequestProperty(
                    "Accept",
                    "application/json"
                )

                val body =
                    JSONObject().apply {
                        put(
                            "message",
                            message
                        )

                        put(
                            "history",
                            JSONArray()
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
                    stream?.bufferedReader()
                        ?.use { it.readText() }
                        ?: ""

                connection.disconnect()

                if (responseCode !in 200..299) {
                    callback(
                        Result(
                            state = State.ERROR,
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
                            state = State.ERROR,
                            detail =
                                "Brain returned an empty response."
                        )
                    )

                    return@execute
                }

                callback(
                    Result(
                        state = State.CONNECTED,
                        text = reply
                    )
                )

            } catch (error: Exception) {

                callback(
                    Result(
                        state = State.ERROR,
                        detail =
                            error.message
                                ?: error.javaClass.simpleName
                    )
                )
            }
        }
    }

    fun shutdown() {
        executor.shutdownNow()
    }
}
