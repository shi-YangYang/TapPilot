package dev.tappilot.agent

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Synthetic labels only. Live Android behavior is exercised by the separate testbed. */
class NodeActionGuardTest {
    private fun node(id: String, parent: String?, label: String = "", bounds: List<Int> = listOf(0, 0, 400, 600), clickable: Boolean = false, scrollable: Boolean = false, className: String = "android.view.View", description: String = ""): JSONObject = JSONObject()
        .put("nodeId", id).put("parentId", parent ?: JSONObject.NULL).put("text", label).put("contentDescription", description)
        .put("resourceId", "fixture:id/$id").put("className", className).put("bounds", JSONArray(bounds))
        .put("clickable", clickable).put("scrollable", scrollable).put("editable", false).put("enabled", true)
        .put("password", false).put("checkable", false).put("checked", false).put("selected", false).put("focused", false).put("visible", true)
    private fun tree(tick: String = "Tick 1"): JSONObject = JSONObject().put("snapshotId", "fixture:1").put("revision", 1)
        .put("packageName", "fixture.app").put("windowId", 1).put("truncated", false).put("nodes", JSONArray(listOf(
            node("root", null),
            node("list", "root", scrollable = true, className = "android.widget.ListView"),
            node("target", "list", description = "Target row", clickable = true, bounds = listOf(0, 0, 400, 100)),
            node("targetLabel", "target", "Open item", bounds = listOf(0, 0, 400, 100)),
            node("peer", "list", description = "Other row", clickable = true, bounds = listOf(0, 100, 400, 200)),
            node("peerLabel", "peer", tick, bounds = listOf(0, 100, 400, 200)))))
    private fun changed(value: JSONObject): JSONObject = JSONObject(value.toString()).put("snapshotId", "fixture:2").put("revision", 2)
    private fun form(tick: Int = 0): JSONObject = JSONObject().put("snapshotId", "fixture:1").put("revision", 1)
        .put("packageName", "fixture.app").put("windowId", 1).put("truncated", false).put("nodes", JSONArray(listOf(
            node("root", null, bounds = listOf(0, 0, 400, 800)),
            node("body", "root", bounds = listOf(0, 0, 400, 800), scrollable = true, className = "android.widget.ScrollView"),
            node("recipient", "body", "Recipient A", listOf(0, 0, 400, 40), className = "android.widget.TextView").put("resourceId", ""),
            node("account", "body", "Account A", listOf(0, 50, 400, 90), className = "android.widget.TextView").put("resourceId", ""),
            node("amount", "body", "Amount 100", listOf(0, 100, 400, 140), className = "android.widget.TextView").put("resourceId", ""),
            node("status", "body", "Status $tick", listOf(0, 200, 400, 240), className = "android.widget.TextView").put("resourceId", ""),
            node("field", "body", bounds = listOf(0, 300, 400, 350), className = "android.widget.EditText").put("editable", true),
            node("save", "body", "Save draft", listOf(0, 400, 400, 450), clickable = true, className = "android.widget.Button"))))
    private fun n(tree: JSONObject, id: String): JSONObject = tree.getJSONArray("nodes").let { a -> (0 until a.length()).map(a::getJSONObject).single { it.getString("nodeId") == id } }
    private fun expect(code: String, reason: String? = null, action: () -> Unit) {
        try { action(); fail("Expected $code") } catch (e: AgentError) { assertEquals(code, e.code); if (reason != null) assertEquals(reason, e.reason) }
    }

