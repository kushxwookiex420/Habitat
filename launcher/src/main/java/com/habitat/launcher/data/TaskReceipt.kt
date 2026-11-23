package com.habitat.launcher.data

import org.json.JSONObject

data class ReceiptCheck(val name: String, val status: String, val detail: String?)

/**
 * A read-only task receipt. The launcher never retries a task: `POST /tasks/:id/retry` has no
 * authentication, so offering it here would bypass owner control. The sheet says so explicitly.
 */
data class TaskReceipt(
    val id: String,
    val title: String,
    val description: String,
    val status: String,
    val worker: String,
    val createdAt: String?,
    val delegatedAt: String?,
    val completedAt: String?,
    val verifiedAt: String?,
    val error: String?,
    val blockedReason: String?,
    val checks: List<ReceiptCheck>,
    val resultSummary: String?
)

object TaskReceiptParser {
    private val canonicalChecks = listOf(
        "backendHealth" to "Backend health",
        "modelWorker" to "Model worker",
        "androidHeartbeat" to "Android heartbeat",
        "androidDeviceAccess" to "Android device access",
        "taskCreation" to "Task creation",
        "storage" to "Storage"
    )

    fun parseTaskDetail(json: String): TaskReceipt {
        val root = JSONObject(json)
        val task = root.optJSONObject("task") ?: JSONObject()
        val resultText = HabitatParsers.clean(task.optString("result"))
        val result = resultText?.let { runCatching { JSONObject(it) }.getOrNull() }
        val verification = result?.optJSONObject("verification")
        val details = result?.optJSONObject("verificationDetails")

        val checks = canonicalChecks.mapNotNull { (key, label) ->
            val status = verification?.optString(key).orEmpty()
            if (status.isBlank()) return@mapNotNull null
            ReceiptCheck(label, status, HabitatParsers.clean(details?.optJSONObject(key)?.optString("detail")))
        }
        val extraChecks = verification?.keys()?.asSequence()
            ?.filter { key -> canonicalChecks.none { it.first == key } }
            ?.mapNotNull { key ->
                val status = verification.optString(key).orEmpty()
                if (status.isBlank()) null else ReceiptCheck(key, status, null)
            }?.toList().orEmpty()

        return TaskReceipt(
            id = task.optString("id"),
            title = task.optString("title"),
            description = task.optString("description"),
            status = task.optString("status", "unknown"),
            worker = task.optString("worker"),
            createdAt = HabitatParsers.clean(task.optString("createdAt")),
            delegatedAt = HabitatParsers.clean(task.optString("delegatedAt")),
            completedAt = HabitatParsers.clean(task.optString("completedAt")),
            verifiedAt = HabitatParsers.clean(task.optString("verifiedAt")),
            error = HabitatParsers.clean(task.optString("error")),
            blockedReason = result?.let { HabitatParsers.clean(it.optString("blockedReason")) },
            checks = checks + extraChecks,
            resultSummary = summarize(resultText)
        )
    }

    private fun summarize(result: String?): String? {
        val text = result?.trim().orEmpty()
        if (text.isEmpty()) return null
        return text.take(600)
    }
}
