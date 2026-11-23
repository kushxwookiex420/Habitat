package com.habitat

import android.content.Context
import android.os.Build
import java.util.UUID
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
        private const val VICECITY_ENDPOINT = "https://habitat-1-szzd.onrender.com/orchestrate/vicecity"
        private const val TASKS_ENDPOINT = "https://habitat-1-szzd.onrender.com/tasks"
        private const val WORKERS_ENDPOINT = "https://habitat-1-szzd.onrender.com/workers"
        private const val DEVICE_HEARTBEAT_ENDPOINT = "https://habitat-1-szzd.onrender.com/device/heartbeat"
        private const val DEVICE_ID_KEY = "android_device_id"
        private const val PREFS = "habitat_brain"
        private const val HISTORY_KEY = "conversation_history"
        private const val MAX_HISTORY = 20
    }

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun deviceId(): String = prefs.getString(DEVICE_ID_KEY, null) ?: UUID.randomUUID().toString().also { prefs.edit().putString(DEVICE_ID_KEY, it).apply() }

    fun heartbeat(callback: ((Boolean, String) -> Unit)? = null) {
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = HabitatNetwork.openConnection(DEVICE_HEARTBEAT_ENDPOINT)
                connection.requestMethod = "POST"
                connection.connectTimeout = 10000
                connection.readTimeout = 10000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Accept", "application/json")
                val body = JSONObject().apply {
                    put("deviceId", deviceId())
                    put("packageName", context.packageName)
                    put("deviceModel", Build.MODEL ?: "Android")
                    put("appVersion", try { context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unknown" } catch (_: Exception) { "unknown" })
                }.toString()
                connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
                callback?.invoke(code in 200..299, text)
            } catch (e: Exception) {
                callback?.invoke(false, e.message ?: e.javaClass.simpleName)
            } finally { connection?.disconnect() }
        }
    }
    private val executor = Executors.newSingleThreadExecutor()

    /**
     * Android's org.json returns the literal "null" for a JSON null, which is exactly how the UI
     * ended up showing "Worker error: null". Absent, null and "null" all mean no error.
     */
    private fun optText(obj: JSONObject, key: String): String {
        if (!obj.has(key) || obj.isNull(key)) return ""
        val value = obj.optString(key, "").trim()
        return if (value == "null" || value == "undefined") "" else value
    }

    private fun postJson(url: String, body: String = "{}"): Pair<Int, String> {
        val connection = HabitatNetwork.openConnection(url)
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15000
            connection.readTimeout = 180000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Accept", "application/json")
            connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            return code to (stream?.bufferedReader()?.use { it.readText() } ?: "")
        } finally {
            connection.disconnect()
        }
    }

    /** Reads the read-only worker detail endpoint and renders every real field it returned. */
    fun fetchWorkerDetail(workerId: String, callback: (Result) -> Unit) {
        callback(Result(State.CONNECTING))
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = HabitatNetwork.openConnection("$WORKERS_ENDPOINT/$workerId")
                connection.requestMethod = "GET"
                connection.connectTimeout = 10000
                connection.readTimeout = 20000
                connection.setRequestProperty("Accept", "application/json")
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
                val worker = try { JSONObject(text).optJSONObject("worker") } catch (_: Exception) { null }
                if (code !in 200..299 || worker == null) {
                    callback(Result(State.ERROR, detail = "Worker detail failed: HTTP $code"))
                    return@execute
                }
                val lines = mutableListOf<String>()
                lines.add("STATUS: " + worker.optString("status", "unknown").uppercase())
                lines.add("KIND: " + worker.optString("kind", "worker"))
                optText(worker, "model").takeIf { it.isNotEmpty() }?.let { lines.add("MODEL: $it") }
                val blocked = optText(worker, "blockedReason")
                if (blocked.isNotEmpty()) lines.add("BLOCKED: $blocked")
                val capabilities = worker.optJSONArray("capabilities")
                if (capabilities != null && capabilities.length() > 0) {
                    val names = (0 until capabilities.length()).map { capabilities.optString(it) }.filter { it.isNotBlank() }
                    lines.add("CAPABILITIES: " + names.joinToString(", "))
                }
                val runtime = worker.optJSONObject("runtime")
                if (runtime != null) {
                    lines.add("RUNTIME: jobs=${runtime.optInt("jobCount", 0)} verified=${runtime.optInt("verified", 0)} blocked=${runtime.optInt("blocked", 0)} failed=${runtime.optInt("failed", 0)}")
                    if (!runtime.isNull("lastRunAt")) lines.add("LAST RUN: " + optText(runtime, "lastRunAt") + " (" + optText(runtime, "lastStatus") + ")")
                }
                val controls = worker.optJSONObject("controls")
                val canRetry = controls?.optBoolean("canRetry", false) == true
                val canRun = controls?.optBoolean("canRunCheck", false) == true
                lines.add("CAN RETRY: " + if (canRetry) "YES" else "NO")
                lines.add("CAN RUN CHECK: " + if (canRun) "YES" else "NO")
                if (canRetry) optText(controls ?: JSONObject(), "retryTaskId").takeIf { it.isNotEmpty() }?.let { lines.add("RETRY TASK: $it") }
                val jobs = worker.optJSONArray("jobs")
                if (jobs != null) {
                    lines.add("")
                    lines.add("RECENT JOBS")
                    for (index in 0 until jobs.length()) {
                        val job = jobs.optJSONObject(index) ?: continue
                        val error = optText(job, "error")
                        lines.add("• " + job.optString("status", "unknown").uppercase() + "  " + job.optString("title", job.optString("id")) + (if (error.isNotEmpty()) " — " + error else ""))
                    }
                }
                val logs = worker.optJSONArray("logs")
                if (logs != null && logs.length() > 0) {
                    lines.add("")
                    lines.add("EXECUTION LOG")
                    for (index in 0 until logs.length()) lines.add(logs.optString(index))
                }
                callback(Result(State.CONNECTED, text = lines.joinToString("\n")))
            } catch (e: Exception) {
                callback(Result(State.ERROR, detail = e.message ?: e.javaClass.simpleName))
            } finally {
                connection?.disconnect()
            }
        }
    }

    /** Retry + dispatch an existing failed worker job through the real task endpoints. */
    fun retryWorkerTask(taskId: String, callback: (Result) -> Unit) {
        executor.execute {
            try {
                val retry = postJson("$TASKS_ENDPOINT/$taskId/retry")
                if (retry.first !in 200..299) {
                    callback(Result(State.ERROR, detail = "Retry refused: HTTP ${retry.first} ${retry.second.take(200)}"))
                    return@execute
                }
                val dispatch = postJson("$TASKS_ENDPOINT/$taskId/delegate")
                val task = try { JSONObject(dispatch.second).optJSONObject("task") } catch (_: Exception) { null }
                val status = task?.optString("status", "unknown") ?: "unknown"
                val error = task?.let { optText(it, "error") }.orEmpty()
                callback(
                    Result(
                        if (dispatch.first in 200..299) State.CONNECTED else State.ERROR,
                        text = "RETRY RESULT\nStatus: $status" + (if (error.isNotEmpty()) "\nError: $error" else ""),
                        detail = if (dispatch.first in 200..299) "" else "HTTP ${dispatch.first}"
                    )
                )
            } catch (e: Exception) {
                callback(Result(State.ERROR, detail = e.message ?: e.javaClass.simpleName))
            }
        }
    }

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

    fun clearMemory() {
        prefs.edit().remove(HISTORY_KEY).apply()
    }

    fun sendDropPilot(
        mission: String,
        storeContext: JSONObject,
        callback: (Result) -> Unit
    ) {
        callback(Result(State.CONNECTING))
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = HabitatNetwork.openConnection(DROPPILOT_ENDPOINT)
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

                connection.outputStream.use {
                    it.write(body.toByteArray(StandardCharsets.UTF_8))
                }

                val code = connection.responseCode
                val stream =
                    if (code in 200..299) connection.inputStream
                    else connection.errorStream

                val responseText =
                    stream?.bufferedReader()?.use { it.readText() } ?: ""

                if (code !in 200..299) {
                    callback(
                        Result(
                            State.ERROR,
                            detail = "HTTP $code: $responseText"
                        )
                    )
                    return@execute
                }

                val json = JSONObject(responseText)
                val synthesis = json.optString("synthesis", "")

                if (synthesis.isBlank()) {
                    callback(
                        Result(
                            State.ERROR,
                            detail = "DropPilot returned no synthesis."
                        )
                    )
                    return@execute
                }

                callback(Result(State.CONNECTED, text = synthesis))
            } catch (e: Exception) {
                callback(
                    Result(
                        State.ERROR,
                        detail = e.message ?: e.javaClass.simpleName
                    )
                )
            } finally {
                connection?.disconnect()
            }
        }
    }

    fun sendViceCity(
        mission: String,
        channelContext: JSONObject,
        callback: (Result) -> Unit
    ) {
        callback(Result(State.CONNECTING))
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = HabitatNetwork.openConnection(VICECITY_ENDPOINT)
                connection.requestMethod = "POST"
                connection.connectTimeout = 15000
                connection.readTimeout = 120000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Accept", "application/json")

                val body = JSONObject().apply {
                    put("mission", mission)
                    put("channelContext", channelContext)
                }.toString()

                connection.outputStream.use {
                    it.write(body.toByteArray(StandardCharsets.UTF_8))
                }

                val code = connection.responseCode
                val stream =
                    if (code in 200..299) connection.inputStream
                    else connection.errorStream

                val responseText =
                    stream?.bufferedReader()?.use { it.readText() } ?: ""

                if (code !in 200..299) {
                    callback(
                        Result(
                            State.ERROR,
                            detail = "HTTP $code: $responseText"
                        )
                    )
                    return@execute
                }

                val json = JSONObject(responseText)
                val synthesis = json.optString("synthesis", "")

                if (synthesis.isBlank()) {
                    callback(
                        Result(
                            State.ERROR,
                            detail = "Vice City operator returned no synthesis."
                        )
                    )
                    return@execute
                }

                callback(Result(State.CONNECTED, text = synthesis))
            } catch (e: Exception) {
                callback(
                    Result(
                        State.ERROR,
                        detail = e.message ?: e.javaClass.simpleName
                    )
                )
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
                connection = HabitatNetwork.openConnection(LIVE_ENDPOINT)
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

                connection.outputStream.use {
                    it.write(body.toByteArray(StandardCharsets.UTF_8))
                }

                val code = connection.responseCode
                val stream =
                    if (code in 200..299) connection.inputStream
                    else connection.errorStream

                val responseText =
                    stream?.bufferedReader()?.use { it.readText() } ?: ""

                if (code !in 200..299) {
                    callback(
                        Result(
                            State.ERROR,
                            detail = "HTTP $code: $responseText"
                        )
                    )
                    return@execute
                }

                val parsed = JSONObject(responseText)

                var reply = parsed.optString(
                    "response",
                    parsed.optString(
                        "message",
                        parsed.optString("content", "")
                    )
                )

                if (reply.trim().equals(
                        "usersafety: safe",
                        ignoreCase = true
                    )
                ) {
                    reply =
                        "Yes — Ax is online and the Habitat brain is connected. I'm ready to work."
                }

                if (reply.isBlank()) {
                    callback(
                        Result(
                            State.ERROR,
                            detail = "Brain returned an empty response."
                        )
                    )
                    return@execute
                }

                addToHistory(message, reply)
                callback(Result(State.CONNECTED, text = reply))
            } catch (e: Exception) {
                callback(
                    Result(
                        State.ERROR,
                        detail = e.message ?: e.javaClass.simpleName
                    )
                )
            } finally {
                connection?.disconnect()
            }
        }
    }

    fun createTask(
        title: String,
        description: String,
        callback: (Result) -> Unit
    ) {
        callback(Result(State.CONNECTING))
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = HabitatNetwork.openConnection(TASKS_ENDPOINT)
                connection.requestMethod = "POST"
                connection.connectTimeout = 10000
                connection.readTimeout = 30000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")

                val body = JSONObject().apply {
                    put("title", title)
                    put("description", description)
                }.toString()

                connection.outputStream.use {
                    it.write(body.toByteArray(StandardCharsets.UTF_8))
                }

                val code = connection.responseCode
                val stream =
                    if (code in 200..299) connection.inputStream
                    else connection.errorStream

                val responseText =
                    stream?.bufferedReader()?.use { it.readText() } ?: ""

                if (code !in 200..299) {
                    callback(
                        Result(
                            State.ERROR,
                            detail = "HTTP $code: $responseText"
                        )
                    )
                    return@execute
                }

                val json = JSONObject(responseText)
                val task = json.optJSONObject("task")

                if (task == null) {
                    callback(
                        Result(
                            State.ERROR,
                            detail = "Task service returned no task."
                        )
                    )
                    return@execute
                }

                callback(Result(State.CONNECTED, text = task.toString()))
            } catch (e: Exception) {
                callback(
                    Result(
                        State.ERROR,
                        detail = e.message ?: e.javaClass.simpleName
                    )
                )
            } finally {
                connection?.disconnect()
            }
        }
    }

    fun findLatestSystemCheck(callback: (Result) -> Unit) {
        callback(Result(State.CONNECTING))
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = HabitatNetwork.openConnection(TASKS_ENDPOINT)
                connection.requestMethod = "GET"
                connection.connectTimeout = 10000
                connection.readTimeout = 30000
                connection.setRequestProperty("Accept", "application/json")

                val code = connection.responseCode
                val stream =
                    if (code in 200..299) connection.inputStream
                    else connection.errorStream

                val responseText =
                    stream?.bufferedReader()?.use { it.readText() } ?: ""

                if (code !in 200..299) {
                    callback(
                        Result(
                            State.ERROR,
                            detail = "HTTP $code: $responseText"
                        )
                    )
                    return@execute
                }

                val json = JSONObject(responseText)
                val tasks = json.optJSONArray("tasks") ?: JSONArray()

                var best: JSONObject? = null

                for (i in 0 until tasks.length()) {
                    val task = tasks.optJSONObject(i) ?: continue

                    if (!task.optString("title")
                            .equals("System Check", ignoreCase = true)
                    ) {
                        continue
                    }

                    if (
                        best == null ||
                        task.optString("createdAt") >
                        best!!.optString("createdAt")
                    ) {
                        best = task
                    }
                }

                if (
                    best == null ||
                    best!!.optString("id").isBlank()
                ) {
                    callback(
                        Result(
                            State.ERROR,
                            detail = "No System Check task exists on the live task service."
                        )
                    )
                } else {
                    callback(
                        Result(
                            State.CONNECTED,
                            text = best!!.toString()
                        )
                    )
                }
            } catch (e: Exception) {
                callback(
                    Result(
                        State.ERROR,
                        detail = e.message ?: e.javaClass.simpleName
                    )
                )
            } finally {
                connection?.disconnect()
            }
        }
    }

    fun delegateTask(
        taskId: String,
        callback: (Result) -> Unit
    ) {
        callback(Result(State.CONNECTING))
        executor.execute {
            var connection: HttpURLConnection? = null

            try {
                connection =
                    URL("$TASKS_ENDPOINT/$taskId/delegate")
                        .openConnection() as HttpURLConnection

                connection.requestMethod = "POST"
                connection.connectTimeout = 10000

                // Increased from 90 seconds to 180 seconds.
                // The free model worker can take longer than 90 seconds.
                connection.readTimeout = 180000

                connection.doOutput = true
                connection.setRequestProperty(
                    "Content-Type",
                    "application/json"
                )

                connection.outputStream.use {
                    it.write("{}".toByteArray(StandardCharsets.UTF_8))
                }

                val code = connection.responseCode

                val stream =
                    if (code in 200..299) connection.inputStream
                    else connection.errorStream

                val responseText =
                    stream?.bufferedReader()?.use { it.readText() } ?: ""

                val json =
                    try {
                        JSONObject(responseText)
                    } catch (_: Exception) {
                        JSONObject()
                    }

                val task = json.optJSONObject("task")

                if (code !in 200..299 || task == null) {
                    callback(
                        Result(
                            State.ERROR,
                            detail =
                                "Worker execution failed: HTTP $code $responseText"
                        )
                    )
                    return@execute
                }

                val status = optText(task, "status").ifEmpty { "unknown" }
                val worker = optText(task, "worker").ifEmpty { "unknown" }
                val result = optText(task, "result")
                val error = optText(task, "error")

                // The task result is authoritative machine data. Do not display
                // the model's supplemental workerReport as if it were a failed
                // device/QA check. Older builds did exactly that and produced
                // contradictory "UNVERIFIED" text even when the machine checks
                // were PASS.
                val resultJson = try { JSONObject(result) } catch (_: Exception) { null }
                val canonical = resultJson?.optJSONObject("verification")
                val verificationDetails = resultJson?.optJSONObject("verificationDetails")
                val blockedReason = resultJson?.let { optText(it, "blockedReason") }.orEmpty()

                val text = buildString {
                    append("SYSTEM CHECK\n")
                    append("Status: ")
                    append(status)
                    append("\n")
                    append("Worker: ")
                    append(worker)
                    append("\n")

                    if (canonical != null) {
                        append("\nCANONICAL MACHINE CHECKS:\n")
                        append("Backend health: ")
                        append(canonical.optString("backendHealth", "UNKNOWN"))
                        append("\n")
                        append("Model worker: ")
                        append(canonical.optString("modelWorker", "UNKNOWN"))
                        append("\n")
                        append("Android heartbeat: ")
                        append(canonical.optString("androidHeartbeat", "UNKNOWN"))
                        append("\n")
                        append("Android device access: ")
                        append(canonical.optString("androidDeviceAccess", "UNKNOWN"))
                        append("\n")
                        append("Task creation: ")
                        append(canonical.optString("taskCreation", "UNKNOWN"))
                        append("\n")
                        append("Storage: ")
                        append(canonical.optString("storage", "UNKNOWN"))
                        append("\n")
                        append("\nCANONICAL RESULT: ")
                        append(
                            if (
                                canonical.optString("backendHealth") == "PASS" &&
                                canonical.optString("modelWorker") == "PASS" &&
                                canonical.optString("androidHeartbeat") == "PASS" &&
                                canonical.optString("androidDeviceAccess") == "PASS" &&
                                canonical.optString("taskCreation") == "PASS" &&
                                canonical.optString("storage") == "PASS" &&
                                status.equals("verified", ignoreCase = true)
                            ) "VERIFIED PASS" else "PARTIAL / BLOCKED"
                        )
                        append("\n")
                    } else if (result.isNotBlank()) {
                        append("\nWorker result:\n")
                        append(result)
                    }

                    // A BLOCKED result must say which subsystem failed. Without this the phone
                    // showed only "BLOCKED" and a null error placeholder.
                    if (verificationDetails != null) {
                        val detailLines = listOf("backendHealth", "modelWorker", "androidHeartbeat", "androidDeviceAccess", "taskCreation", "storage")
                            .mapNotNull { key ->
                                val entry = verificationDetails.optJSONObject(key) ?: return@mapNotNull null
                                val detail = optText(entry, "detail")
                                if (detail.isEmpty()) null else "• " + detail
                            }
                        if (detailLines.isNotEmpty()) {
                            append("\nCHECK DETAIL:\n")
                            detailLines.forEach { append(it).append("\n") }
                        }
                    }
                    if (blockedReason.isNotEmpty()) {
                        append("\nBLOCKED BECAUSE:\n")
                        append(blockedReason)
                        append("\n")
                    }
                    if (error.isNotBlank()) {
                        append("\nWorker error:\n")
                        append(error)
                    }
                }

                callback(
                    Result(
                        State.CONNECTED,
                        text = text
                    )
                )
            } catch (e: Exception) {
                callback(
                    Result(
                        State.ERROR,
                        detail = e.message ?: e.javaClass.simpleName
                    )
                )
            } finally {
                connection?.disconnect()
            }
        }
    }

    fun runEndToEndTest(callback: (Result) -> Unit) {
        callback(Result(State.CONNECTING))

        executor.execute {
            createTask(
                "AX End-to-End Test",
                "Verify backend health, model worker response, task creation, and return the combined verification result to Habitat."
            ) { created ->

                if (created.state != State.CONNECTED) {
                    callback(
                        Result(
                            State.ERROR,
                            detail =
                                "Task creation failed: " +
                                    created.detail
                        )
                    )
                    return@createTask
                }

                try {
                    val task = JSONObject(created.text)

                    val id =
                        task.optString("id", "")

                    if (id.isBlank()) {
                        callback(
                            Result(
                                State.ERROR,
                                detail =
                                    "Task creation returned no task ID."
                            )
                        )
                        return@createTask
                    }

                    delegateTask(id) { delegated ->

                        if (delegated.state != State.CONNECTED) {
                            callback(
                                Result(
                                    State.ERROR,
                                    detail = delegated.detail
                                )
                            )
                        } else {
                            callback(
                                Result(
                                    State.CONNECTED,
                                    text =
                                        "AX END-TO-END TEST\n\n" +
                                            "Task created: PASS\n" +
                                            "Task ID: " +
                                            id +
                                            "\n\n" +
                                            delegated.text
                                )
                            )
                        }
                    }
                } catch (e: Exception) {
                    callback(
                        Result(
                            State.ERROR,
                            detail =
                                e.message ?: e.javaClass.simpleName
                        )
                    )
                }
            }
        }
    }

    fun tiktokCreatorInfo(callback: (Result) -> Unit) {
        callback(Result(State.CONNECTING))
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = HabitatNetwork.openConnection("https://habitat-1-szzd.onrender.com/content/publisher/creator-info")
                connection.requestMethod = "POST"; connection.connectTimeout = 10000; connection.readTimeout = 30000
                connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write("{}".toByteArray(StandardCharsets.UTF_8)) }
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
                if (code !in 200..299) callback(Result(State.ERROR, detail = "HTTP " + code + ": " + body))
                else callback(Result(State.CONNECTED, text = body))
            } catch (e: Exception) { callback(Result(State.ERROR, detail = e.message ?: e.javaClass.simpleName)) }
            finally { connection?.disconnect() }
        }
    }

    fun tiktokApproveAndPublish(jobId: String, title: String, privacyLevel: String, allowComment: Boolean, allowDuet: Boolean, allowStitch: Boolean, userConsent: Boolean, callback: (Result) -> Unit) {
        callback(Result(State.CONNECTING))
        executor.execute {
            try {
                val payload = JSONObject().apply {
                    put("privacyLevel", privacyLevel); put("userConsent", userConsent)
                    put("allowComment", allowComment); put("allowDuet", allowDuet); put("allowStitch", allowStitch)
                    if (title.isNotBlank()) put("title", title)
                }
                val approve = postJson("https://habitat-1-szzd.onrender.com/content/jobs/" + jobId + "/approve-publish", payload)
                if (approve.first !in 200..299) { callback(Result(State.ERROR, detail = "Approval HTTP " + approve.first + ": " + approve.second)); return@execute }
                val publish = postJson("https://habitat-1-szzd.onrender.com/content/jobs/" + jobId + "/publish", payload)
                if (publish.first !in 200..299) { callback(Result(State.ERROR, detail = "Publish HTTP " + publish.first + ": " + publish.second)); return@execute }
                callback(Result(State.CONNECTED, text = publish.second))
            } catch (e: Exception) { callback(Result(State.ERROR, detail = e.message ?: e.javaClass.simpleName)) }
        }
    }

    private fun postJson(url: String, body: JSONObject): Pair<Int, String> {
        var connection: HttpURLConnection? = null
        try {
            connection = HabitatNetwork.openConnection(url)
            connection.requestMethod = "POST"; connection.connectTimeout = 10000; connection.readTimeout = 120000
            connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json"); connection.setRequestProperty("Accept", "application/json")
            connection.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            return code to (stream?.bufferedReader()?.use { it.readText() } ?: "")
        } finally { connection?.disconnect() }
    }
    fun shutdown() {
        executor.shutdownNow()
    }
}
