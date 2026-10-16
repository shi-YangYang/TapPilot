package dev.tappilot.agent

/** Bounded event debounce; no nodes are read while waiting for the next observation. */
internal class ObservationSettleWindow(startMs: Long, timeoutMs: Int, initialRevision: Long) {
    private val deadline = startMs + timeoutMs
    private var observedRevision = initialRevision
    private var quietUntil: Long? = null

    fun nextWaitMs(nowMs: Long, revision: Long): Long {
        if (revision != observedRevision) {
            observedRevision = revision
            quietUntil = nowMs + 120
        }
        return (minOf(deadline, quietUntil ?: deadline) - nowMs).coerceAtLeast(0)
    }
}
