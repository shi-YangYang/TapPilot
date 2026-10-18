package dev.tappilot.agent

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WindowReadinessTest {
    private class Clock {
        var now = 0L
        var events = 0L
        val tracker = WindowReadinessTracker()
        val scope = WindowReadinessTracker.Scope("session", "fixture.app", 1)
        fun waiter(active: () -> Unit = {}) = WindowReadinessWaiter({ now }, { events }, active, { _, wait -> now += wait; events++ }, tracker)
        fun sample(signature: String, eligible: Boolean = true, scope: WindowReadinessTracker.Scope = this.scope, authorizationSignature: String = "same-shape") =
            WindowReadinessWaiter.Sample(signature, tracker.observe(scope, signature, eligible, authorizationSignature), signature, eligible)
    }

    @Test fun observedColdStartTimelineSettlesWithinSharedBudgetWithoutExtraSleeps() {
        val clock = Clock()
        val durations = listOf(1752L, 356L, 277L)
        var read = 0
        val result = clock.waiter().await(0, 2500) {
            clock.now += durations[read]
            clock.sample(if (read++ == 0) "uninitialized-control" else "initialized-control")
        }
        assertEquals("interaction_stable", result.readiness.reason)
        assertEquals(3, result.readiness.samples)
        assertEquals(2385L, result.readiness.waitedMs)
        assertTrue(result.readiness.ready)
    }

    @Test fun aSingleSlowReadCannotProveStabilityOrAuthorizeItsWindow() {
        val clock = Clock()
        val result = clock.waiter().await(0, 2500) { clock.now = 2500; clock.sample("same") }
        assertEquals("settling", result.readiness.status)
        assertEquals(1, result.readiness.samples)
        assertFalse(clock.tracker.known(result.sample.epoch))
    }

    @Test fun eventStormAndContinuallyChangingExternalControlHaveFiniteDeadline() {
        val clock = Clock()
        val result = clock.waiter().await(0, 2500) { clock.sample("surface-${clock.events}") }
        assertEquals("deadline", result.readiness.reason)
        assertEquals(2500L, clock.now)
        assertFalse(result.readiness.ready)
        assertTrue(result.readiness.samples in 2..22)
    }

    @Test fun stableKnownWindowIsOneFreshReadWithoutWaiting() {
        val clock = Clock()
        val first = clock.waiter().await(0, 2500) { clock.sample("surface") }
        assertTrue(first.readiness.ready)
        assertEquals(240L, clock.now)
        val started = clock.now
        val result = clock.waiter().await(started, started + 2500) { clock.now += 31; clock.sample("surface") }
        assertEquals("known_window", result.readiness.reason)
        assertEquals(1, result.readiness.samples)
        assertEquals(31L, result.readiness.waitedMs)
    }

    @Test fun inputObservationCoversDebouncedStateAndResultUpdatesBeforeConfirming() {
        val clock = Clock()
        val result = clock.waiter().await(0, 2500, readyNotBefore = 1000) {
            val signature = when {
                clock.now < 500 -> "input-value-already-matches"
                clock.now < 800 -> "save-and-undo-enabled"
                else -> "result-label-and-geometry-updated"
            }
            clock.sample(signature).also { sample ->
                if (clock.now < 1000) assertFalse("No early sample may confirm readiness", clock.tracker.known(sample.epoch))
            }
        }
        assertEquals("result-label-and-geometry-updated", result.sample.value)
        assertEquals("interaction_stable", result.readiness.reason)
        assertEquals(1080L, result.readiness.waitedMs)
        assertEquals(10, result.readiness.samples)
    }

    @Test fun alreadyKnownInputSurfaceCannotBypassItsMinimumObservationWindow() {
        val clock = Clock()
        clock.waiter().await(0, 2500) { clock.sample("surface") }
        val started = clock.now
        val result = clock.waiter().await(started, started + 2500, readyNotBefore = started + 1000) { clock.sample("surface") }
        assertEquals("known_window", result.readiness.reason)
        assertEquals(1080L, result.readiness.waitedMs)
        assertEquals(10, result.readiness.samples)
    }

    @Test fun minimumObservationWindowNeverExtendsItsHardDeadline() {
        val clock = Clock()
        clock.waiter().await(0, 2500) { clock.sample("known-surface") }
        val started = clock.now
        val result = clock.waiter().await(started, started + 500, readyNotBefore = started + 1000) { clock.sample("known-surface") }
        assertEquals("settling", result.readiness.status)
        assertEquals("deadline", result.readiness.reason)
        assertEquals(500L, result.readiness.waitedMs)
        assertEquals(5, result.readiness.samples)
        val changing = Clock()
        val unstable = changing.waiter().await(0, 2500, readyNotBefore = 1000) { changing.sample("surface-${changing.now}") }
        assertEquals("settling", unstable.readiness.status)
        assertEquals(2500L, unstable.readiness.waitedMs)
        assertTrue(unstable.readiness.samples <= 22)
    }

    @Test fun eligibleInputSamplesRemainCancellableBeforeTheMinimumWindow() {
        val clock = Clock()
        var reads = 0
        try {
            clock.waiter { if (clock.now >= 600) throw AgentError("CANCELLED", "stopped") }
                .await(0, 2500, readyNotBefore = 1000) { reads++; clock.sample("already-matching-input") }
            fail("expected cancellation")
        } catch (error: AgentError) { assertEquals("CANCELLED", error.code) }
        assertEquals(600L, clock.now)
        assertEquals(5, reads)
    }

    @Test fun externalSameWindowTransitionMustSettleWithoutAnAgentMutation() {
        val clock = Clock()
        val before = clock.waiter().await(0, 2500) { clock.sample("old-page") }
        val started = clock.now
        val result = clock.waiter().await(started, started + 2500) {
            val elapsed = clock.now - started
            clock.sample(if (elapsed < 480) "external-frame-${elapsed / 120}" else "new-page")
        }
        assertEquals("new-page", result.sample.value)
        assertEquals("interaction_stable", result.readiness.reason)
        assertEquals(720L, result.readiness.waitedMs)
        assertNotEquals(before.sample.epoch, result.sample.epoch)
        assertFalse(clock.tracker.validateReadiness(before.sample.epoch, before.readiness).ready)
    }

    @Test fun externalChangesThatNeverSettleCannotReuseKnownReadiness() {
        val clock = Clock()
        clock.waiter().await(0, 2500) { clock.sample("old-page") }
        val started = clock.now
        val result = clock.waiter().await(started, started + 500) { clock.sample("external-${clock.now}") }
        assertEquals("settling", result.readiness.status)
        assertEquals(500L, result.readiness.waitedMs)
        assertFalse(clock.tracker.known(result.sample.epoch))
    }

    @Test fun newerCapturePreventsAnOlderWorkerFromConfirmingOrPublishingEvenAfterSurfaceReturns() {
        val clock = Clock()
        val previous = clock.waiter().await(0, 2500) { clock.sample("old-page") }
        val firstNew = clock.sample("new-page")
        assertFalse(clock.tracker.confirm(previous.sample.epoch, previous.sample.signature))
        assertFalse(clock.tracker.validateReadiness(previous.sample.epoch, previous.readiness).ready)
        val returned = clock.sample("old-page")
        assertFalse(clock.tracker.confirm(firstNew.epoch, firstNew.signature))
        assertFalse(clock.tracker.confirm(previous.sample.epoch, previous.sample.signature))
        assertFalse(clock.tracker.confirm(returned.epoch, "wrong-surface"))
        assertFalse(clock.tracker.known(returned.epoch))
        val started = clock.now
        val settled = clock.waiter().await(started, started + 2500) { clock.sample("old-page") }
        assertEquals("interaction_stable", settled.readiness.reason)
        assertEquals(240L, settled.readiness.waitedMs)
        assertFalse(clock.tracker.validateReadiness(previous.sample.epoch, previous.readiness).ready)
    }

    @Test fun declaredLabelInheritanceDoesNotRestoreGlobalReadiness() {
        val clock = Clock()
        val before = clock.waiter().await(0, 2500) { clock.sample("status-before") }
        val fresh = clock.sample("status-after")
        assertTrue(clock.tracker.canInheritForDeclaredLabels(before.sample.epoch, fresh.epoch, before.readiness.ready))
        assertFalse(clock.tracker.known(fresh.epoch))
        assertFalse(clock.tracker.validateReadiness(before.sample.epoch, before.readiness).ready)
        assertFalse(clock.tracker.canInheritForDeclaredLabels(before.sample.epoch, fresh.epoch, false))
    }

    @Test fun declaredLabelInheritanceCannotCrossMutationWindowSessionOrObservedShapeChanges() {
        val boundaries: List<(Clock) -> Unit> = listOf(
            { it.tracker.invalidateAfterAction() },
            { it.tracker.invalidateActionInheritance() },
            { it.sample("other-window", scope = it.scope.copy(windowId = 2)) },
            { it.sample("other-session", scope = it.scope.copy(session = "other")) },
            { it.sample("changed-shape", authorizationSignature = "changed-state-or-geometry") },
            { it.sample("loading", eligible = false) },
            { it.tracker.reset() }
        )
        for (boundary in boundaries) {
            val clock = Clock()
            val before = clock.waiter().await(0, 2500) { clock.sample("status-before") }
            boundary(clock)
            val fresh = clock.sample("status-after")
            assertFalse(clock.tracker.canInheritForDeclaredLabels(before.sample.epoch, fresh.epoch, before.readiness.ready))
        }
    }

    @Test fun nativeNavigationRoleAndCollectionChangesRevokeLabelContextInheritance() {
        val original = tree(node("root"), node("tab", "root").put("nativeTabRole", true)
            .put("nativeCollectionItem", JSONObject().put("row", 0).put("column", 1).put("selected", false)),
            node("bar", "root").put("nativeCollection", JSONObject().put("rows", 1).put("columns", 2).put("selectionMode", 1)))
        val changes: List<(JSONObject) -> Unit> = listOf(
            { it.getJSONArray("nodes").getJSONObject(1).put("nativeTabRole", false) },
            { it.getJSONArray("nodes").getJSONObject(1).getJSONObject("nativeCollectionItem").put("selected", true) },
            { it.getJSONArray("nodes").getJSONObject(2).getJSONObject("nativeCollection").put("selectionMode", 2) }
        )
        for (change in changes) {
            val clock = Clock()
            val baseline = clock.waiter().await(0, 2500) {
                clock.sample("public-surface", authorizationSignature = WindowInteractionSurface.authorizationSignature(original))
            }
            val updated = copy(original); change(updated)
            val fresh = clock.sample("public-surface", authorizationSignature = WindowInteractionSurface.authorizationSignature(updated))
            assertFalse(clock.tracker.canInheritForDeclaredLabels(baseline.sample.epoch, fresh.epoch, true))
        }
    }

    @Test fun collectionStructureRefreshDoesNotRestartSurfaceStabilityButEndsLabelInheritance() {
        val clock = Clock()
        var first: WindowReadinessWaiter.Sample<String>? = null
        val settled = clock.waiter().await(0, 2500) {
            clock.sample("same-external-controls", authorizationSignature = "row-shape-${clock.now}").also { if (first == null) first = it }
        }
        assertEquals("interaction_stable", settled.readiness.reason)
        assertEquals(240L, settled.readiness.waitedMs)
        assertEquals(first!!.epoch.generation, settled.sample.epoch.generation)
        assertNotEquals(first!!.epoch.authorizationGeneration, settled.sample.epoch.authorizationGeneration)
        val refreshed = clock.sample("same-external-controls", authorizationSignature = "next-row-shape")
        assertTrue(clock.tracker.known(refreshed.epoch))
        assertTrue(clock.tracker.validateReadiness(settled.sample.epoch, settled.readiness).ready)
        assertFalse(clock.tracker.canInheritForDeclaredLabels(settled.sample.epoch, refreshed.epoch, settled.readiness.ready))
    }

    @Test fun acceptedSameWindowTransitionMustSettleItsNewInteractionGeneration() {
        val clock = Clock()
        val before = clock.waiter().await(0, 2500) { clock.sample("old-page") }
        clock.tracker.invalidateAfterAction()
        assertFalse(clock.tracker.known(before.sample.epoch))
        val started = clock.now
        val result = clock.waiter().await(started, started + 2500) {
            val elapsed = clock.now - started
            // Real fragment transitions expose several individually usable trees
            // before their final input/list appears, without changing windowId.
            clock.sample(if (elapsed < 480) "entering-frame-${elapsed / 120}" else "editor-ready")
        }
        assertEquals("editor-ready", result.sample.value)
        assertEquals(before.sample.epoch.scope, result.sample.epoch.scope)
        assertNotEquals(before.sample.epoch.generation, result.sample.epoch.generation)
        assertEquals("interaction_stable", result.readiness.reason)
        assertTrue(result.readiness.samples >= 2)
        assertEquals(720L, result.readiness.waitedMs)
    }

    @Test fun acceptedNoOpHasABoundedFreshProofWithoutWaitingForAnEventOrChange() {
        val clock = Clock()
        clock.waiter().await(0, 2500) { clock.sample("unchanged-page") }
        clock.tracker.invalidateAfterAction()
        val started = clock.now
        val result = clock.waiter().await(started, started + 2500) { clock.sample("unchanged-page") }
        assertEquals("interaction_stable", result.readiness.reason)
        assertEquals(240L, result.readiness.waitedMs)
        assertTrue(result.readiness.samples >= 2)
    }

    @Test fun postActionZeroWaitReadsOnceButCannotReusePreActionReadiness() {
        val clock = Clock()
        clock.waiter().await(0, 2500) { clock.sample("old-page") }
        clock.tracker.invalidateAfterAction()
        val started = clock.now
        var reads = 0
        val result = clock.waiter().await(started, started) {
            reads++; clock.now += 25; clock.sample("one-current-frame")
        }
        assertEquals(1, reads)
        assertEquals("one-current-frame", result.sample.value)
        assertEquals("settling", result.readiness.status)
        assertEquals("deadline", result.readiness.reason)
        assertFalse(clock.tracker.known(result.sample.epoch))
    }

    @Test fun postActionDeadlineDoesNotLeaveAnOldKnownShortcutForTheNextReader() {
        val clock = Clock()
        clock.waiter().await(0, 2500) { clock.sample("old-page") }
        clock.tracker.invalidateAfterAction()
        var started = clock.now
        val timeout = clock.waiter().await(started, started + 500) { clock.sample("changing-${clock.now}") }
        assertFalse(timeout.readiness.ready)
        assertFalse(clock.tracker.known(timeout.sample.epoch))
        started = clock.now
        val recovered = clock.waiter().await(started, started + 2500) { clock.sample("finally-stable") }
        assertEquals("interaction_stable", recovered.readiness.reason)
        assertEquals(240L, recovered.readiness.waitedMs)
        assertTrue(recovered.readiness.samples >= 2)
    }

    @Test fun preDispatchWorkerCannotConfirmOrPublishReadyAcrossAMutation() {
        val clock = Clock()
        val previous = clock.waiter().await(0, 2500) { clock.sample("old-page") }
        clock.tracker.invalidateAfterAction()
        assertFalse(clock.tracker.confirm(previous.sample.epoch, previous.sample.signature))
        val published = clock.tracker.validateReadiness(previous.sample.epoch, previous.readiness)
        assertEquals("settling", published.status)
        assertEquals("deadline", published.reason)
        val current = clock.sample("current-page")
        assertTrue(clock.tracker.confirm(current.epoch, current.signature))
        // Another reader confirming the current generation never blesses a
        // completed sample or retained handle from the previous generation.
        assertFalse(clock.tracker.validateReadiness(previous.sample.epoch, previous.readiness).ready)
    }

    @Test fun gestureCompletionInvalidatesReadinessConfirmedWhileGestureWasInFlight() {
        val clock = Clock()
        clock.waiter().await(0, 2500) { clock.sample("old-page") }
        clock.tracker.invalidateAfterAction() // dispatch accepted, callback pending
        val inFlight = clock.waiter().await(clock.now, clock.now + 2500) { clock.sample("intermediate-gesture-frame") }
        assertTrue(inFlight.readiness.ready)
        clock.tracker.invalidateAfterAction() // completion callback
        assertFalse(clock.tracker.known(inFlight.sample.epoch))
        assertFalse(clock.tracker.confirm(inFlight.sample.epoch, inFlight.sample.signature))
        val complete = clock.waiter().await(clock.now, clock.now + 2500) { clock.sample("gesture-final-frame") }
        assertEquals("interaction_stable", complete.readiness.reason)
        assertNotEquals(inFlight.sample.epoch.generation, complete.sample.epoch.generation)
    }

    @Test fun knownWindowCannotUseItsShortcutForAnIneligibleLoadingSample() {
        val clock = Clock()
        val before = clock.waiter().await(0, 2500) { clock.sample("old-page") }
        val started = clock.now
        val loading = clock.waiter().await(started, started + 500) { clock.sample("loading-only", eligible = false) }
        assertFalse(loading.readiness.ready)
        assertEquals("deadline", loading.readiness.reason)
        assertFalse(clock.tracker.known(before.sample.epoch))
        assertFalse(clock.tracker.confirm(loading.sample.epoch, loading.sample.signature))
        val returnedAt = clock.now
        val returned = clock.waiter().await(returnedAt, returnedAt + 2500) { clock.sample("old-page") }
        assertEquals("interaction_stable", returned.readiness.reason)
        assertEquals(240L, returned.readiness.waitedMs)
    }

    @Test fun windowReturnAndSessionResetCannotReuseOldReadinessEpoch() {
        val clock = Clock()
        val first = clock.waiter().await(0, 2500) { clock.sample("surface") }
        clock.tracker.enter(clock.scope.copy(windowId = 2))
        assertFalse(clock.tracker.confirm(first.sample.epoch, first.sample.signature))
        val returned = clock.tracker.enter(clock.scope)
        assertNotEquals(first.sample.epoch, returned)
        assertFalse(clock.tracker.known(returned))
        assertFalse(clock.tracker.confirm(returned, "surface"))
        clock.tracker.reset()
        assertFalse(clock.tracker.known(returned))
    }

    @Test fun loadingNeverBecomesReadyAndCancellationIsNotSwallowed() {
        val clock = Clock()
        val result = clock.waiter().await(0, 500) { clock.sample("loading", eligible = false) }
        assertFalse(result.readiness.ready)
        try {
            clock.waiter { if (clock.now >= 600) throw AgentError("CANCELLED", "stopped") }
                .await(clock.now, clock.now + 2500) { clock.sample("loading", eligible = false) }
            fail("expected cancellation")
        } catch (error: AgentError) { assertEquals("CANCELLED", error.code) }
    }

    @Test fun timeoutDuringAnotherNativeReadReturnsLastSampleWithoutGrantingAuthority() {
        val clock = Clock()
        var reads = 0
        val result = clock.waiter().await(0, 500) {
            if (reads++ > 0) { clock.now = 500; throw AgentError("COMMAND_TIMEOUT", "expired") }
            clock.sample("one-sample")
        }
        assertEquals(1, result.readiness.samples)
        assertFalse(result.readiness.ready)
    }

    @Test fun crossingReadDeadlineNeverPassesZeroOrNegativeToNativeWait() {
        var clock = 0L
        val tracker = WindowReadinessTracker()
        val epoch = tracker.enter(WindowReadinessTracker.Scope("session", "fixture", 1))
        val waits = mutableListOf<Long>()
        val waiter = WindowReadinessWaiter({ clock++ }, { 0 }, {}, { _, duration ->
            assertTrue("Native wait must stay finite", duration > 0)
            waits.add(duration)
            // Return one millisecond before the requested deadline: the next
            // clock read crosses it, as on a real scheduler boundary.
            clock += (duration - 1).coerceAtLeast(0)
        }, tracker)
        val result = waiter.await(0, 25) { WindowReadinessWaiter.Sample("loading", epoch, "loading", false) }
        assertFalse(result.readiness.ready)
        assertTrue(waits.isNotEmpty())
        assertTrue(clock < 40)
    }

    private fun node(id: String, parent: String? = null, klass: String = "android.widget.TextView", text: String = "fixture"): JSONObject = JSONObject()
        .put("nodeId", id).put("parentId", parent ?: JSONObject.NULL).put("className", klass).put("text", text)
        .put("visible", true).put("enabled", true).put("password", false).put("clickable", false)
        .put("bounds", JSONArray(listOf(0, 0, 400, 100)))
    private fun tree(vararg nodes: JSONObject) = JSONObject().put("packageName", "fixture.app").put("windowId", 1)
        .put("nodes", JSONArray(nodes.toList())).put("truncated", false)
    private fun copy(value: JSONObject) = JSONObject(value.toString())
    private fun windowContext(): RawSwipeWindowPolicy.Context {
        val bounds = RawSwipeWindowPolicy.Rect(0, 0, 400, 800)
        val window = RawSwipeWindowPolicy.Window(1, 1, 0, 1, true, true, bounds)
        return RawSwipeWindowPolicy.context("session", "fixture.app", 1, 0, 400, 800, 0, listOf(window))!!
    }

    @Test fun unchangedNodesWaitForTheirWindowGeometryToSettleInTheSameBudget() {
        val clock = Clock()
        val page = tree(node("root"))
        val finalWindow = windowContext()
        val result = clock.waiter().await(0, 2500) {
            // Both window bounds contain the same already-final native root.
            val window = if (clock.now < 240) finalWindow.copy(bounds = finalWindow.bounds.copy(bottom = 790)) else finalWindow
            clock.sample(WindowInteractionSurface.signature(page, window), WindowInteractionSurface.eligible(page),
                authorizationSignature = WindowInteractionSurface.authorizationSignature(page, window))
        }
        assertEquals("interaction_stable", result.readiness.reason)
        assertEquals(480L, result.readiness.waitedMs)
        assertEquals(5, result.readiness.samples)
    }

    @Test fun knownWindowGeometryChangesRevokeReadinessAndDeclaredLabelInheritance() {
        val original = windowContext()
        val changes = listOf(original.copy(bounds = original.bounds.copy(bottom = 799)),
            original.copy(displayWidth = 401), original.copy(displayHeight = 801), original.copy(rotation = 1))
        for (changed in changes) {
            val clock = Clock()
            val beforePage = tree(node("root"))
            val afterPage = copy(beforePage)
            val before = clock.waiter().await(0, 2500) {
                clock.sample(WindowInteractionSurface.signature(beforePage, original),
                    authorizationSignature = WindowInteractionSurface.authorizationSignature(beforePage, original))
            }
            val current = clock.sample(WindowInteractionSurface.signature(afterPage, changed),
                authorizationSignature = WindowInteractionSurface.authorizationSignature(afterPage, changed))
            assertFalse(clock.tracker.known(current.epoch))
            assertFalse(clock.tracker.canInheritForDeclaredLabels(before.sample.epoch, current.epoch, before.readiness.ready))
            val started = clock.now
            val settled = clock.waiter().await(started, started + 2500) {
                clock.sample(WindowInteractionSurface.signature(afterPage, changed),
                    authorizationSignature = WindowInteractionSurface.authorizationSignature(afterPage, changed))
            }
            assertEquals("interaction_stable", settled.readiness.reason)
            assertEquals(240L, settled.readiness.waitedMs)
        }
    }

    @Test fun missingWindowGeometryStillAllowsNativeReadinessButChangingAvailabilityNeedsFreshEvidence() {
        val clock = Clock()
        val page = tree(node("root"))
        fun sample(window: RawSwipeWindowPolicy.Context?) = clock.sample(WindowInteractionSurface.signature(page, window),
            WindowInteractionSurface.eligible(page), authorizationSignature = WindowInteractionSurface.authorizationSignature(page, window))
        val missing = clock.waiter().await(0, 2500) { sample(null) }
        assertTrue(missing.readiness.ready)
        val known = sample(windowContext())
        assertFalse(clock.tracker.known(known.epoch))
        assertFalse(clock.tracker.canInheritForDeclaredLabels(missing.sample.epoch, known.epoch, true))
        var started = clock.now
        val settled = clock.waiter().await(started, started + 2500) { sample(windowContext()) }
        assertTrue(settled.readiness.ready)
        val absent = sample(null)
        assertFalse(clock.tracker.known(absent.epoch))
        assertFalse(clock.tracker.canInheritForDeclaredLabels(settled.sample.epoch, absent.epoch, true))
        started = clock.now
        assertTrue(clock.waiter().await(started, started + 2500) { sample(null) }.readiness.ready)
    }

    @Test fun clickableContainerDescendantInitializationAndOutsideGeometryRemainSignificant() {
        val before = tree(node("root"), node("tap", "root", "android.widget.FrameLayout", "").put("clickable", true), node("label", "tap", text = "first"))
        val after = copy(before)
        after.getJSONArray("nodes").getJSONObject(2).put("contentDescription", "initialized")
        assertNotEquals(WindowInteractionSurface.signature(before), WindowInteractionSurface.signature(after))
        after.getJSONArray("nodes").getJSONObject(2).remove("contentDescription")
        after.getJSONArray("nodes").getJSONObject(2).put("bounds", JSONArray(listOf(20, 0, 400, 100)))
        assertNotEquals(WindowInteractionSurface.signature(before), WindowInteractionSurface.signature(after))
    }

    @Test fun nativeRowsMayRefreshForReadinessButFullExecutionEvidenceStillChanges() {
        val before = tree(node("root"), node("bar", "root", text = "Filter").put("clickable", true),
            node("list", "root", "android.widget.ListView"), node("row", "list", text = "one"))
        val after = copy(before)
        after.getJSONArray("nodes").getJSONObject(3).put("text", "two")
        assertEquals(WindowInteractionSurface.signature(before), WindowInteractionSurface.signature(after))
        assertNotEquals(ObservationContract.signature(before), ObservationContract.signature(after))
        after.getJSONArray("nodes").getJSONObject(1).put("text", "different toolbar")
        assertNotEquals(WindowInteractionSurface.signature(before), WindowInteractionSurface.signature(after))
        val formBefore = copy(before); val formAfter = copy(before)
        formBefore.getJSONArray("nodes").getJSONObject(2).put("className", "android.widget.ScrollView")
        formAfter.getJSONArray("nodes").getJSONObject(2).put("className", "android.widget.ScrollView")
        formAfter.getJSONArray("nodes").getJSONObject(3).put("text", "different recipient")
        assertNotEquals(WindowInteractionSurface.signature(formBefore), WindowInteractionSurface.signature(formAfter))
    }

    @Test fun labelInheritanceShapeRetainsStateGeometryAndPrivateNativeEvidence() {
        val before = tree(node("root"), node("label", "root", text = "status one")
            .put("contextProtected", false).put("contextSignature", "")
            .put("nativePath", JSONArray(listOf(0))).put("nativeDrawingOrder", 1)
            .put("nativeFieldSignatures", JSONObject().put("resourceId", "full-resource").put("className", "full-class")))
        fun label(value: JSONObject) = value.getJSONArray("nodes").getJSONObject(1)
        val after = copy(before); label(after).put("text", "status two")
        assertEquals(WindowInteractionSurface.authorizationSignature(before), WindowInteractionSurface.authorizationSignature(after))
        val changes: List<(JSONObject) -> Unit> = listOf(
            { label(it).put("text", "") },
            { label(it).put("enabled", false) },
            { label(it).put("bounds", JSONArray(listOf(1, 0, 400, 100))) },
            { label(it).put("contextProtected", true) },
            { label(it).put("contextSignature", "protected-meaning-changed") },
            { label(it).put("nativePath", JSONArray(listOf(1))) },
            { label(it).put("nativeDrawingOrder", 2) },
            { label(it).getJSONObject("nativeFieldSignatures").put("resourceId", "other-full-resource") },
            { label(it).getJSONObject("nativeFieldSignatures").put("className", "other-full-class") }
        )
        for (change in changes) {
            val changed = copy(before); change(changed)
            assertNotEquals(WindowInteractionSurface.authorizationSignature(before), WindowInteractionSurface.authorizationSignature(changed))
        }
        val rows = tree(node("root"), node("list", "root", "android.widget.ListView"), node("row", "list"))
        val changedRows = copy(rows); changedRows.getJSONArray("nodes").getJSONObject(2).put("enabled", false)
        assertEquals(WindowInteractionSurface.signature(rows), WindowInteractionSurface.signature(changedRows))
        assertNotEquals(WindowInteractionSurface.authorizationSignature(rows), WindowInteractionSurface.authorizationSignature(changedRows))
    }

    @Test fun postActionNativeCollectionRefreshStillAllowsStableExternalControls() {
        val clock = Clock()
        val page = tree(node("root"), node("bar", "root", text = "Filter").put("clickable", true),
            node("list", "root", "android.widget.ListView"), node("row", "list", text = "one"))
        clock.waiter().await(0, 2500) { clock.sample(WindowInteractionSurface.signature(page)) }
        clock.tracker.invalidateAfterAction()
        val started = clock.now
        val result = clock.waiter().await(started, started + 2500) {
            page.getJSONArray("nodes").getJSONObject(3).put("text", "public row ${clock.now}")
            clock.sample(WindowInteractionSurface.signature(page), WindowInteractionSurface.eligible(page))
        }
        assertEquals("interaction_stable", result.readiness.reason)
        assertEquals(240L, result.readiness.waitedMs)
    }

    @Test fun knownNativeCollectionRefreshRetainsTheFastPath() {
        val clock = Clock()
        val page = tree(node("root"), node("bar", "root", text = "Filter").put("clickable", true),
            node("list", "root", "android.widget.ListView"), node("row", "list", text = "one"))
        val before = clock.waiter().await(0, 2500) {
            clock.sample(WindowInteractionSurface.signature(page), WindowInteractionSurface.eligible(page))
        }
        page.getJSONArray("nodes").getJSONObject(3).put("text", "refreshed public row")
        val started = clock.now
        val after = clock.waiter().await(started, started + 2500) {
            clock.sample(WindowInteractionSurface.signature(page), WindowInteractionSurface.eligible(page))
        }
        assertEquals(before.sample.epoch, after.sample.epoch)
        assertEquals("known_window", after.readiness.reason)
        assertEquals(1, after.readiness.samples)
        assertEquals(0L, after.readiness.waitedMs)
    }

    @Test fun nativeLoadingWithOnlyCollectionControlsWaitsButReadOnlyTextCanSettle() {
        val loading = tree(node("root"), node("progress", "root", "android.widget.ProgressBar", ""),
            node("list", "root", "android.widget.ListView").put("clickable", true).put("scrollable", true),
            node("row", "list").put("clickable", true))
        assertFalse(WindowInteractionSurface.eligible(loading))
        assertTrue(WindowInteractionSurface.eligible(tree(node("text", text = "read only content"))))
        loading.getJSONArray("nodes").put(node("button", "root").put("clickable", true))
        assertTrue(WindowInteractionSurface.eligible(loading))
    }

    @Test fun advertisedReadinessRequiresExplicitReadyEvenWhenTreeIsUsable() {
        val value = tree(node("target").put("clickable", true))
        assertTrue(ObservationContract.ready(value)) // older protocol compatibility
        value.put("observationCapabilities", JSONObject().put("windowReadiness", true))
        assertTrue(ObservationContract.usable(value))
        assertFalse(ObservationContract.ready(value))
        value.put("readiness", WindowReadiness.captured(false).json())
        assertFalse(ObservationContract.ready(value))
        value.put("readiness", WindowReadiness("ready", "interaction_stable", 3, 240).json())
        assertTrue(ObservationContract.ready(value))
        val error = AgentError("UI_NOT_READY", "wait", reason = "OBSERVATION_SETTLING").also { it.nativeNotSent = true }.toJson()
        assertEquals("not_sent", error.getJSONObject("details").getString("dispatchState"))
        assertEquals("OBSERVATION_SETTLING", error.getJSONObject("details").getString("reason"))
    }
    @Test fun fullWindowUnscaledRootCannotSettleAtAConflictingScreenOffset() {
        val frame = RawSwipeWindowPolicy.Rect(0, 0, 1080, 2400)
        assertTrue(WindowInteractionSurface.rootFrameConsistent(frame, frame, frame))
        for (shifted in listOf(
            RawSwipeWindowPolicy.Rect(-149, 0, 931, 2400),
            RawSwipeWindowPolicy.Rect(1, 0, 1081, 2400),
            RawSwipeWindowPolicy.Rect(0, -50, 1080, 2350)
        )) assertFalse(WindowInteractionSurface.rootFrameConsistent(shifted, frame, frame))
    }

    @Test fun translatedDialogUsesItsOwnWindowOriginInsteadOfTheDisplayOrigin() {
        val window = RawSwipeWindowPolicy.Rect(140, 260, 940, 1760)
        val local = RawSwipeWindowPolicy.Rect(0, 0, 800, 1500)
        assertTrue(WindowInteractionSurface.rootFrameConsistent(window, local, window))
        assertFalse(WindowInteractionSurface.rootFrameConsistent(local, local, window))
    }

    @Test fun partialRootsAndMagnifiedCoordinatesKeepOrdinarySamplingWithoutGuessedMappings() {
        val window = RawSwipeWindowPolicy.Rect(0, 0, 1080, 2400)
        assertTrue(WindowInteractionSurface.rootFrameConsistent(
            RawSwipeWindowPolicy.Rect(0, 100, 1080, 2200), RawSwipeWindowPolicy.Rect(0, 100, 1080, 2200), window))
        assertTrue(WindowInteractionSurface.rootFrameConsistent(
            RawSwipeWindowPolicy.Rect(140, 260, 940, 1760), RawSwipeWindowPolicy.Rect(0, 0, 800, 1500), window))
        assertTrue(WindowInteractionSurface.rootFrameConsistent(
            RawSwipeWindowPolicy.Rect(-300, -600, 1860, 4200), window, window))
        assertTrue(WindowInteractionSurface.rootFrameConsistent(
            RawSwipeWindowPolicy.Rect(100, 200, 640, 1400), window, window))
    }

    @Test fun unknownRootMappingDoesNotInventInconsistencyButProvidedEmptyBoundsAreIneligible() {
        val frame = RawSwipeWindowPolicy.Rect(0, 0, 1080, 2400)
        val shifted = RawSwipeWindowPolicy.Rect(-149, 0, 931, 2400)
        assertTrue(WindowInteractionSurface.rootFrameConsistent(shifted, null, frame))
        assertTrue(WindowInteractionSurface.rootFrameConsistent(shifted, frame, null))
        assertTrue(WindowInteractionSurface.rootFrameConsistent(shifted, null, null))
        for (invalid in listOf(RawSwipeWindowPolicy.Rect(0, 0, 0, 0), RawSwipeWindowPolicy.Rect(1, 0, 0, 2),
            RawSwipeWindowPolicy.Rect(0, 2, 1, 1))) {
            assertFalse(WindowInteractionSurface.rootFrameConsistent(invalid, frame, frame))
            assertFalse(WindowInteractionSurface.rootFrameConsistent(invalid, null, null))
            assertFalse(WindowInteractionSurface.rootFrameConsistent(frame, invalid, frame))
            assertFalse(WindowInteractionSurface.rootFrameConsistent(frame, frame, invalid))
        }
    }

    @Test fun contradictoryRootFrameNeverConfirmsEarlyAndKeepsTheExistingStableSampleWindow() {
        val clock = Clock()
        val frame = RawSwipeWindowPolicy.Rect(0, 0, 1080, 2400)
        val shifted = RawSwipeWindowPolicy.Rect(-149, 0, 931, 2400)
        val result = clock.waiter().await(0, 2500) {
            val root = if (clock.now < 360) shifted else frame
            clock.sample("same-reported-controls", WindowInteractionSurface.rootFrameConsistent(root, frame, frame))
        }
        assertTrue(result.readiness.ready)
        assertEquals("interaction_stable", result.readiness.reason)
        assertEquals(600L, result.readiness.waitedMs)
        assertEquals(6, result.readiness.samples)
        val inconsistent = Clock()
        val timeout = inconsistent.waiter().await(0, 2500) {
            inconsistent.sample("same-reported-controls", WindowInteractionSurface.rootFrameConsistent(shifted, frame, frame))
        }
        assertFalse(timeout.readiness.ready)
        assertEquals("deadline", timeout.readiness.reason)
        assertEquals(2500L, timeout.readiness.waitedMs)
    }

    @Test fun displaySizedRootAndWindowCannotValidateTheirSharedLaunchTranslation() {
        val frame = RawSwipeWindowPolicy.Rect(0, 0, 1080, 2400)
        val shifted = RawSwipeWindowPolicy.Rect(120, 0, 1200, 2400)
        assertFalse(WindowInteractionSurface.rootFrameConsistent(shifted, frame, shifted, 1080, 2400))
        assertTrue(WindowInteractionSurface.rootFrameConsistent(frame, frame, frame, 1080, 2400))
        val dialog = RawSwipeWindowPolicy.Rect(140, 260, 940, 1760)
        assertTrue(WindowInteractionSurface.rootFrameConsistent(dialog, RawSwipeWindowPolicy.Rect(0, 0, 800, 1500), dialog, 1080, 2400))
        // Unknown/incomplete display metrics retain the existing mapping rule.
        assertTrue(WindowInteractionSurface.rootFrameConsistent(shifted, frame, shifted))
        assertTrue(WindowInteractionSurface.rootFrameConsistent(shifted, frame, shifted, 1080, null))
        assertTrue(WindowInteractionSurface.rootFrameConsistent(shifted, frame, shifted, null, 2400))
        assertTrue(WindowInteractionSurface.rootFrameConsistent(shifted, frame, shifted, 0, 2400))
        assertTrue(WindowInteractionSurface.rootFrameConsistent(shifted, frame, shifted, -1, 2400))
        assertFalse(WindowInteractionSurface.rootFrameConsistent(shifted, frame, frame))
        // Neither a partial root nor a scaled root acquires a guessed mapping.
        assertTrue(WindowInteractionSurface.rootFrameConsistent(shifted, RawSwipeWindowPolicy.Rect(0, 0, 900, 2000), shifted, 1080, 2400))
        assertTrue(WindowInteractionSurface.rootFrameConsistent(RawSwipeWindowPolicy.Rect(120, 0, 2280, 4800), frame, shifted, 1080, 2400))
    }

    @Test fun jointlyTranslatedFullWindowSettlesFor240msOnlyAfterReturningToItsDisplayOrigin() {
        val clock = Clock()
        val frame = RawSwipeWindowPolicy.Rect(0, 0, 1080, 2400)
        val shifted = RawSwipeWindowPolicy.Rect(120, 0, 1200, 2400)
        val result = clock.waiter().await(0, 2500) {
            val window = if (clock.now < 360) shifted else frame
            clock.sample("same-reported-controls", WindowInteractionSurface.rootFrameConsistent(window, frame, window, 1080, 2400))
        }
        assertTrue(result.readiness.ready)
        assertEquals("interaction_stable", result.readiness.reason)
        assertEquals(600L, result.readiness.waitedMs)
        assertEquals(6, result.readiness.samples)
    }

}
