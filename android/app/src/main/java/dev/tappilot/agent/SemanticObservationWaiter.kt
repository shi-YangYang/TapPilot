package dev.tappilot.agent

/** Events wake this reader; only fresh native evidence can satisfy a semantic wait.
 * This helper has no mutation callback and never holds live accessibility nodes.
 */
internal class SemanticObservationWaiter(
    private val now: () -> Long,
    private val revision: () -> Long,
    private val checkActive: () -> Unit,
    private val waitForSignal: (Long, Long) -> Unit,
) {
    data class Sample<T>(val value: T, val revision: Long, val signature: String, val scope: String, val matched: Boolean,
                         val usable: Boolean = true)
    data class Result<T>(val sample: Sample<T>, val status: String, val semanticChanged: Boolean?, val eventChanged: Boolean)

    fun <T> await(since: Long, timeoutMs: Int, baselineSignature: String?, baselineScope: String?,
                  selector: Boolean, requireUsable: Boolean = false, read: () -> Sample<T>): Result<T> {
        val deadline = now() + timeoutMs
        while (true) {
            checkActive()
            try {
                val sample = read()
                checkActive()
                val changed = baselineSignature?.let { it != sample.signature }
                val eventChanged = sample.revision != since
                val ready = !requireUsable || sample.usable
                val status = when {
                    !requireUsable && baselineScope != null && baselineScope != sample.scope -> "window_changed"
                    ready && selector && sample.matched -> "matched"
                    ready && (!selector || !requireUsable) && baselineScope != null && baselineScope != sample.scope -> "window_changed"
                    ready && !selector && (changed ?: eventChanged) -> "changed"
                    now() >= deadline -> "timed_out"
                    else -> null
                }
                if (status != null) return Result(sample, status, changed, eventChanged)
            } catch (error: AgentError) {
                // During a transition the root can briefly disappear. Never swallow
                // protection, cancellation or session errors, and never return an old tree.
                if (error.code != "NO_ACTIVE_WINDOW" || now() >= deadline) throw error
            }
            val nextReadAt = minOf(deadline, now() + 120)
            while (true) {
                checkActive()
                val current = revision()
                val time = now()
                if (time >= nextReadAt) break
                val remaining = nextReadAt - time
                waitForSignal(current, minOf(remaining, 100L))
            }
            // Bounded local rereads also catch missing/coalesced events. Event
            // storms cannot postpone this point; unrelated UI need not be idle.
        }
    }
}
