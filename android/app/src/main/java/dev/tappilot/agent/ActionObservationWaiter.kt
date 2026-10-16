package dev.tappilot.agent

/** A callback-owned outcome; waiting for it never blocks Android's main looper. */
internal class GestureCompletion {
    enum class State { PENDING, COMPLETED, CANCELLED }
    @Volatile var state = State.PENDING
        private set

    fun finish(cancelled: Boolean) {
        if (state == State.PENDING) state = if (cancelled) State.CANCELLED else State.COMPLETED
    }
}

/** Event-driven post-action reads. This class cannot dispatch or repeat an action. */
internal class ActionObservationWaiter(
    private val now: () -> Long,
    private val revision: () -> Long,
    private val checkActive: () -> Unit,
    private val waitForSignal: (observedRevision: Long, maxWaitMs: Long) -> Unit,
) {
    fun <T> observeAfterAction(since: Long, waitMs: Int, deadline: Long, gesture: GestureCompletion?, gestureDeadline: Long, read: () -> T): T {
        if (gesture != null) awaitGesture(gesture, minOf(deadline, gestureDeadline))
        return observe(if (gesture != null) revision() else since, minOf(deadline, now() + waitMs), read)
    }

    private fun awaitGesture(completion: GestureCompletion, deadline: Long) {
        while (true) {
            val beforeWait = revision()
            checkActive()
            when (completion.state) {
                GestureCompletion.State.COMPLETED -> return
                GestureCompletion.State.CANCELLED -> throw AgentError("GESTURE_CANCELLED", "Android cancelled the accepted gesture. No action was repeated; inspect the current UI.")
                GestureCompletion.State.PENDING -> Unit
            }
            val remaining = deadline - now()
            if (remaining <= 0) throw AgentError("GESTURE_COMPLETION_TIMEOUT", "The gesture was accepted but Android did not report completion in time. Its effect is unknown; no action was repeated.")
            waitForSignal(beforeWait, minOf(remaining, 100L))
        }
    }

    private fun <T> observe(since: Long, deadline: Long, read: () -> T): T {
        settle(since, deadline)
        var reads = 0
        while (true) {
            checkActive()
            val beforeRead = revision()
            try { return read() } catch (error: AgentError) {
                // A transient empty root is common while switching windows. Only reads are
                // retried, only after a new event, and all share the original wait budget.
                if (error.code != "NO_ACTIVE_WINDOW" || ++reads >= 3 || now() >= deadline) throw error
                if (!awaitChange(beforeRead, deadline)) throw error
                settle(beforeRead, deadline)
            }
        }
    }

    private fun settle(since: Long, deadline: Long) {
        val start = now()
        val window = ObservationSettleWindow(start, (deadline - start).coerceAtLeast(0).toInt(), since)
        while (true) {
            checkActive()
            val observed = revision()
            val remaining = window.nextWaitMs(now(), observed)
            if (remaining <= 0) return
            waitForSignal(observed, minOf(remaining, 100L))
        }
    }

    private fun awaitChange(since: Long, deadline: Long): Boolean {
        while (true) {
            checkActive()
            if (revision() != since) return true
            val remaining = deadline - now()
            if (remaining <= 0) return false
            waitForSignal(since, minOf(remaining, 100L))
        }
    }
}
