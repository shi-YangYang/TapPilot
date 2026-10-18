package dev.tappilot.agent

import org.junit.Assert.*
import org.junit.Test

class RawSwipeWindowPolicyTest {
    private val bounds = RawSwipeWindowPolicy.Rect(0, 0, 400, 800)
    private val app = RawSwipeWindowPolicy.Window(10, 1, 0, 2, true, true, bounds)
    private val decor = RawSwipeWindowPolicy.Window(20, 2, 0, 4, false, false, RawSwipeWindowPolicy.Rect(320, 20, 390, 80))
    private val stroke = RawSwipeWindowPolicy.Rect(99, 99, 102, 702)
    private fun context(windows: List<RawSwipeWindowPolicy.Window> = listOf(app)) =
        RawSwipeWindowPolicy.context("session-a", "synthetic.app", 10, 0, 400, 800, 0, windows)!!
    private fun stale(block: () -> Unit) {
        try { block(); fail("Expected WINDOW_CHANGED") }
        catch (error: AgentError) { assertEquals("STALE_SNAPSHOT", error.code); assertEquals("WINDOW_CHANGED", error.reason) }
    }

    @Test fun inactiveDecorNoiseDoesNotInvalidateAnOtherwiseIdenticalWindow() {
        val tracker = RawSwipeWindowTracker()
        val reference = tracker.capture(context(listOf(app, decor)))!!
        val moved = decor.copy(bounds = RawSwipeWindowPolicy.Rect(310, 200, 390, 260), layer = 8)
        val current = context(listOf(moved, app))
        tracker.observe(current.activation) // Bounds/title/noise event, not activation/focus.
        val fresh = tracker.capture(current)
        RawSwipeWindowPolicy.requireSame(reference, fresh)
        RawSwipeWindowPolicy.requireUnobscured(fresh!!.context, listOf(app, moved), stroke)
        assertEquals(reference.activationEpoch, fresh.activationEpoch)
    }

    @Test fun inactiveOverlayEnteringTheStrokeIsStillRejectedAtDispatch() {
        val tracker = RawSwipeWindowTracker()
        val reference = tracker.capture(context(listOf(app, decor)))!!
        val blocking = decor.copy(bounds = RawSwipeWindowPolicy.Rect(80, 300, 120, 301))
        val fresh = tracker.capture(context(listOf(app, blocking)))!!
        RawSwipeWindowPolicy.requireSame(reference, fresh)
        try { RawSwipeWindowPolicy.requireUnobscured(fresh.context, listOf(app, blocking), stroke); fail("Overlay accepted") }
        catch (error: AgentError) { assertEquals("NODE_NOT_ACTIONABLE", error.code); assertEquals("WINDOW_OBSCURED", error.reason) }
        RawSwipeWindowPolicy.requireUnobscured(fresh.context, listOf(app, blocking.copy(displayId = 1)), stroke)
        RawSwipeWindowPolicy.requireUnobscured(fresh.context, listOf(app, blocking.copy(layer = 1)), stroke)
    }

    @Test fun aPartialWindowNeverAuthorizesAStrokeIntoALowerLayerApplication() {
        val partial = app.copy(bounds = RawSwipeWindowPolicy.Rect(0, 0, 200, 800))
        val other = app.copy(id = 30, layer = 1, active = false, focused = false,
            bounds = RawSwipeWindowPolicy.Rect(200, 0, 400, 800))
        val current = context(listOf(partial, other))
        RawSwipeWindowPolicy.requireUnobscured(current, listOf(partial, other), RawSwipeWindowPolicy.Rect(0, 0, 200, 800))
        for (outside in listOf(RawSwipeWindowPolicy.Rect(100, 100, 201, 700), RawSwipeWindowPolicy.Rect(210, 100, 300, 700))) {
            try { RawSwipeWindowPolicy.requireUnobscured(current, listOf(partial, other), outside); fail("Cross-app stroke accepted") }
            catch (error: AgentError) { assertEquals("NODE_NOT_ACTIONABLE", error.code); assertEquals("TARGET_CLIPPED", error.reason) }
        }
    }

