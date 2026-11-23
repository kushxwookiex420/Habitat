package com.habitat.launcher.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/**
 * Habitat's status endpoints are public and read-only, so the launcher never handles an Ax token.
 * Mutating or owner-approved actions are intentionally out of scope here.
 */
class HabitatClient(private val baseUrl: () -> String) {

    suspend fun workers(): Result<String> = get("/workers")

    suspend fun status(): Result<String> = get("/device/status")

    suspend fun tasks(): Result<String> = get("/tasks")

    private suspend fun get(path: String): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val base = baseUrl().trim().trimEnd('/')
            require(base.startsWith("http://") || base.startsWith("https://")) { "Base URL must start with http:// or https://" }
            val connection = URL(base + path).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "GET"
                connection.connectTimeout = 8000
                connection.readTimeout = 12000
                connection.setRequestProperty("Accept", "application/json")
                connection.setRequestProperty("User-Agent", "HabitatLauncher/1.0")
                val code = connection.responseCode
                if (code !in 200..299) {
                    error("HTTP $code from $path")
                }
                connection.inputStream.bufferedReader().use { it.readText() }
            } finally {
                connection.disconnect()
            }
        }
    }
}