    @Test fun continuousPeerLeafRefreshKeepsWholeRowTarget() {
        val original = NodeActionGuard(tree())
        for (tick in 2..20) {
            val fresh = tree("Tick $tick").put("snapshotId", "fixture:$tick").put("revision", tick)
            assertEquals("target", original.rebind(NodeActionGuard(fresh), "target", "tap_element"))
            assertEquals("target", original.rebind(NodeActionGuard(fresh), "targetLabel", "click_element").let { NodeActionGuard(fresh).clickTarget(it) })
        }
    }
    @Test fun nativeListWithAllRowsVisibleRetainsCollectionIdentity() {
        val previous = tree(); n(previous, "list").put("scrollable", false)
        val fresh = changed(previous); n(fresh, "peerLabel").put("text", "Tick 2")
        for (action in listOf("tap_element", "click_element")) {
            assertEquals("target", NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "target", action))
        }
        // The same non-scrollable shape in a generic layout proves no grouping.
        n(previous, "list").put("className", "android.view.ViewGroup")
        n(fresh, "list").put("className", "android.view.ViewGroup")
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "target", "tap_element") }
    }
    @Test fun sameSemanticsWithNewHandlesRebindsUniquely() {
        val previous = tree(); val fresh = changed(previous)
        val nodes = fresh.getJSONArray("nodes")
        for (i in 0 until nodes.length()) {
            val node = nodes.getJSONObject(i)
            node.put("nodeId", "new-${node.getString("nodeId")}")
            if (!node.isNull("parentId")) node.put("parentId", "new-${node.getString("parentId")}")
        }
        assertEquals("new-target", NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "target", "tap_element"))
    }
    @Test fun targetDescendantRefreshIsNotIndependent() {
        val fresh = changed(tree()); n(fresh, "targetLabel").put("text", "Changed target")
        expect("TARGET_CHANGED", "TARGET_IDENTITY_CHANGED") { NodeActionGuard(tree()).rebind(NodeActionGuard(fresh), "target", "tap_element") }
    }
    @Test fun titleChangeIsRelevantDespiteStableTarget() {
        val previous = tree(); previous.getJSONArray("nodes").put(node("title", "root", "Recipient one", listOf(0, 400, 400, 480)))
        val fresh = changed(previous); n(fresh, "title").put("text", "Recipient two")
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "target", "tap_element") }
    }
    @Test fun rowReorderingDoesNotUseIndependentException() {
        val previous = tree(); val fresh = changed(tree("Tick 2")); val a = fresh.getJSONArray("nodes")
        fresh.put("nodes", JSONArray(listOf(a.getJSONObject(0), a.getJSONObject(1), a.getJSONObject(4), a.getJSONObject(5), a.getJSONObject(2), a.getJSONObject(3))))
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "target", "tap_element") }
    }
    @Test fun stateChangesInOtherRowsRemainRelevant() {
        val fresh = changed(tree("Tick 2")); n(fresh, "peer").put("selected", true)
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(tree()).rebind(NodeActionGuard(fresh), "target", "tap_element") }
    }
    @Test fun nativeContextProtectionAlsoAppliesToCollectionPeerLabels() {
        val previous = tree(); n(previous, "peerLabel").put("contextProtected", true)
        val fresh = changed(previous); n(fresh, "peerLabel").put("text", "Changed protected label")
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "target", "tap_element") }
    }
    @Test fun collectionPeerNormalizationHonorsProtectedContainers() {
        for (protected in listOf("peer", "labelContainer")) {
            val previous = tree()
            previous.getJSONArray("nodes").put(node("labelContainer", "peer", bounds = listOf(0, 100, 400, 200)))
            n(previous, "peerLabel").put("parentId", "labelContainer")
            n(previous, protected).put("contextProtected", true)
            val fresh = changed(previous); n(fresh, "peerLabel").put("text", "Changed protected descendant")
            expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "target", "tap_element") }
        }
    }
    @Test fun embeddedFieldNeverUsesSiblingRelaxation() {
        val previous = tree(); n(previous, "targetLabel").put("editable", true)
        val fresh = changed(previous); n(fresh, "peerLabel").put("text", "Tick 2")
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "targetLabel", "input_text") }
    }
    @Test fun scrollDoesNotPermitChangingListContent() {
        expect("TARGET_CHANGED", "TARGET_IDENTITY_CHANGED") { NodeActionGuard(tree()).rebind(NodeActionGuard(changed(tree("Tick 2"))), "list", "scroll") }
    }
    @Test fun duplicateIdentityIsAmbiguous() {
        val fresh = changed(tree()); val copy = JSONObject(n(fresh, "target").toString()).put("nodeId", "duplicate")
        val leaf = JSONObject(n(fresh, "targetLabel").toString()).put("nodeId", "duplicateLabel").put("parentId", "duplicate")
        fresh.getJSONArray("nodes").put(copy).put(leaf)
        expect("TARGET_CHANGED", "TARGET_AMBIGUOUS") { NodeActionGuard(tree()).rebind(NodeActionGuard(fresh), "target", "tap_element") }
    }
    @Test fun changedSessionAndWindowRefuse() {
        expect("TARGET_CHANGED", "SESSION_CHANGED") { NodeActionGuard(tree()).rebind(NodeActionGuard(tree().put("snapshotId", "other:2")), "target", "tap_element") }
        expect("TARGET_CHANGED", "WINDOW_CHANGED") { NodeActionGuard(tree()).rebind(NodeActionGuard(tree().put("windowId", 2)), "target", "tap_element") }
    }
    @Test fun completeOverlayBlocksTouch() {
        val value = tree(); value.getJSONArray("nodes").put(node("cover", "root", "Overlay", listOf(0, 0, 400, 100)))
        for (action in listOf("tap_element", "click_element")) {
            val current = NodeActionGuard(value)
            val target = current.rebind(NodeActionGuard(changed(value)), "target", action)
            expect("NODE_NOT_ACTIONABLE", "AMBIGUOUS_TOUCH_TARGET") { current.touch(target, 400, 600) }
        }
    }
    @Test fun zeroAreaNonTargetLayoutsDoNotInventAnOverlay() {
        val value = tree(); value.getJSONArray("nodes").put(node("empty", "root", bounds = listOf(0, 0, 0, 0), clickable = true))
        assertEquals("target", NodeActionGuard(value).touch("target", 400, 600).actedNodeId)
        NodeActionGuard(value).validateShortGesture(100, 50, 100, 50)
        expect("NODE_NOT_ACTIONABLE", "INVALID_BOUNDS") { NodeActionGuard(value).touch("empty", 400, 600) }
    }
    @Test fun partialOverlayUsesOnlyObservedClearRegion() {
        val value = tree(); value.getJSONArray("nodes").put(node("cover", "root", "Overlay", listOf(200, 0, 400, 100)))
        val touch = NodeActionGuard(value).touch("target", 400, 600)
        assertTrue(touch.x < 200); assertEquals("target", touch.actedNodeId)
    }
    @Test fun sensitiveDescendantAndRawGestureRemainBlocked() {
        val value = tree(); n(value, "targetLabel").put("text", "确认支付")
        expect("MANUAL_ACTION_REQUIRED") { NodeActionGuard(value).touch("target", 400, 600) }
        expect("MANUAL_ACTION_REQUIRED") { NodeActionGuard(value).validateShortGesture(100, 50, 100, 50) }
    }
    @Test fun truncatedTreeCannotAuthorizeRebind() {
        expect("TARGET_CHANGED", "TREE_INCOMPLETE") { NodeActionGuard(tree().put("truncated", true)) }
    }
    @Test fun rawTouchCannotHitTwoDistinctControls() {
        expect("NODE_NOT_ACTIONABLE", "TOUCH_TARGET_MISMATCH") { NodeActionGuard(tree()).validateShortGesture(100, 99, 100, 101) }
    }
    @Test fun unannotatedFormStillRequiresExplicitStatusAllowance() {
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") {
            NodeActionGuard(form()).rebind(NodeActionGuard(changed(form(1))), "field", "input_text")
        }
        val original = NodeActionGuard(form())
        for (tick in 1..20) {
            val fresh = NodeActionGuard(form(tick).put("snapshotId", "fixture:${tick + 1}").put("revision", tick + 1))
            assertEquals("field", original.rebind(fresh, "field", "input_text", listOf("status")))
            assertEquals("save", original.rebind(fresh, "save", "tap_element", listOf("status")))
        }
    }
    @Test fun allowanceNeverDiscardsUnlistedRecipientAccountOrAmount() {
        for (protected in listOf("recipient", "account", "amount")) {
            val fresh = changed(form(1)); n(fresh, protected).put("text", "Changed business context")
            expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") {
                NodeActionGuard(form()).rebind(NodeActionGuard(fresh), "field", "input_text", listOf("status"))
            }
        }
    }
    @Test fun malformedOrNonPassiveAllowancesAreRejectedEvenWithoutRefresh() {
        for (ids in listOf(listOf("missing"), listOf("status", "status"), List(9) { "label$it" }, listOf("field"), listOf("root"))) {
            expect("INVALID_ARGUMENT") { NodeActionGuard(form()).rebind(NodeActionGuard(changed(form())), "field", "input_text", ids) }
        }
        for (flag in listOf("clickable", "scrollable", "editable", "password", "checkable", "checked", "selected", "focused", "contextProtected")) {
            val original = form(); n(original, "status").put(flag, true)
            expect("INVALID_ARGUMENT") { NodeActionGuard(original).rebind(NodeActionGuard(changed(original)), "field", "input_text", listOf("status")) }
        }
        for (flag in listOf("visible", "enabled")) {
            val original = form(); n(original, "status").put(flag, false)
            expect("INVALID_ARGUMENT") { NodeActionGuard(original).rebind(NodeActionGuard(changed(original)), "field", "input_text", listOf("status")) }
        }
        val blank = form(); n(blank, "status").put("text", "")
        expect("INVALID_ARGUMENT") { NodeActionGuard(blank).rebind(NodeActionGuard(changed(blank)), "field", "input_text", listOf("status")) }
        val branch = form(); branch.getJSONArray("nodes").put(node("statusChild", "status", "Child", listOf(0, 200, 400, 240)))
        expect("INVALID_ARGUMENT") { NodeActionGuard(branch).rebind(NodeActionGuard(changed(branch)), "field", "input_text", listOf("status")) }
    }
    @Test fun semanticHeadingsAndAssociatedLabelsCannotBeDeclaredVolatile() {
        // The service maps native heading/pane/label associations to this bit;
        // the guard never assumes that ordinary TextView labels are unimportant.
        for (protected in listOf("recipient", "account", "amount", "status")) {
            val original = form(); n(original, protected).put("contextProtected", true)
            expect("INVALID_ARGUMENT") { NodeActionGuard(original).rebind(NodeActionGuard(changed(original)), "field", "input_text", listOf(protected)) }
        }
    }
    @Test fun semanticProtectionOnAnyAncestorPreventsLabelAllowance() {
        for (ancestor in listOf("body", "root")) {
            val original = form(); n(original, ancestor).put("contextProtected", true)
            expect("INVALID_ARGUMENT") { NodeActionGuard(original).rebind(NodeActionGuard(changed(original)), "field", "input_text", listOf("status")) }
        }
    }
    @Test fun semanticValueChangesAreCheckedEvenWhenProtectionBitRemainsTrue() {
        val original = form(); n(original, "recipient").put("contextProtected", true).put("contextSignature", "native-label-value-a")
        val fresh = changed(original); n(fresh, "recipient").put("contextSignature", "native-label-value-b")
        for (allowance in listOf(emptyList(), listOf("status"))) {
            expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(original).rebind(NodeActionGuard(fresh), "field", "input_text", allowance) }
        }
        // A pane may expose its title only through native semantics. Its empty
        // text must not cause full-page context comparison to flatten it away.
        val pane = form()
        pane.getJSONArray("nodes").put(node("otherPane", "root", bounds = listOf(0, 600, 400, 700))
            .put("contextProtected", true).put("contextSignature", "native-pane-a"))
        val changedPane = changed(pane); n(changedPane, "otherPane").put("contextSignature", "native-pane-b")
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(pane).rebind(NodeActionGuard(changedPane), "field", "input_text") }
    }
    @Test fun allowanceCannotOverlapTargetOrHideInteractiveAncestorMeaning() {
        val overlap = form(); n(overlap, "status").put("bounds", JSONArray(listOf(0, 320, 400, 340)))
        expect("INVALID_ARGUMENT") { NodeActionGuard(overlap).rebind(NodeActionGuard(changed(overlap)), "field", "input_text", listOf("status")) }
        val embedded = form(); n(embedded, "status").put("parentId", "save")
        expect("INVALID_ARGUMENT") { NodeActionGuard(embedded).rebind(NodeActionGuard(changed(embedded)), "field", "input_text", listOf("status")) }
    }
    @Test fun allowedLabelIdentityRoleGeometryAndTopologyStillMustMatch() {
        val changes: List<(JSONObject) -> Unit> = listOf(
            { n(it, "status").put("resourceId", "fixture:id/replaced") },
            { n(it, "status").put("className", "android.widget.Button") },
            { n(it, "status").put("contextProtected", true) },
            { n(it, "status").put("clickable", true) },
            { n(it, "status").put("bounds", JSONArray(listOf(0, 201, 400, 241))) },
            { n(it, "status").put("bounds", JSONArray(listOf(0, 300, 400, 350))) },
            { n(it, "status").put("text", "").put("contentDescription", "Status 1") },
            { n(it, "status").put("parentId", "root") },
            { it.getJSONArray("nodes").put(node("newLayout", "body", bounds = listOf(0, 500, 400, 550))) },
            { n(it, "account").put("bounds", JSONArray(listOf(0, 51, 400, 91))) },
            { n(it, "save").put("enabled", false) }
        )
        for (change in changes) {
            val fresh = changed(form(1)); change(fresh)
            expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(form()).rebind(NodeActionGuard(fresh), "field", "input_text", listOf("status")) }
        }
        val reordered = changed(form(1)); val a = reordered.getJSONArray("nodes")
        reordered.put("nodes", JSONArray(listOf(a.getJSONObject(0), a.getJSONObject(1), a.getJSONObject(5), a.getJSONObject(3), a.getJSONObject(4), a.getJSONObject(2), a.getJSONObject(6), a.getJSONObject(7))))
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(form()).rebind(NodeActionGuard(reordered), "field", "input_text", listOf("status")) }
    }
    @Test fun allowanceUsesOrderedPathsWhenSnapshotHandlesAreRenewed() {
        val original = form(); val fresh = changed(form(1)); val nodes = fresh.getJSONArray("nodes")
        for (i in 0 until nodes.length()) {
            val node = nodes.getJSONObject(i)
            node.put("nodeId", "fresh-${node.getString("nodeId")}")
            if (!node.isNull("parentId")) node.put("parentId", "fresh-${node.getString("parentId")}")
        }
        assertEquals("fresh-field", NodeActionGuard(original).rebind(NodeActionGuard(fresh), "field", "input_text", listOf("status")))
        n(fresh, "fresh-recipient").put("text", "Recipient B")
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(original).rebind(NodeActionGuard(fresh), "field", "input_text", listOf("status")) }
    }
    @Test fun allowanceNeverNormalizesSelectedTargetIdentity() {
        val fresh = changed(form(1)); n(fresh, "field").put("text", "Changed field")
        expect("TARGET_CHANGED", "TARGET_IDENTITY_CHANGED") { NodeActionGuard(form()).rebind(NodeActionGuard(fresh), "field", "input_text", listOf("status")) }
        val protected = form(); n(protected, "recipient").put("contextProtected", true)
        val changedProtection = changed(protected); n(changedProtection, "recipient").put("contextProtected", false)
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(protected).rebind(NodeActionGuard(changedProtection), "field", "input_text") }
    }
    @Test fun labelChangeDiagnosticsUseFreshHandlesAndAllowLabelPresenceChanges() {
        val original = NodeActionGuard(form()); val value = changed(form(1))
        assertEquals(listOf("status"), original.changedLabelNodeIds(NodeActionGuard(value)))
        val nodes = value.getJSONArray("nodes")
        for (i in 0 until nodes.length()) {
            val node = nodes.getJSONObject(i)
            node.put("nodeId", "fresh-${node.getString("nodeId")}")
            if (!node.isNull("parentId")) node.put("parentId", "fresh-${node.getString("parentId")}")
        }
        n(value, "fresh-status").put("text", "").put("contentDescription", "New status description")
        assertEquals(listOf("fresh-status"), original.changedLabelNodeIds(NodeActionGuard(value)))
    }
    @Test fun labelChangeDiagnosticsDescribeCriticalChangesWithoutAuthorizingThem() {
        val previous = form(); n(previous, "recipient").put("contextProtected", true).put("contextSignature", "heading-role")
        val fresh = changed(previous); n(fresh, "recipient").put("text", "Recipient B")
        val original = NodeActionGuard(previous); val current = NodeActionGuard(fresh)
        assertEquals(listOf("recipient"), original.changedLabelNodeIds(current))
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { original.rebind(current, "field", "input_text") }
        expect("INVALID_ARGUMENT") { original.rebind(current, "field", "input_text", listOf("recipient")) }
    }
    @Test fun labelChangeDiagnosticsExcludeMixedUnchangedOrUnboundedDifferences() {
        val original = NodeActionGuard(form())
        assertNull(original.changedLabelNodeIds(NodeActionGuard(changed(form()))))
        val mixed: List<(JSONObject) -> Unit> = listOf(
            { n(it, "status").put("bounds", JSONArray(listOf(0, 201, 400, 241))) },
            { n(it, "status").put("className", "android.widget.Button") },
            { n(it, "status").put("contextSignature", "changed-native-semantics") },
            { n(it, "status").put("contextProtected", true) },
            { n(it, "save").put("enabled", false) },
            { n(it, "status").put("parentId", "root") },
            { it.put("snapshotId", "other:2") },
            { it.put("windowId", 2) },
            { it.put("packageName", "other.fixture") }
        )
        for (change in mixed) {
            val fresh = changed(form(1)); change(fresh)
            assertNull(original.changedLabelNodeIds(NodeActionGuard(fresh)))
        }
        val previous = form()
        for (index in 1..9) previous.getJSONArray("nodes").put(node("extra$index", "body", "Old $index"))
        val fresh = changed(previous)
        for (index in 1..9) n(fresh, "extra$index").put("text", "New $index")
        assertNull(NodeActionGuard(previous).changedLabelNodeIds(NodeActionGuard(fresh)))
    }
    @Test fun nativeRefusalMetadataDoesNotContainObservation() {
        val error = AgentError("TARGET_CHANGED", "Fixed error", true, "PAGE_CONTEXT_CHANGED")
        error.nativeNotSent = true; error.nativeObservation = tree()
        val details = error.toJson().getJSONObject("details")
        assertEquals(setOf("executor", "dispatchState", "reason"), details.keys().asSequence().toSet())
        assertEquals("not_sent", details.getString("dispatchState")); assertEquals("node-v1", details.getString("executor"))
    }
    private fun contextError(previous: JSONObject, fresh: JSONObject, action: String = "input_text", target: String = "field", allowances: List<String> = emptyList()): AgentError {
        try { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), target, action, allowances) }
        catch (error: AgentError) { assertEquals("PAGE_CONTEXT_CHANGED", error.reason); return error }
        throw AssertionError("Expected a native page-context refusal")
    }
    @Test fun contextEvidenceCountsOutsideLabelsWithoutPersistingTheirIdentityOrMeaning() {
        val error = contextError(form(), changed(form(1)))
        val evidence = error.nativeContextChange!!
        assertEquals(NodeActionGuard.ContextChange("outside_target", "content", 1, true, true), evidence)
        // An unannotated recipient change has the same structural evidence.
        // Neither location nor this diagnostic ever declares it harmless.
        val recipient = changed(form()); n(recipient, "recipient").put("text", "Private synthetic recipient B")
        assertEquals(evidence, contextError(form(), recipient).nativeContextChange)
        error.nativeNotSent = true
        val details = error.toJson().getJSONObject("details")
        assertEquals(setOf("executor", "dispatchState", "reason", "contextChange"), details.keys().asSequence().toSet())
        assertEquals(setOf("region", "kind", "changedNodes", "targetMatched", "actionTargetMatched"), details.getJSONObject("contextChange").keys().asSequence().toSet())
        for (privateValue in listOf("Status", "field", "recipient", "fixture", "bounds", "contextSignature")) assertFalse(details.toString().contains(privateValue))
        error.nativeNotSent = false
        assertFalse(error.toJson().has("details"))
    }
    @Test fun contextEvidenceDistinguishesNativeSemanticsStateAndMixedChanges() {
        val semantic = changed(form()); n(semantic, "recipient").put("contextSignature", "private-native-digest")
        assertEquals("unknown", contextError(form(), semantic).nativeContextChange!!.kind)
        val state = changed(form()); n(state, "status").put("selected", true)
        assertEquals("state", contextError(form(), state).nativeContextChange!!.kind)
        val mixed = changed(form(1)); n(mixed, "save").put("enabled", false)
        assertEquals(NodeActionGuard.ContextChange("outside_target", "mixed", 2, true, true), contextError(form(), mixed).nativeContextChange)
    }
    @Test fun contextEvidenceDoesNotClaimMatchedGeometryOrReplacedTopology() {
        val shifted = changed(form(1)); n(shifted, "field").put("bounds", JSONArray(listOf(0, 301, 400, 351)))
        assertEquals(NodeActionGuard.ContextChange("mixed", "mixed", 2, false, false), contextError(form(), shifted).nativeContextChange)
        val replaced = changed(form(1)); n(replaced, "status").put("resourceId", "fixture:id/replaced")
        assertEquals(NodeActionGuard.ContextChange("unknown", "structure", 0, false, false), contextError(form(), replaced).nativeContextChange)
    }
    @Test fun contextEvidenceRequiresSelectedAndActualNodeCorrespondence() {
        val old = tree(); val fresh = changed(tree("Tick 2")); val a = fresh.getJSONArray("nodes")
        fresh.put("nodes", JSONArray(listOf(a.getJSONObject(0), a.getJSONObject(1), a.getJSONObject(4), a.getJSONObject(5), a.getJSONObject(2), a.getJSONObject(3))))
        assertEquals(NodeActionGuard.ContextChange("unknown", "structure", 0, false, false), contextError(old, fresh, "tap_element", "target").nativeContextChange)
        val targetChanged = changed(form()); n(targetChanged, "field").put("text", "Changed input identity")
        try { NodeActionGuard(form()).rebind(NodeActionGuard(targetChanged), "field", "input_text"); fail("Expected changed identity") }
        catch (error: AgentError) { assertEquals("TARGET_IDENTITY_CHANGED", error.reason); assertNull(error.nativeContextChange) }
    }
    @Test fun contextEvidenceAcceptsRenewedHandlesAndIdentifiesPeerContent() {
        val previous = form(); val fresh = changed(form(1)); val array = fresh.getJSONArray("nodes")
        for (i in 0 until array.length()) {
            val node = array.getJSONObject(i); node.put("nodeId", "fresh-${node.getString("nodeId")}")
            if (!node.isNull("parentId")) node.put("parentId", "fresh-${node.getString("parentId")}")
        }
        assertEquals(NodeActionGuard.ContextChange("outside_target", "content", 1, true, true), contextError(previous, fresh).nativeContextChange)
        val oldList = tree(); n(oldList, "peerLabel").put("contextProtected", true)
        val freshList = changed(oldList); n(freshList, "peerLabel").put("text", "Changed protected peer")
        assertEquals(NodeActionGuard.ContextChange("peer_item", "content", 1, true, true), contextError(oldList, freshList, "click_element", "targetLabel").nativeContextChange)
    }
}