    @Test fun observedWindowBoundsAreIntersectedWithTheActualDisplayOnEverySide() {
        val oversized = app.copy(bounds = RawSwipeWindowPolicy.Rect(-20, -20, 420, 820))
        val current = context(listOf(oversized))
        RawSwipeWindowPolicy.requireUnobscured(current, listOf(oversized), bounds)
        for (outside in listOf(RawSwipeWindowPolicy.Rect(-1, 100, 100, 200), RawSwipeWindowPolicy.Rect(100, -1, 200, 100),
            RawSwipeWindowPolicy.Rect(300, 100, 401, 200), RawSwipeWindowPolicy.Rect(100, 700, 200, 801),
            RawSwipeWindowPolicy.Rect(100, 100, 100, 200))) {
            try { RawSwipeWindowPolicy.requireUnobscured(current, listOf(oversized), outside); fail("Out-of-display stroke accepted") }
            catch (error: AgentError) { assertEquals("NODE_NOT_ACTIONABLE", error.code); assertEquals("TARGET_CLIPPED", error.reason) }
        }
    }

    @Test fun leavingAndReturningCannotReauthorizeAnOldMatchingTree() {
        val tracker = RawSwipeWindowTracker()
        val reference = tracker.capture(context())!!
        val other = app.copy(id = 11)
        tracker.observe(RawSwipeWindowPolicy.activation("session-a", 0, listOf(other)))
        val returned = tracker.capture(context())!!
        assertEquals(reference.context, returned.context)
        assertTrue(returned.activationEpoch > reference.activationEpoch)
        stale { RawSwipeWindowPolicy.requireSame(reference, returned) }
    }

    @Test fun explicitFocusEventsRevokeEvenWhenTheIntermediateWindowWasNotSampled() {
        val tracker = RawSwipeWindowTracker()
        val reference = tracker.capture(context())!!
        tracker.observe(reference.context.activation, explicitTransition = true)
        val fresh = tracker.capture(context())!!
        // A queued callback can arrive between capture and publication. Publishing
        // the immutable earlier sample does not update its activation epoch.
        val published = reference.copy()
        stale { RawSwipeWindowPolicy.requireSame(published, fresh) }
        RawSwipeWindowPolicy.requireSame(fresh, tracker.capture(context()))
    }

    @Test fun focusChangingOnAnotherWindowAlsoRevokesTheCoordinateReference() {
        val tracker = RawSwipeWindowTracker()
        val reference = tracker.capture(context(listOf(app, decor)))!!
        val focusedOverlay = listOf(app.copy(focused = false), decor.copy(focused = true))
        val changed = tracker.capture(context(focusedOverlay))!!
        stale { RawSwipeWindowPolicy.requireSame(reference, changed) }
        stale { RawSwipeWindowPolicy.requireSame(reference, tracker.capture(context(listOf(app, decor)))) }
    }

    @Test fun everyBoundWindowAndDisplayFactRemainsPartOfTheReference() {
        val tracker = RawSwipeWindowTracker()
        val reference = tracker.capture(context())!!
        val original = reference.context
        val changes = listOf(
            original.copy(packageName = "other.synthetic.app"), original.copy(windowId = 11),
            original.copy(bounds = bounds.copy(bottom = 799)), original.copy(displayWidth = 401),
            original.copy(displayHeight = 801), original.copy(rotation = 1),
            original.copy(activation = original.activation.copy(session = "session-b")),
            original.copy(activation = original.activation.copy(displayId = 1)),
            original.copy(activation = original.activation.copy(active = listOf(RawSwipeWindowPolicy.Identity(10, 2)))),
        )
        for (changed in changes) stale { RawSwipeWindowPolicy.requireSame(reference, reference.copy(context = changed)) }
    }

    @Test fun missingAmbiguousOrWrongDisplayWindowMetadataNeverCreatesAuthority() {
        assertNull(RawSwipeWindowPolicy.context("session-a", "synthetic.app", 10, 0, 400, 800, 0, emptyList()))
        assertNull(RawSwipeWindowPolicy.context("session-a", "synthetic.app", 10, 0, 400, 800, 0, listOf(app.copy(displayId = 1))))
        assertNull(RawSwipeWindowPolicy.context("session-a", "synthetic.app", 10, 0, 400, 800, 0, listOf(app, app.copy(id = 11))))
        assertNull(RawSwipeWindowPolicy.context("session-a", "synthetic.app", 10, 0, 400, 800, 0, listOf(app.copy(bounds = bounds.copy(bottom = 0)))))
        stale { RawSwipeWindowPolicy.requireSame(null, null) }
    }

    @Test fun unknownStateAndServiceResetInvalidateEarlierReferences() {
        val tracker = RawSwipeWindowTracker()
        val reference = tracker.capture(context())!!
        assertNull(tracker.capture(null))
        stale { RawSwipeWindowPolicy.requireSame(reference, tracker.capture(context())) }
        val beforeReset = tracker.capture(context())!!
        tracker.reset()
        stale { RawSwipeWindowPolicy.requireSame(beforeReset, tracker.capture(context())) }
    }
}
