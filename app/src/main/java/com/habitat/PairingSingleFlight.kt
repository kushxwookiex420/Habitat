package com.habitat

/**
 * Admits one pairing exchange at a time and releases the gate on completion, failure,
 * cancellation or an attempt deadline.
 *
 * The dialog re-enables its button after 30 s, so a second tap can arrive while the first
 * request is still running. Two concurrent exchanges of a single-use code race the stored
 * credential against the server's last issued token. This guard makes the overlap impossible and
 * guarantees that a late response cannot release a newer attempt.
 *
 * The deadline matters: if the worker thread is lost, an un-timed gate would reject every retry
 * forever ("pairing permanently locked"). When the deadline fires the gate is released and the
 * caller is told the attempt expired; a response that arrives afterwards is ignored.
 */
class PairingSingleFlight(
    private val attemptTimeoutMs: Long,
    private val schedule: (Runnable, Long) -> Unit
) {
    private val lock = Any()
    private var inFlight = false
    private var epoch = 0L

    /** Returns an attempt token, or null when another attempt owns the gate. */
    fun start(onTimeout: () -> Unit): Long? {
        val token = synchronized(lock) {
            if (inFlight) return null
            inFlight = true
            ++epoch
        }
        // Scheduled outside the lock: a scheduler that runs immediately must not deadlock.
        schedule({ expire(token, onTimeout) }, attemptTimeoutMs)
        return token
    }

    /** True only for the attempt that currently owns the gate. */
    fun isCurrent(token: Long): Boolean = synchronized(lock) { inFlight && token == epoch }

    /**
     * Releases the gate if [token] still owns it. Returns false for an expired or superseded
     * attempt, so its late callback is dropped rather than applied to newer state.
     */
    fun finish(token: Long): Boolean = synchronized(lock) {
        if (!inFlight || token != epoch) return false
        inFlight = false
        true
    }

    fun isInFlight(): Boolean = synchronized(lock) { inFlight }

    private fun expire(token: Long, onTimeout: () -> Unit) {
        val expired = synchronized(lock) {
            if (!inFlight || token != epoch) return
            inFlight = false
            true
        }
        if (expired) onTimeout()
    }
}
