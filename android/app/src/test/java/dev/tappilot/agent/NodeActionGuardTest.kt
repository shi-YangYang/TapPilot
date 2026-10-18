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
    private fun reordered(value: JSONObject): JSONObject {
        val a = value.getJSONArray("nodes")
        value.put("nodes", JSONArray(listOf(a.getJSONObject(0), a.getJSONObject(1), a.getJSONObject(4), a.getJSONObject(5), a.getJSONObject(2), a.getJSONObject(3))))
        for (id in listOf("target", "targetLabel")) n(value, id).put("bounds", JSONArray(listOf(0, 100, 400, 200)))
        for (id in listOf("peer", "peerLabel")) n(value, id).put("bounds", JSONArray(listOf(0, 0, 400, 100)))
        return value
    }
    @Test fun reorderedNativeRowsRebindByUniqueIdentityDuringPeerRefresh() {
        val previous = NodeActionGuard(tree())
        for (tick in 2..20) {
            val fresh = reordered(tree("Tick $tick").put("snapshotId", "fixture:$tick").put("revision", tick))
            val current = NodeActionGuard(fresh)
            for (action in listOf("tap_element", "click_element")) {
                assertEquals("target", previous.rebind(current, "target", action))
                assertEquals("targetLabel", previous.rebind(current, "targetLabel", action))
            }
            val touch = current.touch("targetLabel", 400, 600)
            assertEquals("target", touch.actedNodeId)
            assertTrue("Touch follows the new target position", touch.y in 100 until 200)
        }
    }
    @Test fun rowPermutationWithRecreatedNativeHandlesStillFindsTheOriginalRow() {
        val previous = tree()
        val fresh = reordered(changed(tree("Tick 2")))
        val nodes = fresh.getJSONArray("nodes")
        for (i in 0 until nodes.length()) {
            val node = nodes.getJSONObject(i)
            node.put("nodeId", "fresh-${node.getString("nodeId")}")
            if (!node.isNull("parentId")) node.put("parentId", "fresh-${node.getString("parentId")}")
        }
        assertEquals("fresh-target", NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "target", "tap_element"))
    }
    @Test fun collectionPermutationRequiresTheSameUniqueRowsAndCriticalContext() {
        val changes: List<(JSONObject) -> Unit> = listOf(
            { n(it, "peer").put("contentDescription", "Replacement row") },
            { n(it, "peer").put("selected", true) },
            { n(it, "peerLabel").put("contextProtected", true) },
            { n(it, "peerLabel").put("bounds", JSONArray(listOf(0, 90, 400, 120))) },
            { n(it, "list").put("className", "android.view.ViewGroup") }
        )
        for (change in changes) {
            val fresh = reordered(changed(tree("Tick 2"))); change(fresh)
            expect("TARGET_CHANGED") { NodeActionGuard(tree()).rebind(NodeActionGuard(fresh), "target", "tap_element") }
        }
        val duplicateRows = tree()
        n(duplicateRows, "peer").put("resourceId", n(duplicateRows, "target").getString("resourceId"))
            .put("contentDescription", "Target row")
        val fresh = reordered(changed(duplicateRows)); n(fresh, "peerLabel").put("text", "Tick 2")
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(duplicateRows).rebind(NodeActionGuard(fresh), "target", "tap_element") }
    }
    @Test fun rowPermutationNeverTreatsReusedResourceAndLabelAsUnchangedTargetContent() {
        val previous = tree()
        n(previous, "targetLabel").put("text", "Recipient A · Amount 100").put("contextProtected", true)
        val fresh = reordered(changed(previous))
        // The native ID and outer row description are unchanged, but its
        // recipient/amount is new. Rebinding must never use those IDs alone.
        n(fresh, "targetLabel").put("text", "Recipient B · Amount 200")
        expect("TARGET_CHANGED", "TARGET_IDENTITY_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "target", "tap_element") }
    }
    @Test fun nativeRowPermutationDoesNotAuthorizeFormInputOrOutsideContextChanges() {
        val formRow = tree(); n(formRow, "targetLabel").put("editable", true)
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") {
            NodeActionGuard(formRow).rebind(NodeActionGuard(reordered(changed(formRow))), "targetLabel", "input_text")
        }
        val previous = tree()
        previous.getJSONArray("nodes").put(node("recipient", "root", "Recipient A", listOf(0, 400, 400, 480)))
        val fresh = changed(previous)
        val a = fresh.getJSONArray("nodes")
        fresh.put("nodes", JSONArray(listOf(a.getJSONObject(0), a.getJSONObject(1), a.getJSONObject(4), a.getJSONObject(5), a.getJSONObject(2), a.getJSONObject(3), a.getJSONObject(6))))
        n(fresh, "recipient").put("text", "Recipient B")
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
    private fun layeredScrollPage(): JSONObject = JSONObject().put("snapshotId", "fixture:1").put("revision", 1)
        .put("packageName", "fixture.app").put("windowId", 1).put("truncated", false).put("nodes", JSONArray(listOf(
            node("root", null).put("nativePath", JSONArray()).put("nativeDrawingOrder", 0),
            node("background", "root", scrollable = true, className = "android.widget.ScrollView")
                .put("nativePath", JSONArray(listOf(0))).put("nativeDrawingOrder", 1),
            node("label", "background", "Public page", listOf(0, 0, 400, 100))
                .put("nativePath", JSONArray(listOf(0, 0))).put("nativeDrawingOrder", 1),
            node("button", "root", "Continue", listOf(300, 500, 390, 590), clickable = true)
                .put("nativePath", JSONArray(listOf(1))).put("nativeDrawingOrder", 2))))
    @Test fun backgroundPassiveScrollContainerDoesNotCoverHigherNativeSiblingButton() {
        val guard = NodeActionGuard(layeredScrollPage())
        assertEquals("button", guard.touch("button", 400, 600).actedNodeId)
        guard.validateShortGesture(345, 545, 345, 545)
    }
    @Test fun targetDescendantCanUseItsProvenHigherNativeSiblingBranch() {
        val value = layeredScrollPage()
        val button = n(value, "button")
        value.getJSONArray("nodes").put(node("frontGroup", "root").put("nativePath", JSONArray(listOf(1))).put("nativeDrawingOrder", 2))
        button.put("parentId", "frontGroup").put("nativePath", JSONArray(listOf(1, 0))).put("nativeDrawingOrder", 1)
        assertEquals("button", NodeActionGuard(value).touch("button", 400, 600).actedNodeId)
    }
    @Test fun foregroundEqualUnknownOrDifferentNativeParentNeverBypassesBlocker() {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { n(it, "background").put("nativeDrawingOrder", 3) },
            { n(it, "background").put("nativeDrawingOrder", 2) },
            { n(it, "background").put("nativeDrawingOrder", 0) },
            { n(it, "background").remove("nativeDrawingOrder") },
            { n(it, "button").remove("nativeDrawingOrder") },
            { n(it, "background").remove("nativePath") },
            { n(it, "background").put("nativePath", JSONArray(listOf(9, 0))) },
            { n(it, "background").put("nativePath", JSONArray(listOf(-1))) }
        )
        for (mutate in mutations) {
            val value = layeredScrollPage(); mutate(value)
            expect("NODE_NOT_ACTIONABLE", "AMBIGUOUS_TOUCH_TARGET") { NodeActionGuard(value).touch("button", 400, 600) }
        }
    }
    @Test fun lowerContainerContentAndControlsRemainBlockers() {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { n(it, "background").put("text", "Meaningful overlay") },
            { n(it, "background").put("contentDescription", "Meaningful overlay") },
            { n(it, "background").put("clickable", true) },
            { n(it, "background").put("editable", true) },
            { n(it, "background").put("checkable", true) },
            { n(it, "background").put("contextProtected", true) },
            { n(it, "label").put("bounds", JSONArray(listOf(0, 0, 400, 600))) }
        )
        for (mutate in mutations) {
            val value = layeredScrollPage(); mutate(value)
            expect("NODE_NOT_ACTIONABLE", "AMBIGUOUS_TOUCH_TARGET") { NodeActionGuard(value).touch("button", 400, 600) }
        }
    }
    @Test fun sensitiveLowerContainerAndOverlappingDescendantStillRequireManualAction() {
        for (id in listOf("background", "label")) {
            val value = layeredScrollPage()
            n(value, id).put("text", "确认支付").put("bounds", JSONArray(listOf(0, 0, 400, 600)))
            expect("MANUAL_ACTION_REQUIRED") { NodeActionGuard(value).touch("button", 400, 600) }
            expect("MANUAL_ACTION_REQUIRED") { NodeActionGuard(value).validateShortGesture(345, 545, 345, 545) }
        }
    }
    @Test fun changedLayerOrderIsNeverSuggestedAsOnlyALabelChange() {
        val original = layeredScrollPage(); val fresh = changed(original)
        n(fresh, "label").put("text", "New public page")
        n(fresh, "background").put("nativeDrawingOrder", 3)
        assertNull(NodeActionGuard(original).changedLabelNodeIds(NodeActionGuard(fresh)))
        expect("NODE_NOT_ACTIONABLE", "AMBIGUOUS_TOUCH_TARGET") { NodeActionGuard(fresh).touch("button", 400, 600) }
    }
    @Test fun sensitiveDescendantAndRawGestureRemainBlocked() {
        val value = tree(); n(value, "targetLabel").put("text", "确认支付")
        expect("MANUAL_ACTION_REQUIRED") { NodeActionGuard(value).touch("target", 400, 600) }
        expect("MANUAL_ACTION_REQUIRED") { NodeActionGuard(value).validateShortGesture(100, 50, 100, 50) }
    }
    @Test fun truncatedTreeCannotAuthorizeRebind() {
        expect("TARGET_CHANGED", "TREE_INCOMPLETE") { NodeActionGuard(tree().put("truncated", true)) }
    }
    private fun withNativeText(node: JSONObject, text: String) {
        val evidence = NodeActionGuard.nativeStringEvidence(text, node.getString("contentDescription"), node.getString("resourceId"), node.getString("className"))
        node.put("text", text.take(1000))
        evidence.keys().forEach { key -> node.put(key, evidence.get(key)) }
    }
    @Test fun completeNativeEvidenceKeepsClippedAndExactlyCappedLabelsActionable() {
        // A real-app privacy dialog exposed one long passive label and two
        // buttons: complete tree evidence was incorrectly called incomplete.
        for (length in listOf(1000, 1001, 4000)) {
            val previous = form(); withNativeText(n(previous, "recipient"), "A".repeat(length))
            val fresh = changed(previous)
            assertEquals("save", NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "save", "tap_element"))
            assertEquals("save", NodeActionGuard(fresh).touch("save", 400, 800).actedNodeId)
            assertFalse("Native evidence contains no full label", n(previous, "recipient").getJSONObject("nativeFieldSignatures").toString().contains("A".repeat(100)))
        }
    }
    @Test fun clippedTailChangesRemainPartOfTargetAndPageContextIdentity() {
        val previous = form(); withNativeText(n(previous, "recipient"), "A".repeat(1000) + "recipient-one")
        val fresh = changed(previous); withNativeText(n(fresh, "recipient"), "A".repeat(1000) + "recipient-two")
        val error = contextError(previous, fresh, "tap_element", "save")
        assertEquals(NodeActionGuard.ContextChange("outside_target", "content", 1, true, true), error.nativeContextChange)
        assertNull("A hidden tail is not a caller-readable label allowance", NodeActionGuard(previous).changedLabelNodeIds(NodeActionGuard(fresh)))
        val target = form(); withNativeText(n(target, "save"), "A".repeat(1000) + "one")
        val other = changed(target); withNativeText(n(other, "save"), "A".repeat(1000) + "two")
        expect("TARGET_CHANGED", "TARGET_IDENTITY_CHANGED") { NodeActionGuard(target).rebind(NodeActionGuard(other), "save", "tap_element") }
    }
    @Test fun clippedLabelsWithoutValidNativeProofStillFailClosed() {
        for (proof in listOf(null, JSONObject(), JSONObject().put("text", "invalid"))) {
            val previous = form(); n(previous, "recipient").put("text", "A".repeat(1000))
            if (proof != null) n(previous, "recipient").put("nativeFieldSignatures", proof)
            expect("TARGET_CHANGED", "TREE_INCOMPLETE") { NodeActionGuard(previous).rebind(NodeActionGuard(changed(previous)), "save", "tap_element") }
        }
    }
    @Test fun nativeEvidencePreservesSensitiveWordsBeyondThePublicPrefix() {
        val previous = form(); withNativeText(n(previous, "save"), "A".repeat(1000) + " 确认支付")
        val guard = NodeActionGuard(previous)
        expect("MANUAL_ACTION_REQUIRED") { guard.clickTarget("save") }
        expect("MANUAL_ACTION_REQUIRED") { guard.touch("save", 400, 800) }
        expect("MANUAL_ACTION_REQUIRED") { guard.validateShortGesture(200, 420, 200, 420) }
    }
    @Test fun clippedLabelProofNeverAuthorizesIgnoringItsUnreadableTail() {
        val previous = form(); withNativeText(n(previous, "status"), "A".repeat(1000) + "one")
        val fresh = changed(previous); withNativeText(n(fresh, "status"), "A".repeat(1000) + "two")
        expect("INVALID_ARGUMENT") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "save", "tap_element", listOf("status")) }
        n(fresh, "amount").put("text", "Visible change")
        assertNull("Do not hide a simultaneous unseen-tail change behind visible-label hints", NodeActionGuard(previous).changedLabelNodeIds(NodeActionGuard(fresh)))
        val collection = tree(); withNativeText(n(collection, "peerLabel"), "A".repeat(1000) + "one")
        val updated = changed(collection); withNativeText(n(updated, "peerLabel"), "A".repeat(1000) + "two")
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(collection).rebind(NodeActionGuard(updated), "target", "tap_element") }
    }
    /** Synthetic role/geometry shape from a real search screen; no app/account content. */
    private fun searchPage(): JSONObject = JSONObject().put("snapshotId", "fixture:1").put("revision", 1)
        .put("packageName", "fixture.app").put("windowId", 1).put("truncated", false).put("nodes", JSONArray(listOf(
            node("root", null, bounds = listOf(0, 0, 400, 800), className = "android.widget.FrameLayout"),
            node("bar", "root", bounds = listOf(0, 20, 400, 100), className = "android.widget.LinearLayout"),
            node("query", "bar", "合成原始词", listOf(50, 30, 330, 90), true, className = "android.widget.EditText", description = "搜索").put("editable", true).put("focused", true),
            node("mode", "bar", "商品", listOf(50, 30, 100, 90), true),
            node("submit", "bar", "搜索", listOf(330, 20, 400, 100), true).put("resourceId", "fixture:id/search_button"),
            node("body", "root", bounds = listOf(0, 100, 400, 800), className = "android.widget.ScrollView"),
            node("heading", "body", "合成搜索发现", listOf(0, 100, 400, 140)),
            node("suggestions", "body", bounds = listOf(0, 140, 400, 250), className = "androidx.recyclerview.widget.RecyclerView"),
            node("suggestion", "suggestions", "合成推荐词", listOf(0, 150, 200, 190), true)))).also {
            n(it, "body").put("scrollable", false)
        }
    private fun loadedSearchPage(previous: JSONObject): JSONObject = changed(previous).also {
        n(it, "body").put("scrollable", true)
        it.getJSONArray("nodes")
            .put(node("recommendations", "body", bounds = listOf(0, 250, 400, 800), scrollable = true, className = "androidx.recyclerview.widget.RecyclerView"))
            .put(node("recommendation", "recommendations", "合成商品", listOf(0, 260, 200, 400), true))
            .put(node("voice", "root", bounds = listOf(80, 600, 220, 640), className = "android.view.ViewGroup"))
            .put(node("voiceLabel", "voice", "合成提示", listOf(90, 610, 210, 630)))
            .put(node("help", "root", bounds = listOf(250, 600, 350, 640), clickable = true, className = "android.view.ViewGroup"))
            .put(node("helpLabel", "help", "合成帮助", listOf(260, 610, 340, 630)))
    }
    @Test fun dedicatedSearchToolbarSurvivesIndependentBodyLoadingForInputAndSubmit() {
        val previous = searchPage(); val fresh = loadedSearchPage(previous)
        assertEquals("query", NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "query", "input_text"))
        for (action in listOf("tap_element", "click_element")) {
            assertEquals("submit", NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "submit", action))
            assertEquals("submit", NodeActionGuard(fresh).touch("submit", 400, 800).actedNodeId)
        }
        val updated = changed(fresh); n(updated, "recommendation").put("text", "新合成商品")
        assertEquals("query", NodeActionGuard(fresh).rebind(NodeActionGuard(updated), "query", "input_text"))
        // Geometry/labels/roles are identical even when native handles are renewed.
        val nodes = updated.getJSONArray("nodes")
        for (index in 0 until nodes.length()) {
            val item = nodes.getJSONObject(index); item.put("nodeId", "new-${item.getString("nodeId")}")
            if (!item.isNull("parentId")) item.put("parentId", "new-${item.getString("parentId")}")
        }
        assertEquals("new-submit", NodeActionGuard(fresh).rebind(NodeActionGuard(updated), "submit", "tap_element"))
    }
    @Test fun searchScopeNeverWaivesQueryModeGeometryOrOrdinaryOutsideContext() {
        val changes: List<(JSONObject) -> Unit> = listOf(
            { n(it, "query").put("text", "另一个合成查询") },
            { n(it, "mode").put("text", "店铺") },
            { n(it, "bar").put("bounds", JSONArray(listOf(0, 21, 400, 101))) },
            { n(it, "heading").put("text", "Recipient B · Amount 200") },
            { n(it, "query").put("contentDescription", "普通表单") }
        )
        for (change in changes) {
            val previous = searchPage(); val fresh = loadedSearchPage(previous); change(fresh)
            for ((target, action) in listOf("query" to "input_text", "submit" to "tap_element")) {
                expect("TARGET_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), target, action) }
            }
        }
    }
    @Test fun searchScopeRejectsOtherFieldsProtectedContextOverlapsAndNewSurfacesOutsideKnownBody() {
        val changes: List<(JSONObject) -> Unit> = listOf(
            { n(it, "recommendation").put("editable", true) },
            { n(it, "recommendation").put("checkable", true) },
            { n(it, "heading").put("contextProtected", true) },
            { n(it, "helpLabel").put("text", "确认支付") },
            { n(it, "help").put("bounds", JSONArray(listOf(250, 50, 350, 90))); n(it, "helpLabel").put("bounds", JSONArray(listOf(260, 60, 340, 80))) },
            { n(it, "help").put("bounds", JSONArray(listOf(250, 0, 350, 10))); n(it, "helpLabel").put("bounds", JSONArray(listOf(260, 1, 340, 9))) },
            { n(it, "help").put("bounds", JSONArray(listOf(0, 200, 400, 500))) }
        )
        for (change in changes) {
            val previous = searchPage(); val fresh = loadedSearchPage(previous); change(fresh)
            expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "query", "input_text") }
        }
        val protected = searchPage(); n(protected, "heading").put("contextProtected", true)
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(protected).rebind(NodeActionGuard(loadedSearchPage(protected)), "query", "input_text") }
    }
    @Test fun searchScopeCannotLoseOrRewritePreviouslyObservedFloatingControls() {
        val previous = loadedSearchPage(searchPage())
        val fresh = changed(previous); n(fresh, "helpLabel").put("text", "新的业务操作")
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "query", "input_text") }
        val removed = changed(previous)
        removed.put("nodes", JSONArray((0 until previous.getJSONArray("nodes").length()).map(previous.getJSONArray("nodes")::getJSONObject)
            .filterNot { it.getString("nodeId") in setOf("help", "helpLabel") }))
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(removed), "submit", "tap_element") }
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
        // A generic layout has no independent native collection-row contract;
        // unlike a verified list permutation, its positional evidence stays unknown.
        val old = tree(); n(old, "list").put("className", "android.view.ViewGroup")
        val fresh = changed(old); n(fresh, "peerLabel").put("text", "Tick 2")
        val a = fresh.getJSONArray("nodes")
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
    private fun nativeTabs(): JSONObject {
        val result = JSONObject().put("snapshotId", "fixture:1").put("revision", 1).put("packageName", "fixture.app")
            .put("windowId", 1).put("truncated", false).put("nodes", JSONArray(listOf(
                node("root", null, bounds = listOf(0, 0, 400, 800)),
                node("body", "root", bounds = listOf(0, 0, 400, 600)),
                node("status", "body", "Observed value 1", listOf(0, 120, 400, 180), description = "Reported metric 1"),
                node("tabs", "root", bounds = listOf(0, 600, 400, 700)),
                node("first", "tabs", description = "Library", bounds = listOf(0, 600, 200, 700), clickable = true).put("selected", true),
                node("second", "tabs", description = "Explore", bounds = listOf(200, 600, 400, 700), clickable = true),
                node("secondLabel", "second", "Explore", listOf(210, 610, 390, 690)))))
        val array = result.getJSONArray("nodes")
        for (i in 0 until array.length()) array.getJSONObject(i).put("nativeCollection", JSONObject.NULL)
            .put("nativeCollectionItem", JSONObject.NULL).put("nativeTabRole", false)
        n(result, "tabs").put("nativeCollection", JSONObject().put("rows", 1).put("columns", 2).put("hierarchical", false).put("selectionMode", 1))
        for ((index, id) in listOf("first", "second").withIndex()) n(result, id).put("nativeTabRole", true)
            .put("nativeCollectionItem", JSONObject().put("row", 0).put("rowSpan", 1).put("column", index).put("columnSpan", 1)
                .put("heading", false).put("selected", index == 0))
        return result
    }
    private fun refreshedTabs(previous: JSONObject = nativeTabs(), tick: Int = 2): JSONObject = changed(previous).also {
        n(it, "status").put("text", "Observed value $tick").put("contentDescription", "Reported metric $tick")
    }
    @Test fun nativeTabNavigationAcceptsContinuousOutsideLabelsWithoutAppOrValuePatterns() {
        for (variant in 0..1) {
            val previous = nativeTabs()
            if (variant == 1) {
                previous.put("packageName", "other.viewer")
                val nodes = previous.getJSONArray("nodes")
                for (i in 0 until nodes.length()) nodes.getJSONObject(i).put("resourceId", "other.viewer:id/component$i")
                n(previous, "first").put("contentDescription", "收藏")
                n(previous, "second").put("contentDescription", "发现")
                n(previous, "secondLabel").put("text", "发现")
            }
            val old = NodeActionGuard(previous)
            for (tick in 2..20) {
                val fresh = refreshedTabs(previous, tick)
                if (variant == 1) n(fresh, "status").put("text", "正在显示第 $tick 个观察值").put("contentDescription", "本次值 $tick")
                for (action in listOf("tap_element", "click_element")) {
                    val evidence = old.rebindEvidence(NodeActionGuard(fresh), "secondLabel", action)
                    assertEquals(NodeActionGuard.RebindEvidence("secondLabel", "native_tab_navigation", 1), evidence)
                    assertEquals("second", NodeActionGuard(fresh).clickTarget(evidence.nodeId))
                    assertEquals("second", NodeActionGuard(fresh).touch(evidence.nodeId, 400, 800).actedNodeId)
                }
            }
        }
    }
    @Test fun nativeTabEvidencePreservesExistingVerificationNamesAndExplicitContract() {
        val previous = nativeTabs(); val guard = NodeActionGuard(previous)
        assertEquals(NodeActionGuard.RebindEvidence("second", "default_context"), guard.rebindEvidence(NodeActionGuard(changed(previous)), "second", "tap_element"))
        assertEquals(NodeActionGuard.RebindEvidence("second", "explicit_label_changes"), guard.rebindEvidence(NodeActionGuard(refreshedTabs(previous)), "second", "tap_element", listOf("status")))
        // No automatic relaxation for input/scroll even when the native tab bar exists.
        for ((action, flag) in listOf("input_text" to "editable", "scroll" to "scrollable")) {
            val old = nativeTabs(); n(old, "second").put(flag, true)
            expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(old).rebind(NodeActionGuard(refreshedTabs(old)), "second", action) }
        }
    }
    @Test fun nativeTabContextCannotBeInventedFromGeometryOrRoleAlone() {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { n(it, "tabs").remove("nativeCollection") },
            { n(it, "tabs").getJSONObject("nativeCollection").put("columns", 3) },
            { n(it, "tabs").getJSONObject("nativeCollection").put("rows", 2) },
            { n(it, "tabs").getJSONObject("nativeCollection").put("selectionMode", 2) },
            { n(it, "tabs").getJSONObject("nativeCollection").put("hierarchical", true) },
            { n(it, "second").remove("nativeCollectionItem") },
            { n(it, "second").put("nativeTabRole", false) },
            { n(it, "second").getJSONObject("nativeCollectionItem").put("column", 0) },
            { n(it, "second").getJSONObject("nativeCollectionItem").put("columnSpan", 2) },
            { n(it, "second").getJSONObject("nativeCollectionItem").put("heading", true) },
            { n(it, "second").getJSONObject("nativeCollectionItem").put("selected", true) },
            { n(it, "first").put("selected", false).getJSONObject("nativeCollectionItem").put("selected", false) },
            { n(it, "second").put("selected", true).getJSONObject("nativeCollectionItem").put("selected", true) }
        )
        for (mutation in mutations) {
            val old = nativeTabs(); mutation(old)
            expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(old).rebind(NodeActionGuard(refreshedTabs(old)), "second", "tap_element") }
        }
        val selected = nativeTabs()
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(selected).rebind(NodeActionGuard(refreshedTabs(selected)), "first", "tap_element") }
    }
    @Test fun tabInferenceCannotOverrideUnannotatedBusinessOrFormContext() {
        for (label in listOf("Recipient A", "Account 21", "Amount 100", "Order 13", "收件人甲", "收款账户甲", "支付金额 100", "付款", "Send", "Delete")) {
            val previous = nativeTabs()
            previous.getJSONArray("nodes").put(node("business", "body", label, listOf(0, 200, 400, 250), className = "android.widget.TextView").put("resourceId", ""))
            expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(refreshedTabs(previous)), "second", "tap_element") }
            val fresh = changed(previous); n(fresh, "business").put("text", "$label changed")
            expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "second", "tap_element") }
        }
        for (flag in listOf("editable", "checkable", "password", "nativeSensitive")) {
            val previous = nativeTabs(); n(previous, "body").put(flag, true)
            expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(refreshedTabs(previous)), "second", "tap_element") }
        }
    }
    @Test fun nativeTabNavigationRequiresAllOtherStateGeometryTopologyAndMetadataExact() {
        val changes: List<(JSONObject) -> Unit> = listOf(
            { n(it, "status").put("bounds", JSONArray(listOf(0, 121, 400, 181))) },
            { n(it, "body").put("bounds", JSONArray(listOf(0, 0, 400, 599))) },
            { n(it, "status").put("enabled", false) },
            { n(it, "status").put("selected", true) },
            { n(it, "status").put("className", "android.widget.TextView") },
            { n(it, "status").put("resourceId", "replacement") },
            { n(it, "status").put("parentId", "root") },
            { n(it, "body").put("text", "New page") },
            { n(it, "tabs").put("bounds", JSONArray(listOf(0, 600, 400, 701))) },
            { n(it, "second").put("bounds", JSONArray(listOf(201, 600, 400, 700))) },
            { n(it, "secondLabel").put("bounds", JSONArray(listOf(211, 610, 390, 690))) },
            { n(it, "secondLabel").put("text", "Different destination") },
            { n(it, "first").put("contentDescription", "Different sibling") },
            { n(it, "first").put("enabled", false) },
            { n(it, "tabs").getJSONObject("nativeCollection").put("selectionMode", 2) },
            { n(it, "first").getJSONObject("nativeCollectionItem").put("columnSpan", 2) },
            { n(it, "status").put("nativeDrawingOrder", 2) },
            { n(it, "status").put("nativePath", JSONArray(listOf(0, 2))) },
            { it.getJSONArray("nodes").put(node("new", "body", bounds = listOf(0, 300, 400, 350))) }
        )
        for (change in changes) {
            val previous = nativeTabs(); val fresh = refreshedTabs(previous); change(fresh)
            expect("TARGET_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "secondLabel", "tap_element") }
        }
    }
    @Test fun nativeTabOutsideLabelsMustRemainIndependentPassiveAndUnassociated() {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { n(it, "status").put("contextProtected", true) },
            { n(it, "status").put("contextSignature", "associated-native-label") },
            { n(it, "body").put("contextProtected", true) },
            { n(it, "body").put("clickable", true) },
            { n(it, "status").put("clickable", true) },
            { n(it, "status").put("focused", true) },
            { n(it, "status").put("bounds", JSONArray(listOf(0, 590, 400, 620))) },
            { it.getJSONArray("nodes").put(node("statusChild", "status", "Child", listOf(0, 120, 100, 140))) }
        )
        for (mutation in mutations) {
            val previous = nativeTabs(); mutation(previous)
            expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(refreshedTabs(previous)), "second", "tap_element") }
        }
    }
    @Test fun nativeTabAutomaticChangesAreBoundedAndKeepLabelChannelsAndClipping() {
        val previous = nativeTabs()
        for (i in 1..8) previous.getJSONArray("nodes").put(node("extra$i", "body", "Value $i", listOf(0, 200 + i * 20, 400, 215 + i * 20)))
        val fresh = refreshedTabs(previous)
        for (i in 1..7) n(fresh, "extra$i").put("text", "New value $i")
        assertEquals(8, NodeActionGuard(previous).rebindEvidence(NodeActionGuard(fresh), "second", "tap_element").automaticLabelChangesCount)
        n(fresh, "extra8").put("text", "New value 8")
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "second", "tap_element") }
        val missingChannel = refreshedTabs(); n(missingChannel, "status").put("text", "")
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(nativeTabs()).rebind(NodeActionGuard(missingChannel), "second", "tap_element") }
        val long = nativeTabs(); n(long, "status").put("text", "x".repeat(1000)).put("nativeFieldSignatures", JSONObject().put("text", "a".repeat(64)))
        val changedLong = changed(long); n(changedLong, "status").getJSONObject("nativeFieldSignatures").put("text", "b".repeat(64))
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(long).rebind(NodeActionGuard(changedLong), "second", "tap_element") }
    }
    @Test fun nativeTabNavigationSupportsRenewedHandlesButRetainsSensitiveTargetRules() {
        val old = nativeTabs(); val fresh = refreshedTabs(old); val nodes = fresh.getJSONArray("nodes")
        for (i in 0 until nodes.length()) {
            val node = nodes.getJSONObject(i); node.put("nodeId", "fresh-${node.getString("nodeId")}")
            if (!node.isNull("parentId")) node.put("parentId", "fresh-${node.getString("parentId")}")
        }
        assertEquals(NodeActionGuard.RebindEvidence("fresh-secondLabel", "native_tab_navigation", 1),
            NodeActionGuard(old).rebindEvidence(NodeActionGuard(fresh), "secondLabel", "tap_element"))
        val unsafe = nativeTabs(); n(unsafe, "secondLabel").put("text", "确认支付")
        expect("MANUAL_ACTION_REQUIRED") { NodeActionGuard(unsafe).clickTarget("secondLabel") }
        expect("MANUAL_ACTION_REQUIRED") { NodeActionGuard(unsafe).touch("secondLabel", 400, 800) }
    }

    @Test fun nativeTabSelectedItemNeedNotExposeAnotherClickAction() {
        // Material TabLayout removes ACTION_CLICK from the currently selected tab.
        val previous = nativeTabs(); n(previous, "first").put("clickable", false)
        val fresh = refreshedTabs(previous)
        assertEquals(NodeActionGuard.RebindEvidence("second", "native_tab_navigation", 1),
            NodeActionGuard(previous).rebindEvidence(NodeActionGuard(fresh), "second", "tap_element"))
        val invalid = nativeTabs(); n(invalid, "second").put("clickable", false)
        assertNull(NodeActionGuard(invalid).nativeTabReadinessSignature())
    }
    @Test fun nativeTabReadinessSamplesIgnoreOnlyTheSameBoundedPassiveLabelChannels() {
        val previous = nativeTabs(); n(previous, "first").put("clickable", false)
        val baseline = NodeActionGuard(previous).nativeTabReadinessSignature()
        assertNotNull(baseline)
        assertTrue(baseline!!.matches(Regex("[0-9a-f]{64}")))
        for (tick in 2..40) assertEquals(baseline, NodeActionGuard(refreshedTabs(previous, tick)).nativeTabReadinessSignature())
        val renamed = refreshedTabs(previous)
        val array = renamed.getJSONArray("nodes")
        for (i in 0 until array.length()) {
            val node = array.getJSONObject(i); node.put("nodeId", "fresh-${node.getString("nodeId")}")
            if (!node.isNull("parentId")) node.put("parentId", "fresh-${node.getString("parentId")}")
        }
        assertEquals(baseline, NodeActionGuard(renamed).nativeTabReadinessSignature())
        assertNotEquals(baseline, NodeActionGuard(refreshedTabs(previous).also { n(it, "status").put("text", "") }).nativeTabReadinessSignature())
        val crowded = nativeTabs()
        for (i in 1..8) crowded.getJSONArray("nodes").put(node("extra$i", "body", "Value $i", listOf(0, 200 + i * 20, 400, 215 + i * 20)))
        assertNull(NodeActionGuard(crowded).nativeTabReadinessSignature())
    }
    @Test fun nativeTabReadinessNeverMasksBusinessMetadataGeometryOrControlChanges() {
        val previous = nativeTabs(); val baseline = NodeActionGuard(previous).nativeTabReadinessSignature()
        assertNotNull(baseline)
        val changes: List<(JSONObject) -> Unit> = listOf(
            { n(it, "status").put("text", "Recipient A") },
            { n(it, "status").put("contentDescription", "金额 100") },
            { n(it, "body").put("editable", true) },
            { n(it, "body").put("checkable", true) },
            { n(it, "body").put("password", true) },
            { n(it, "status").put("nativeSensitive", true) },
            { n(it, "status").put("contextProtected", true) },
            { n(it, "status").put("contextSignature", "native-heading") },
            { n(it, "status").put("bounds", JSONArray(listOf(0, 121, 400, 181))) },
            { n(it, "body").put("bounds", JSONArray(listOf(0, 0, 400, 599))) },
            { n(it, "status").put("enabled", false) },
            { n(it, "status").put("nativeDrawingOrder", 2) },
            { n(it, "tabs").getJSONObject("nativeCollection").put("columns", 3) },
            { n(it, "second").getJSONObject("nativeCollectionItem").put("selected", true) },
            { n(it, "second").put("nativeTabRole", false) },
            { n(it, "secondLabel").put("text", "Different destination") },
            { it.put("windowId", 2) },
            { it.put("packageName", "other.app") },
            { it.getJSONArray("nodes").put(node("added", "body", bounds = listOf(0, 300, 400, 350))) }
        )
        for (change in changes) {
            val fresh = refreshedTabs(previous); change(fresh)
            assertNotEquals(baseline, NodeActionGuard(fresh).nativeTabReadinessSignature())
        }
        assertNull(NodeActionGuard(form()).nativeTabReadinessSignature())
    }
    @Test fun nativeTabReadinessDoesNotAuthorizeAnOrdinaryButtonOnTheSamePage() {
        val previous = nativeTabs()
        previous.getJSONArray("nodes").put(node("ordinary", "body", "Open details", listOf(0, 300, 400, 350), clickable = true))
        val fresh = refreshedTabs(previous)
        assertNotNull(NodeActionGuard(previous).nativeTabReadinessSignature())
        assertEquals(NodeActionGuard(previous).nativeTabReadinessSignature(), NodeActionGuard(fresh).nativeTabReadinessSignature())
        expect("TARGET_CHANGED", "PAGE_CONTEXT_CHANGED") { NodeActionGuard(previous).rebind(NodeActionGuard(fresh), "ordinary", "tap_element") }
        assertEquals("native_tab_navigation", NodeActionGuard(previous).rebindEvidence(NodeActionGuard(fresh), "second", "tap_element").contextVerification)
    }

    @Test fun nativeMetadataComparesByValueAcrossRepeatedAndReorderedObjectReads() {
        val previous = nativeTabs(); val guard = NodeActionGuard(previous)
        // Identity must be reflexive even when native evidence contains objects.
        assertEquals(NodeActionGuard.RebindEvidence("second", "default_context"), guard.rebindEvidence(guard, "second", "tap_element"))
        val fresh = changed(previous)
        n(fresh, "tabs").put("nativeCollection", JSONObject().put("selectionMode", 1).put("hierarchical", false).put("columns", 2).put("rows", 1))
        n(fresh, "second").put("nativeCollectionItem", JSONObject().put("selected", false).put("heading", false).put("columnSpan", 1)
            .put("column", 1).put("rowSpan", 1).put("row", 0))
        assertEquals(NodeActionGuard.RebindEvidence("second", "default_context"), guard.rebindEvidence(NodeActionGuard(fresh), "second", "tap_element"))
        assertEquals(guard.nativeTabReadinessSignature(), NodeActionGuard(fresh).nativeTabReadinessSignature())
    }

}
