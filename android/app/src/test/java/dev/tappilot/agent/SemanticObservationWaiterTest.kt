package dev.tappilot.agent

import org.junit.Assert.*
import org.junit.Test

class SemanticObservationWaiterTest {
    private class Clock {
        var time = 0L
        var revision = 10L
        var signature = "same"
        var scope = "session|app|1"
        var matched = false
        var usable = true
        var failure: String? = null
        var rootAbsent = false
        var reads = 0
        val events = sortedMapOf<Long, () -> Unit>()
        val waiter = SemanticObservationWaiter({ time }, { revision }, {
            failure?.let { throw AgentError(it, "Synthetic lifecycle change") }
        }) { observed, duration ->
            assertTrue(duration in 1..100L)
            if (observed == revision) {
                val end = time + duration
                val next = events.entries.firstOrNull()
                if (next != null && next.key <= end) {
                    time = next.key; events.remove(next.key); next.value()
                } else time = end
            }
        }
        fun wait(selector: Boolean = false, baseline: String? = "same", requireUsable: Boolean = false) = waiter.await(10, 500, baseline,
            if (baseline == null) null else "session|app|1", selector, requireUsable) {
            reads++
            if (rootAbsent) throw AgentError("NO_ACTIVE_WINDOW", "Synthetic transition", true)
            SemanticObservationWaiter.Sample(time, revision, signature, scope, matched, usable)
        }
    }

    @Test fun eventStormAndPreviouslyDeliveredEventsDoNotMeanContentChanged() {
        for (interval in listOf(5, 17, 43, 91)) {
            val clock = Clock()
            clock.revision = 14 // Events delivered while the model was thinking.
            for (at in interval until 500 step interval) clock.events[at.toLong()] = { clock.revision++ }
            val result = clock.wait()
            assertEquals("timed_out", result.status)
            assertEquals(false, result.semanticChanged)
            assertTrue(result.eventChanged)
            assertEquals(500L, result.sample.value)
            assertTrue("Tree reads must be rate bounded", clock.reads <= 6)
        }
    }

    @Test fun actualContentChangeReturnsFreshTreeDespiteContinuousEvents() {
        val clock = Clock()
        for (at in 10..490 step 10) clock.events[at.toLong()] = { clock.revision++; if (at >= 230) clock.signature = "changed" }
        val result = clock.wait()
        assertEquals("changed", result.status)
        assertEquals(true, result.semanticChanged)
        assertTrue(result.sample.value in 230L..400L)
        assertEquals("changed", result.sample.signature)
    }

    @Test fun selectorWaitReturnsFullMatchedObservationAndIgnoresOtherChanges() {
        val clock = Clock()
        clock.events[30] = { clock.revision++; clock.signature = "unrelated" }
        clock.events[270] = { clock.revision++; clock.signature = "target"; clock.matched = true }
        val result = clock.wait(selector = true)
        assertEquals("matched", result.status)
        assertTrue(result.sample.matched)
        assertEquals("target", result.sample.signature)
        assertTrue(result.sample.value >= 270)
        val visible = Clock().apply { matched = true }.wait(selector = true)
        assertEquals("matched", visible.status)
        assertEquals(0L, visible.sample.value)
    }

    @Test fun windowChangeIsExplicitEvenWhenWaitingForASelector() {
        val clock = Clock().apply { scope = "session|app|2" }
        val result = clock.wait(selector = true)
        assertEquals("window_changed", result.status)
        assertFalse(result.sample.matched)
        assertEquals(0L, result.sample.value)
        val matchedOnAnotherWindow = Clock().apply { scope = "session|app|2"; matched = true }.wait(selector = true)
        assertEquals("window_changed", matchedOnAnotherWindow.status)
        assertTrue(matchedOnAnotherWindow.sample.matched)
    }

    @Test fun boundedLocalRereadDetectsSilentContentBeforeTheDeadline() {
        val clock = Clock()
        clock.events[300] = { clock.signature = "silent" } // Deliberately no revision event.
        val result = clock.wait()
        assertEquals("changed", result.status)
        assertEquals(true, result.semanticChanged)
        assertFalse(result.eventChanged)
        assertEquals(360L, result.sample.value)
        assertEquals(4, clock.reads)
    }

    @Test fun readinessWaitDoesNotTreatAnEmptyWindowChangeAsReady() {
        val clock = Clock().apply { scope = "session|app|2"; usable = false }
        for (at in 10..490 step 10) clock.events[at.toLong()] = {
            clock.revision++
            if (at >= 270) { clock.usable = true; clock.signature = "content" }
        }
        val result = clock.wait(requireUsable = true)
        assertEquals("window_changed", result.status)
        assertTrue(result.sample.usable)
        assertEquals(360L, result.sample.value)
    }

    @Test fun readinessSelectorRequiresBothUsableTreeAndActualTarget() {
        val clock = Clock().apply { scope = "session|app|2"; usable = false }
        clock.events[80] = { clock.usable = true; clock.revision++ }
        clock.events[270] = { clock.matched = true } // Target can appear without an event.
        val result = clock.wait(selector = true, requireUsable = true)
        assertEquals("matched", result.status)
        assertTrue(result.sample.usable)
        assertTrue(result.sample.matched)
        assertEquals(360L, result.sample.value)
        val permanent = Clock().apply { scope = "session|app|2"; usable = false; matched = true }
        assertEquals("timed_out", permanent.wait(selector = true, requireUsable = true).status)
        assertEquals(500L, permanent.time)
    }

    @Test fun transientMissingRootRecoversButPermanentMissingRootIsNotOldUi() {
        val clock = Clock().apply { rootAbsent = true }
        clock.events[200] = { clock.revision++; clock.rootAbsent = false; clock.signature = "ready" }
        assertEquals("changed", clock.wait().status)
        val absent = Clock().apply { rootAbsent = true }
        try { absent.wait(); fail("Missing root cannot return cached UI") }
        catch (error: AgentError) { assertEquals("NO_ACTIVE_WINDOW", error.code) }
        assertEquals(500L, absent.time)
    }

    @Test fun protectionStopLockDisconnectAndCancellationInterruptWaiting() {
        for (code in listOf("PROTECTED_APP", "EMERGENCY_STOPPED", "DEVICE_LOCKED", "SERVICE_UNAVAILABLE", "CANCELLED")) {
            val clock = Clock()
            clock.events[60] = { clock.failure = code }
            try { clock.wait(); fail("Expected $code") }
            catch (error: AgentError) { assertEquals(code, error.code) }
            assertEquals(60L, clock.time)
            assertEquals(1, clock.reads)
        }
    }

    @Test fun legacyEventWaitDoesNotInventSemanticEvidence() {
        val clock = Clock().apply { revision++ }
        val result = clock.wait(baseline = null)
        assertEquals("changed", result.status)
        assertNull(result.semanticChanged)
        assertTrue(result.eventChanged)
    }
}
