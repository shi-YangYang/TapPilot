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

/** Bounded post-action reads, woken by events with a local reread fallback.
 * Global event silence is neither required nor proof that an action succeeded.
 * This class cannot dispatch or repeat an action.
 */
internal class ActionObservationWaiter(
    private val now: () -> Long,
    private val revision: () -> Long,
    private val checkActive: () -> Unit,
    private val waitForSignal: (observedRevision: Long, maxWaitMs: Long) -> Unit,
) {
    fun <T> observeAfterAction(since: Long, waitMs: Int, deadline: Long, gesture: GestureCompletion?, gestureDeadline: Long,
                             usable: (T) -> Boolean = { true }, read: () -> T): T {
        if (gesture != null) awaitGesture(gesture, minOf(deadline, gestureDeadline))
        return observe(minOf(deadline, now() + waitMs), usable, read)
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

    private fun <T> observe(deadline: Long, usable: (T) -> Boolean, read: () -> T): T {
        // Allow an accepted action to reach the app, without restarting a quiet
        // period for every unrelated timer/animation accessibility event.
        awaitReadTime(minOf(deadline, now() + 120))
        while (true) {
            checkActive()
            try {
                val value = read()
                checkActive()
                if (usable(value) || now() >= deadline) return value
            } catch (error: AgentError) {
                // A transient root can recover without an accessibility event.
                // Retry only observation under the same budget, never the mutation.
                if (error.code != "NO_ACTIVE_WINDOW" || now() >= deadline) throw error
            }
            awaitReadTime(minOf(deadline, now() + 120))
        }
    }

    private fun awaitReadTime(readAt: Long) {
        while (true) {
            checkActive()
            val observed = revision()
            val remaining = readAt - now()
            if (remaining <= 0) return
            waitForSignal(observed, minOf(remaining, 100L))
        }
    }
}
