package com.habitat.launcher.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HabitatParsersTest {
    @Test
    fun `null blocker is never rendered as the word null`() {
        val json = """{"ok":true,"workers":[{"id":"habitat-qa-worker","name":"QA","status":"available","blockedReason":null,"lastRunAt":null,"jobCount":2,"capabilities":["backend-health"]}]}"""
        val workers = HabitatParsers.workers(json)
        assertEquals(1, workers.size)
        assertNull(workers[0].blockedReason)
        assertNull(workers[0].lastRunAt)
        assertEquals(listOf("backend-health"), workers[0].capabilities)
    }

    @Test
    fun `real blocker is preserved`() {
        val json = """{"workers":[{"id":"w","name":"W","status":"blocked","blockedReason":"androidHeartbeat FAIL"}]}"""
        assertEquals("androidHeartbeat FAIL", HabitatParsers.workers(json).single().blockedReason)
    }

    @Test
    fun `presence status parses`() {
        val status = HabitatParsers.status("""{"ok":true,"androidDeviceAccess":"PASS","detail":"1 device","deviceCount":1}""")
        assertTrue(status.ok)
        assertEquals("PASS", status.access)
        assertEquals(1, status.deviceCount)
    }

    @Test
    fun `task error null is absent and limit is honored`() {
        val tasks = (0 until 5).joinToString(",") {
            """{"id":"t$it","title":"Task $it","worker":"qa","status":"queued","error":null,"createdAt":"2026-11-23T00:00:00Z"}"""
        }
        val parsed = HabitatParsers.tasks("""{"ok":true,"tasks":[$tasks]}""", limit = 3)
        assertEquals(3, parsed.size)
        assertNull(parsed[0].error)
        assertEquals("Task 0", parsed[0].title)
    }

    @Test
    fun `malformed payloads do not crash the launcher`() {
        assertEquals(emptyList<WorkerSummary>(), HabitatParsers.workers(JSONObject().toString()))
        assertEquals(emptyList<TaskSummary>(), HabitatParsers.tasks(JSONObject().toString()))
    }
}
