package com.habitat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Concurrency tests for the pairing gate. These exercise the guard directly with a manual
 * scheduler, so they run on a plain JVM (no device) and cover the exits the network worker relies
 * on: normal completion, failure, cancellation, timeout, and a late response after expiry.
 */
class PairingSingleFlightTest {

    private class ManualScheduler {
        val tasks = Collections.synchronizedList(mutableListOf<Pair<Long, Runnable>>())
        fun schedule(action: Runnable, delayMs: Long) {
            tasks.add(delayMs to action)
        }
        fun fireAll() {
            tasks.forEach { (_, action) -> action.run() }
        }
    }

    private fun guard(scheduler: ManualScheduler = ManualScheduler()) =
        PairingSingleFlight(25_000L, scheduler::schedule)

    @Test
    fun `sixteen simultaneous taps admit exactly one attempt`() {
        val gate = guard()
        val barrier = CyclicBarrier(16)
        val winners = AtomicInteger()
        val pool = Executors.newFixedThreadPool(16)
        try {
            val futures = (1..16).map {
                pool.submit {
                    barrier.await(5, TimeUnit.SECONDS)
                    if (gate.start {} != null) winners.incrementAndGet()
                }
            }
            futures.forEach { it.get(5, TimeUnit.SECONDS) }
        } finally {
            pool.shutdownNow()
        }
        assertEquals(1, winners.get())
        assertTrue(gate.isInFlight())
    }

    @Test
    fun `a delayed response holds the gate until it finishes`() {
        val gate = guard()
        val token = gate.start {}
        assertNotNull(token)
        assertNull("a second tap must be refused while the first is in flight", gate.start {})
        assertTrue(gate.finish(token!!))
        assertFalse(gate.isInFlight())
        assertNotNull("the next attempt is admitted after completion", gate.start {})
    }

    @Test
    fun `a timeout releases the gate and reports once`() {
        val scheduler = ManualScheduler()
        val gate = guard(scheduler)
        val timeouts = AtomicInteger()
        val token = gate.start { timeouts.incrementAndGet() }!!

        assertEquals(1, scheduler.tasks.size)
        scheduler.fireAll()

        assertEquals(1, timeouts.get())
        assertFalse(gate.isInFlight())
        assertFalse("a late response is not applied", gate.finish(token))
        assertNotNull("a retry after timeout is admitted", gate.start {})
    }

    @Test
    fun `a late response cannot release a newer attempt`() {
        val scheduler = ManualScheduler()
        val gate = guard(scheduler)
        val first = gate.start {}!!
        scheduler.fireAll() // first attempt expires

        val second = gate.start {}!!
        assertEquals("the older attempt must not disturb the newer one", false, gate.finish(first))
        assertTrue(gate.isInFlight())
        assertTrue(gate.finish(second))
    }

    @Test
    fun `a stale timeout timer cannot release a newer attempt`() {
        val scheduler = ManualScheduler()
        val gate = guard(scheduler)
        val first = gate.start {}!!
        assertTrue(gate.finish(first)) // normal completion, timer still queued
        val staleTimer = scheduler.tasks.single().second

        val second = gate.start {}!!
        staleTimer.run() // only the first attempt's timer fires late

        assertTrue("the newer attempt still owns the gate", gate.isInFlight())
        assertTrue(gate.finish(second))
    }

    @Test
    fun `failure and cancellation both release the gate`() {
        val gate = guard()
        val failed = gate.start {}!!
        assertTrue("HTTP failure path releases the gate", gate.finish(failed))
        val cancelled = gate.start {}!!
        assertTrue("cancellation path releases the gate", gate.finish(cancelled))
        assertNotNull(gate.start {})
    }

    @Test
    fun `finish is idempotent and cannot steal the next attempt`() {
        val gate = guard()
        val token = gate.start {}!!
        assertTrue(gate.finish(token))
        assertFalse("a repeated finish must not affect state", gate.finish(token))
        val next = gate.start {}!!
        assertFalse("the old token cannot release the new attempt", gate.finish(token))
        assertTrue(gate.finish(next))
    }

    @Test
    fun `expiry callback is not invoked after a normal completion`() {
        val scheduler = ManualScheduler()
        val gate = guard(scheduler)
        val timeouts = AtomicInteger()
        val token = gate.start { timeouts.incrementAndGet() }!!
        assertTrue(gate.finish(token))
        scheduler.fireAll()
        assertEquals(0, timeouts.get())
    }
}
