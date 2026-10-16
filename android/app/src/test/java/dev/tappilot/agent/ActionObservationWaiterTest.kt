package dev.tappilot.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ActionObservationWaiterTest {
    private class Clock {
        var time = 0L
        var revision = 10L
        var activeError: String? = null
        val events = sortedMapOf<Long, () -> Unit>()
        val waiter = ActionObservationWaiter({ time }, { revision }, {
            activeError?.let { throw AgentError(it, "Synthetic lifecycle change") }
        }) { observed, duration ->
            assertTrue("No unbounded/zero monitor wait", duration in 1L..100L)
            if (observed == revision) {
                val end = time + duration
                val next = events.entries.firstOrNull()
                if (next != null && next.key <= end) {
                    time = next.key
                    events.remove(next.key)
                    next.value()
                } else time = end
            }
        }

        fun <T> observe(gesture: GestureCompletion? = null, waitMs: Int = 350, gestureDeadline: Long = 2750, read: () -> T): T =
            waiter.observeAfterAction(10, waitMs, 9000, gesture, gestureDeadline, read)
    }

    private fun error(code: String, block: () -> Unit) {
        try { block(); fail("Expected $code") } catch (failure: AgentError) { assertEquals(code, failure.code) }
    }

    @Test fun longGestureFinishesBeforeSettlingAndReading() {
        val clock = Clock()
        val gesture = GestureCompletion()
        clock.events[800] = { gesture.finish(cancelled = false); clock.revision++ }
        clock.events[850] = { clock.revision++ }
        var reads = 0
        val result = clock.observe(gesture) {
            reads++
            assertEquals(GestureCompletion.State.COMPLETED, gesture.state)
            assertEquals(970L, clock.time) // Completion, then content event + 120ms quiet.
            "ready"
        }
        assertEquals("ready", result)
        assertEquals(1, reads)
    }

    @Test fun zeroSettleBudgetStillWaitsForTheGestureCallback() {
        val clock = Clock()
        val gesture = GestureCompletion()
        clock.events[80] = { gesture.finish(cancelled = false); clock.revision++ }
        clock.observe(gesture, waitMs = 0) { assertEquals(80L, clock.time) }
    }

    @Test fun cancelledGestureNeverReadsOrTreatsAcceptanceAsCompletion() {
        val clock = Clock()
        val gesture = GestureCompletion()
        clock.events[80] = { gesture.finish(cancelled = true); clock.revision++ }
        error("GESTURE_CANCELLED") { clock.observe(gesture) { fail("Cancelled gesture must not provide a continuing observation") } }
        assertEquals(80L, clock.time)
        assertEquals(GestureCompletion.State.CANCELLED, gesture.state)
    }

    @Test fun missingCallbackExpiresWithoutReadingOrInventingCompletion() {
        val clock = Clock()
        val gesture = GestureCompletion()
        error("GESTURE_COMPLETION_TIMEOUT") { clock.observe(gesture, gestureDeadline = 250) { fail("Unknown gesture must not read") } }
        assertEquals(250L, clock.time)
        assertEquals(GestureCompletion.State.PENDING, gesture.state)
    }

    @Test fun overallDeadlineAlsoBoundsGestureCompletion() {
        val clock = Clock()
        error("GESTURE_COMPLETION_TIMEOUT") {
            clock.waiter.observeAfterAction(10, 350, 150, GestureCompletion(), 2750) { fail("Expired operation must not read") }
        }
        assertEquals(150L, clock.time)
    }

    @Test fun cancellationStopLockAndDisconnectInterruptPendingGestures() {
        for (code in listOf("CANCELLED", "EMERGENCY_STOPPED", "DEVICE_LOCKED", "SERVICE_UNAVAILABLE")) {
            val clock = Clock()
            clock.events[60] = { clock.activeError = code }
            error(code) { clock.observe(GestureCompletion()) { fail("Lifecycle interruption must prevent reading") } }
            assertEquals(60L, clock.time)
        }
    }

    @Test fun transientRootWaitsForANewEventAndRecoversWithinOriginalBudget() {
        val clock = Clock()
        clock.revision++ // A navigation-start event already arrived.
        clock.events[160] = { clock.revision++ }
        val readTimes = mutableListOf<Long>()
        val result = clock.observe {
            readTimes.add(clock.time)
            if (readTimes.size == 1) throw AgentError("NO_ACTIVE_WINDOW", "Synthetic transition", true)
            "ready"
        }
        assertEquals("ready", result)
        assertEquals(listOf(120L, 280L), readTimes)
        assertTrue(clock.time <= 350)
    }

    @Test fun absentWindowWithoutNewEventsDoesNotPollOrExtendBudget() {
        val clock = Clock()
        clock.revision++
        var reads = 0
        error("NO_ACTIVE_WINDOW") { clock.observe { reads++; throw AgentError("NO_ACTIVE_WINDOW", "Synthetic transition", true) } }
        assertEquals(1, reads)
        assertEquals(350L, clock.time)
    }

    @Test fun repeatedEmptyRootsHaveAnIndependentReadBoundAndOtherErrorsDoNotRetry() {
        val clock = Clock()
        clock.revision++
        clock.events[130] = { clock.revision++ }
        clock.events[260] = { clock.revision++ }
        var reads = 0
        error("NO_ACTIVE_WINDOW") { clock.observe(waitMs = 1500) { reads++; throw AgentError("NO_ACTIVE_WINDOW", "Synthetic transition", true) } }
        assertEquals(3, reads)
        assertEquals(380L, clock.time)

        val protected = Clock()
        var protectedReads = 0
        error("PROTECTED_APP") { protected.observe(waitMs = 0) { protectedReads++; throw AgentError("PROTECTED_APP", "Synthetic protected UI") } }
        assertEquals(1, protectedReads)
        assertEquals(0L, protected.time)
    }

    @Test fun lateDuplicateCallbackCannotReplaceTheFirstReportedOutcome() {
        val gesture = GestureCompletion()
        gesture.finish(cancelled = false)
        gesture.finish(cancelled = true)
        assertEquals(GestureCompletion.State.COMPLETED, gesture.state)
    }
}
