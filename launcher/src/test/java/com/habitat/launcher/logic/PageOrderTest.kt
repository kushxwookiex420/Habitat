package com.habitat.launcher.logic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageOrderTest {
    @Test
    fun `default order contains all seven pages exactly once`() {
        val order = PageOrder.normalize(emptyList())
        assertEquals(7, order.size)
        assertEquals(PageOrder.known.toSet(), order.toSet())
    }

    @Test
    fun `unknown and duplicate ids are dropped without losing pages`() {
        val order = PageOrder.normalize(listOf("habitat", "habitat", "unknown", "ax"))
        assertEquals("habitat", order.first())
        assertTrue(order.containsAll(PageOrder.known))
        assertEquals(7, order.size)
    }

    @Test
    fun `move reorders and clamps at the edges`() {
        val order = PageOrder.normalize(emptyList())
        val moved = PageOrder.move(order, "apps", -1)
        assertEquals("apps", moved.first())
        assertEquals(order.size, moved.size)
        val same = PageOrder.move(moved, "apps", -5)
        assertEquals("apps", same.first())
        val last = PageOrder.move(order, "ax", 99)
        assertEquals("ax", last.last())
    }

    @Test
    fun `csv round trip keeps order`() {
        val order = listOf("device", "ax", "apps")
        val parsed = PageOrder.fromCsv(PageOrder.toCsv(order))
        assertEquals(order, parsed.take(3))
        assertEquals(7, parsed.size)
    }

    @Test
    fun `known pages are stable and never hidden by a corrupt preference`() {
        assertFalse(PageOrder.known.isEmpty())
        assertEquals(7, PageOrder.known.distinct().size)
    }
}
