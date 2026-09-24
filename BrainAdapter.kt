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
            "https://habitat-cr46.onrender.com/chat"
    }

    private val executor =
        Executors.newSingleThreadExecutor()

    fun endpoint(): String {
        return LIVE_ENDPOINT
    }

    fun setEndpoint(value: String) {
        // Intentionally ignored.
        // Habitat always uses the current live brain endpoint.
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
                val url = URL(LIVE_ENDPOINT)

                connection =
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
                    stream
                        ?.bufferedReader()
                        ?.use { it.readText() }
                        ?: ""

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

            } finally {
                connection?.disconnect()
            }
        }
    }

    fun shutdown() {
        executor.shutdownNow()
    }
}
