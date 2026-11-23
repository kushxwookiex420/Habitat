package com.habitat.launcher.data

import org.json.JSONArray
import org.json.JSONObject

data class WorkerSummary(
    val id: String,
    val name: String,
    val status: String,
    val blockedReason: String?,
    val lastRunAt: String?,
    val jobCount: Int,
    val capabilities: List<String>
)

data class HabitatStatus(
    val ok: Boolean,
    val access: String,
    val detail: String,
    val deviceCount: Int
)

data class TaskSummary(
    val id: String,
    val title: String,
    val worker: String,
    val status: String,
    val createdAt: String?,
    val error: String?
)

object HabitatParsers {
    /** Android's org.json can surface JSON null as the literal "null"; never show that to a person. */
    fun clean(value: String?): String? {
        val text = value?.trim().orEmpty()
        return if (text.isEmpty() || text == "null" || text == "undefined") null else text
    }

    fun workers(json: String): List<WorkerSummary> {
        val root = JSONObject(json)
        val array = root.optJSONArray("workers") ?: return emptyList()
        return buildList {
            for (index in 0 until array.length()) {
                val worker = array.optJSONObject(index) ?: continue
                val capabilities = mutableListOf<String>()
                worker.optJSONArray("capabilities")?.let { caps ->
                    for (capIndex in 0 until caps.length()) {
                        clean(caps.optString(capIndex))?.let(capabilities::add)
                    }
                }
                add(
                    WorkerSummary(
                        id = worker.optString("id"),
                        name = worker.optString("name"),
                        status = worker.optString("status", "unknown"),
                        blockedReason = clean(worker.optString("blockedReason")),
                        lastRunAt = clean(worker.optString("lastRunAt")),
                        jobCount = worker.optInt("jobCount", 0),
                        capabilities = capabilities
                    )
                )
            }
        }
    }

    fun status(json: String): HabitatStatus {
        val root = JSONObject(json)
        return HabitatStatus(
            ok = root.optBoolean("ok", false),
            access = root.optString("androidDeviceAccess", "UNKNOWN"),
            detail = root.optString("detail", ""),
            deviceCount = root.optInt("deviceCount", 0)
        )
    }

    fun tasks(json: String, limit: Int = 25): List<TaskSummary> {
        val root = JSONObject(json)
        val array = root.optJSONArray("tasks") ?: return emptyList()
        return buildList {
            for (index in 0 until minOf(array.length(), limit)) {
                val task = array.optJSONObject(index) ?: continue
                add(
                    TaskSummary(
                        id = task.optString("id"),
                        title = task.optString("title"),
                        worker = task.optString("worker"),
                        status = task.optString("status", "unknown"),
                        createdAt = clean(task.optString("createdAt")),
                        error = clean(task.optString("error"))
                    )
                )
            }
        }
    }
}
