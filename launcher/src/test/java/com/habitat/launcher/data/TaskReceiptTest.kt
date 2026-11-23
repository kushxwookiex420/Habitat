package com.habitat.launcher.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskReceiptTest {
    private fun detail(result: String?): String {
        val task = JSONObject()
            .put("id", "task-123")
            .put("title", "System Check")
            .put("description", "Verify the backend")
            .put("status", "blocked")
            .put("worker", "habitat-qa-worker")
            .put("createdAt", "2026-11-23T05:49:30.362Z")
            .put("delegatedAt", "2026-11-23T05:49:31.000Z")
            .put("completedAt", "2026-11-23T05:50:10.000Z")
            .put("verifiedAt", JSONObject.NULL)
            .put("error", JSONObject.NULL)
            .put("result", result ?: JSONObject.NULL)
        return JSONObject().put("ok", true).put("task", task).toString()
    }

    @Test
    fun `canonical checks, blockers and details are surfaced`() {
        val result = JSONObject()
            .put(
                "verification",
                JSONObject()
                    .put("backendHealth", "PASS")
                    .put("modelWorker", "PASS")
                    .put("androidHeartbeat", "FAIL")
                    .put("androidDeviceAccess", "UNVERIFIED")
                    .put("taskCreation", "PASS")
                    .put("storage", "PASS")
            )
            .put(
                "verificationDetails",
                JSONObject().put(
                    "androidHeartbeat",
                    JSONObject().put("status", "FAIL").put("detail", "No paired Android device checked in within 45 minutes.")
                )
            )
            .put("blockedReason", "androidHeartbeat: No paired Android device checked in.")
            .toString()

        val receipt = TaskReceiptParser.parseTaskDetail(detail(result))
        assertEquals("task-123", receipt.id)
        assertEquals("blocked", receipt.status)
        assertEquals("System Check", receipt.title)
        assertEquals(6, receipt.checks.size)
        val heartbeat = receipt.checks.first { it.name == "Android heartbeat" }
        assertEquals("FAIL", heartbeat.status)
        assertEquals("No paired Android device checked in within 45 minutes.", heartbeat.detail)
        assertEquals("androidHeartbeat: No paired Android device checked in.", receipt.blockedReason)
        assertNull(receipt.error)
        assertNull(receipt.verifiedAt)
        assertTrue(receipt.resultSummary!!.contains("verification"))
    }

    @Test
    fun `a receipt without a result still renders its task fields`() {
        val receipt = TaskReceiptParser.parseTaskDetail(detail(null))
        assertEquals("task-123", receipt.id)
        assertTrue(receipt.checks.isEmpty())
        assertNull(receipt.resultSummary)
        assertNull(receipt.blockedReason)
    }

    @Test
    fun `json null error text is never shown`() {
        val broken = JSONObject()
            .put("task", JSONObject().put("id", "t").put("status", "failed").put("error", "null").put("result", "null"))
        val receipt = TaskReceiptParser.parseTaskDetail(JSONObject().put("ok", true).put("task", broken.getJSONObject("task")).toString())
        assertNull(receipt.error)
        assertNull(receipt.resultSummary)
    }

    @Test
    fun `extra verification keys are preserved`() {
        val result = JSONObject()
            .put("verification", JSONObject().put("backendHealth", "PASS").put("customCheck", "FAIL"))
            .toString()
        val receipt = TaskReceiptParser.parseTaskDetail(detail(result))
        assertTrue(receipt.checks.any { it.name == "customCheck" && it.status == "FAIL" })
    }
}
