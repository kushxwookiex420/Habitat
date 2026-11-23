package com.habitat.launcher.logic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandRouterTest {
    @Test
    fun `page aliases navigate`() {
        assertEquals(CommandResult.Navigate("habitat"), CommandRouter.route("go to habitat"))
        assertEquals(CommandResult.Navigate("apps"), CommandRouter.route("open applications"))
        assertEquals(CommandResult.Navigate("gaming"), CommandRouter.route("games"))
    }

    @Test
    fun `open app keeps the query for a real lookup`() {
        assertEquals(CommandResult.OpenApp("camera"), CommandRouter.route("open camera"))
    }

    @Test
    fun `search and help are distinct`() {
        assertEquals(CommandResult.WebSearch("android launcher"), CommandRouter.route("search android launcher"))
        assertTrue(CommandRouter.route("help") is CommandResult.Reply)
        assertTrue(CommandRouter.route("refresh habitat") is CommandResult.Reply)
    }

    @Test
    fun `unknown commands are reported as unsupported`() {
        val result = CommandRouter.route("make me a sandwich")
        assertTrue(result is CommandResult.Unsupported)
    }

    @Test
    fun `blank input is not treated as success`() {
        assertTrue(CommandRouter.route("   ") is CommandResult.Unsupported)
        assertTrue(CommandRouter.route("open ") is CommandResult.Unsupported)
    }
}
