package dev.tappilot.agent

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ObservationContractTest {
    private fun node(id: String, parent: String? = null, text: String = "", clickable: Boolean = false): JSONObject = JSONObject()
        .put("nodeId", id).put("parentId", parent ?: JSONObject.NULL).put("text", text).put("contentDescription", "")
        .put("resourceId", "").put("className", "android.view.View").put("bounds", JSONArray(listOf(0, 0, 400, 100)))
        .put("visible", true).put("enabled", true).put("clickable", clickable).put("scrollable", false).put("editable", false)
        .put("password", false).put("checkable", false).put("checked", false).put("selected", false).put("focused", false).put("showingHintText", false)

    private fun tree(vararg nodes: JSONObject): JSONObject = JSONObject().put("snapshotId", "fixture:1").put("revision", 1)
        .put("packageName", "fixture.app").put("windowId", 1).put("truncated", false).put("nodes", JSONArray(nodes.toList()))
    private fun copy(value: JSONObject): JSONObject = JSONObject(value.toString())
    private fun field(tree: JSONObject, index: Int): JSONObject = tree.getJSONArray("nodes").getJSONObject(index)
    private fun accepted(textVerified: Boolean? = null): JSONObject = JSONObject().put("accepted", true).also {
        if (textVerified != null) it.put("textVerified", textVerified)
    }

    @Test fun nativeVisibilityDuringOffscreenWindowEntryDoesNotMakeObservationReady() {
        // Real native transition: the entire incoming 1080px-wide window was
        // translated by 1080px, while Android still advertised visible=true.
        val observation = tree(node("root"), node("target", "root", "合成入口", true))
        field(observation, 0).put("bounds", JSONArray(listOf(1080, 0, 2160, 2400)))
        field(observation, 1).put("bounds", JSONArray(listOf(2023, 102, 2123, 173)))
        for (index in 0..1) {
            val value = field(observation, index)
            val bounds = value.getJSONArray("bounds").let { (0 until it.length()).map(it::getInt) }
            value.put("visible", ObservationContract.visibleOnScreen(true, bounds, 1080, 2400))
        }
        assertEquals("unavailable", ObservationContract.quality(observation).getString("status"))
        assertFalse(ObservationContract.ready(observation, JSONObject().put("text", "合成入口")))
        val settled = copy(observation)
        field(settled, 0).put("bounds", JSONArray(listOf(0, 0, 1080, 2400))).put("visible", true)
        field(settled, 1).put("bounds", JSONArray(listOf(943, 102, 1043, 173))).put("visible", true)
        assertTrue(ObservationContract.ready(settled, JSONObject().put("text", "合成入口")))
        assertNotEquals(ObservationContract.signature(observation), ObservationContract.signature(settled))
    }

    @Test fun viewportVisibilityRequiresAreaButKeepsPartiallyVisibleTargets() {
        for (bounds in listOf(listOf(1080, 0, 2160, 2400), listOf(-1080, 0, 0, 2400),
            listOf(0, 2400, 1080, 2500), listOf(0, -100, 1080, 0), listOf(50, 50, 50, 100))) {
            assertFalse(ObservationContract.visibleOnScreen(true, bounds, 1080, 2400))
        }
        for (bounds in listOf(listOf(-10, 0, 20, 40), listOf(1070, 2300, 1200, 2500))) {
            assertTrue(ObservationContract.visibleOnScreen(true, bounds, 1080, 2400))
        }
        assertFalse(ObservationContract.visibleOnScreen(false, listOf(0, 0, 100, 100), 1080, 2400))
        assertFalse(ObservationContract.visibleOnScreen(true, listOf(0, 0, 100, 100), 0, 2400))
    }

    @Test fun textOnlyPageIsUsableWithoutActionableControls() {
        val quality = ObservationContract.quality(tree(node("root"), node("text", "root", "合成只读内容")))
        assertEquals("usable", quality.getString("status"))
        assertEquals("accessible_content", quality.getString("reason"))
        assertEquals(0, quality.getInt("actionableCount"))
        assertEquals(1, quality.getInt("readableCount"))
    }

    @Test fun emptyOrLayoutOnlyTreeHasNoAccessibleContentRegardlessOfNodeCount() {
        for (observation in listOf(tree(), tree(node("root")), tree(node("root"), node("wrapper", "root")))) {
            val quality = ObservationContract.quality(observation)
            assertEquals("unavailable", quality.getString("status"))
            assertEquals("no_accessible_content", quality.getString("reason"))
        }
        assertEquals("unavailable", ObservationContract.quality(tree(node("root")).put("truncated", true)).getString("status"))
    }

    @Test fun visibleEnabledControlsCountWithoutTextAndTruncationRemainsExplicit() {
        val observation = tree(node("root"), node("button", "root", clickable = true),
            node("scroll", "root").put("scrollable", true), node("input", "root").put("editable", true))
        assertEquals(3, ObservationContract.quality(observation).getInt("actionableCount"))
        assertEquals("usable", ObservationContract.quality(observation).getString("status"))
        observation.put("truncated", true)
        assertEquals("limited", ObservationContract.quality(observation).getString("status"))
        assertEquals("incomplete_tree", ObservationContract.quality(observation).getString("reason"))
        observation.remove("truncated")
        assertEquals("limited", ObservationContract.quality(observation).getString("status"))
    }

    @Test fun hiddenPasswordAndRedactedNodesDoNotFabricateAccessibleContent() {
        val observation = tree(node("hidden", text = "隐藏内容", clickable = true).put("visible", false),
            node("password", text = "[REDACTED]", clickable = true).put("password", true),
            node("redacted", text = "[REDACTED]"), node("disabled", clickable = true).put("enabled", false))
        assertEquals("unavailable", ObservationContract.quality(observation).getString("status"))
        assertEquals(0, ObservationContract.quality(observation).getInt("actionableCount"))
        // A disabled read-only label still contains useful visible information.
        field(observation, 3).put("contentDescription", "合成不可用状态")
        assertEquals("usable", ObservationContract.quality(observation).getString("status"))
    }

    @Test fun changingHandlesRevisionAndDerivedMetadataDoesNotChangeSemanticSignature() {
        val original = tree(node("root"), node("label", "root", "合成内容"))
        val fresh = copy(original).put("snapshotId", "fixture:2").put("revision", 999)
            .put("executor", "node-v1").put("quality", JSONObject().put("status", "usable"))
        field(fresh, 0).put("nodeId", "newRoot").put("contextSignature", "private-native-hash")
        field(fresh, 1).put("nodeId", "newLabel").put("parentId", "newRoot")
        assertEquals(ObservationContract.signature(original), ObservationContract.signature(fresh))
    }

    @Test fun textStateGeometryHierarchyWindowAndCompletenessAreSignificant() {
        val original = tree(node("root"), node("label", "root", "合成内容"), node("button", "root", clickable = true))
        val changes: List<(JSONObject) -> Unit> = listOf(
            { field(it, 1).put("text", "新的合成内容") },
            { field(it, 1).put("contentDescription", "状态更新") },
            { field(it, 2).put("enabled", false) },
            { field(it, 2).put("bounds", JSONArray(listOf(0, 20, 400, 120))) },
            { field(it, 2).put("parentId", "label") },
            { it.put("windowId", 2) },
            { it.put("packageName", "another.fixture") },
            { it.put("truncated", true) },
        )
        for (change in changes) {
            val next = copy(original).also(change)
            assertNotEquals(ObservationContract.signature(original), ObservationContract.signature(next))
        }
    }

    @Test fun acceptedNoOpAndChangingUiAreBothUnverified() {
        val before = tree(node("text", text = "合成页面"))
        val noop = ObservationContract.execution(accepted(), before, copy(before).put("revision", 2))
        assertEquals("sent", noop.getString("dispatch"))
        assertEquals("accepted", noop.getString("acceptance"))
        assertEquals("unchanged", noop.getString("effect"))
        assertEquals("unverified", noop.getString("verification"))
        assertFalse(noop.has("verificationScope"))
        val after = copy(before).also { field(it, 0).put("text", "其他内容变化") }
        val changed = ObservationContract.execution(accepted(), before, after)
        assertEquals("changed", changed.getString("effect"))
        assertEquals("unverified", changed.getString("verification"))
    }

    @Test fun missingLimitedUnavailableAndErroredObservationsKeepEffectUnknown() {
        val before = tree(node("text", text = "合成页面"))
        for (after in listOf(null, tree(node("root")), copy(before).put("truncated", true))) {
            val result = ObservationContract.execution(accepted(), before, after)
            assertEquals("unknown", result.getString("effect"))
            assertEquals("unverified", result.getString("verification"))
        }
        assertEquals("unknown", ObservationContract.execution(accepted(), null, before).getString("effect"))
        val errored = ObservationContract.execution(accepted(true), before, before, observationError = true)
        assertEquals("unknown", errored.getString("effect"))
        assertEquals("unverified", errored.getString("verification"))
        assertFalse(errored.has("verificationScope"))
    }

    @Test fun NativeInputVerificationHasOnlyInputValueScope() {
        val before = tree(node("input", text = "原始合成值").put("editable", true).put("resourceId", "fixture:id/input"))
        val after = copy(before).also { field(it, 0).put("text", "新的合成值") }
        val action = accepted(false).put("action", "set_text").put("targetNodeId", "input")
        val verified = ObservationContract.execution(action, before, after, expectedInput = "新的合成值")
        assertEquals("changed", verified.getString("effect"))
        assertEquals("verified", verified.getString("verification"))
        assertEquals("input_value", verified.getString("verificationScope"))
        assertEquals("unverified", ObservationContract.execution(action, before, after, expectedInput = "其他合成值").getString("verification"))
        assertEquals("unverified", ObservationContract.execution(action, before, tree(), expectedInput = "新的合成值").getString("verification"))
        assertEquals("unverified", ObservationContract.execution(action, before, after).getString("verification"))
    }

    @Test fun typedSingleActionEvidenceAllowsSettlingBeforeButNeverSettlingAfter() {
        val before = tree(node("input", text = "原值").put("editable", true).put("resourceId", "fixture:id/input"))
            .put("observationCapabilities", JSONObject().put("windowReadiness", true))
            .put("readiness", WindowReadiness.captured(false).json())
        val after = copy(before).put("snapshotId", "fixture:2").put("readiness", WindowReadiness("ready", "interaction_stable", 3, 240).json())
            .also { field(it, 0).put("text", "请求值") }
        val action = accepted().put("action", "set_text").put("targetNodeId", "input")
            .put("readinessEvidence", "declared_label_changes").put("contextVerification", "explicit_label_changes")
        val evidence = ActionReadinessEvidence("fixture:1", "input", "input_text")
        assertNull("A JSON flag is not authorization", ObservationContract.verificationScope(action, before, after, "请求值"))
        assertEquals("input_value", ObservationContract.verificationScope(action, before, after, "请求值", evidence))
        assertFalse(ObservationContract.ready(before))
        for (wrong in listOf(ActionReadinessEvidence("fixture:other", "input", "input_text"),
            ActionReadinessEvidence("fixture:1", "other-input", "input_text"), ActionReadinessEvidence("fixture:1", "input", "tap_element"))) {
            assertNull(ObservationContract.verificationScope(action, before, after, "请求值", wrong))
        }
        val incompleteBefore = copy(before).put("truncated", true)
        assertNull(ObservationContract.verificationScope(action, incompleteBefore, after, "请求值", evidence))
        val settlingAfter = copy(after).put("readiness", WindowReadiness.captured(false).json())
        assertEquals("unverified", ObservationContract.execution(action, before, settlingAfter,
            expectedInput = "请求值", beforeEvidence = evidence).getString("verification"))
        field(after, 0).put("text", "其他值")
        assertNull(ObservationContract.verificationScope(action, before, after, "请求值", evidence))
    }

    @Test fun typedToggleEvidenceStillRequiresTheObservedCheckedStateChange() {
        val before = tree(node("toggle", text = "合成选项", clickable = true).put("checkable", true).put("resourceId", "fixture:id/toggle"))
            .put("observationCapabilities", JSONObject().put("windowReadiness", true))
            .put("readiness", WindowReadiness.captured(false).json())
        val action = accepted().put("action", "tap").put("targetNodeId", "toggle").put("actedNodeId", "toggle")
        val after = copy(before).put("snapshotId", "fixture:2").put("readiness", WindowReadiness("ready", "interaction_stable", 3, 240).json())
        val evidence = ActionReadinessEvidence("fixture:1", "toggle", "tap_element")
        assertNull(ObservationContract.verificationScope(action, before, after, beforeEvidence = evidence))
        field(after, 0).put("checked", true)
        assertEquals("checked_state", ObservationContract.verificationScope(action, before, after, beforeEvidence = evidence))
        after.put("readiness", WindowReadiness.captured(false).json())
        assertNull(ObservationContract.verificationScope(action, before, after, beforeEvidence = evidence))
    }

    @Test fun matchingPlaceholderOrMissingHintEvidenceNeverVerifiesInputValue() {
        val before = tree(node("input", text = "合成查询").put("editable", true).put("resourceId", "fixture:id/input").put("showingHintText", true))
        val action = accepted(true).put("action", "set_text").put("targetNodeId", "input")
        val hint = copy(before)
        assertNull(ObservationContract.verificationScope(action, before, hint, "合成查询"))
        assertEquals("unverified", ObservationContract.execution(action, before, hint, expectedInput = "合成查询").getString("verification"))
        field(hint, 0).remove("showingHintText")
        assertNull(ObservationContract.verificationScope(action, before, hint, "合成查询"))
        val actual = copy(before).also { field(it, 0).put("showingHintText", false) }
        assertEquals("input_value", ObservationContract.verificationScope(action, before, actual, "合成查询"))
        assertEquals("changed", ObservationContract.execution(action, before, actual, expectedInput = "合成查询").getString("effect"))
    }

    @Test fun immediateAcknowledgementCannotVerifyFormattedRevertedMissingOrOtherWindowInput() {
        val before = tree(node("root"), node("input", "root", "原始值").put("editable", true).put("resourceId", "fixture:id/input"))
        val action = accepted(true).put("action", "set_text").put("targetNodeId", "input")
        for (after in listOf(copy(before), tree(node("root")),
            copy(before).also { field(it, 1).put("text", "格式化后的值") },
            copy(before).put("windowId", 2).also { field(it, 1).put("text", "请求值") },
            copy(before).put("snapshotId", "other-session:1").also { field(it, 1).put("text", "请求值") })) {
            assertEquals("unverified", ObservationContract.execution(action, before, after, expectedInput = "请求值").getString("verification"))
        }
    }

    @Test fun finalValueRequiresUniqueTargetAndStableMeaningfulAncestors() {
        val before = tree(node("root", text = "收件人甲"),
            node("input", "root", "旧值").put("editable", true).put("resourceId", "fixture:id/input"))
        val action = accepted().put("action", "set_text").put("targetNodeId", "input")
        val after = copy(before).put("snapshotId", "fixture:2").also { field(it, 1).put("nodeId", "new-input").put("text", "请求值") }
        assertEquals("input_value", ObservationContract.verificationScope(action, before, after, "请求值"))
        val ambiguous = copy(after).also { it.getJSONArray("nodes").put(copy(field(it, 1)).put("nodeId", "duplicate")) }
        assertNull(ObservationContract.verificationScope(action, before, ambiguous, "请求值"))
        val changedParent = copy(after).also { field(it, 0).put("text", "收件人乙") }
        assertNull(ObservationContract.verificationScope(action, before, changedParent, "请求值"))
    }

    @Test fun checkedStateReadbackIsSpecificAndUnrelatedRefreshIsNotAToggle() {
        val before = tree(node("root"), node("toggle", "root", "合成选项", true).put("checkable", true).put("resourceId", "fixture:id/toggle"),
            node("ticker", "root", "计时 1"))
        val action = accepted().put("action", "tap").put("actedNodeId", "toggle")
        val after = copy(before).also { field(it, 1).put("checked", true); field(it, 2).put("text", "计时 2") }
        assertEquals("checked_state", ObservationContract.verificationScope(action, before, after))
        val execution = ObservationContract.execution(action, before, after)
        assertEquals("verified", execution.getString("verification"))
        assertEquals("checked_state", execution.getString("verificationScope"))
        field(after, 1).put("checked", false)
        assertEquals("changed", ObservationContract.execution(action, before, after).getString("effect"))
        assertNull(ObservationContract.verificationScope(action, before, after))
        field(after, 1).put("checked", true).put("text", "另一个选项")
        assertNull(ObservationContract.verificationScope(action, before, after))
    }

    @Test fun geometryCannotDisambiguateEqualInputsThatSwapPositions() {
        val before = tree(node("root"),
            node("target", "root", "旧值").put("editable", true).put("resourceId", "fixture:id/reused"),
            node("other", "root", "请求值").put("editable", true).put("resourceId", "fixture:id/reused")
                .put("bounds", JSONArray(listOf(0, 200, 400, 300))))
        val after = copy(before).also {
            field(it, 1).put("bounds", JSONArray(listOf(0, 200, 400, 300)))
            field(it, 2).put("bounds", JSONArray(listOf(0, 0, 400, 100)))
        }
        val action = accepted(true).put("action", "set_text").put("targetNodeId", "target")
        assertNull(ObservationContract.verificationScope(action, before, after, "请求值"))
        assertEquals("unverified", ObservationContract.execution(action, before, after, expectedInput = "请求值").getString("verification"))
    }

    @Test fun geometryCannotDisambiguateEqualCheckboxesThatSwapPositions() {
        val before = tree(node("root"),
            node("target", "root", "重复选项", true).put("checkable", true).put("resourceId", "fixture:id/reused"),
            node("other", "root", "重复选项", true).put("checkable", true).put("checked", true).put("resourceId", "fixture:id/reused")
                .put("bounds", JSONArray(listOf(0, 200, 400, 300))))
        val after = copy(before).also {
            field(it, 1).put("bounds", JSONArray(listOf(0, 200, 400, 300)))
            field(it, 2).put("bounds", JSONArray(listOf(0, 0, 400, 100)))
        }
        val action = accepted().put("action", "tap").put("actedNodeId", "target")
        assertNull(ObservationContract.verificationScope(action, before, after))
        assertEquals("unverified", ObservationContract.execution(action, before, after).getString("verification"))
    }

    @Test fun readinessRequiresCompleteTreeAndAllRequestedTargetConditions() {
        val observation = tree(node("loading", text = "加载中"), node("input").put("editable", true).put("enabled", false))
        val selector = JSONObject().put("editable", true).put("enabled", true)
        assertTrue(ObservationContract.ready(observation)) // Content availability is not a business task readiness claim.
        assertFalse(ObservationContract.ready(observation, selector))
        field(observation, 1).put("enabled", true)
        assertTrue(ObservationContract.ready(observation, selector))
        observation.put("truncated", true)
        assertFalse(ObservationContract.ready(observation, selector))
        observation.put("truncated", false); field(observation, 1).put("visible", false)
        assertFalse(ObservationContract.ready(observation, selector))
    }

    @Test fun UnacceptedResultCannotInventSuccessfulDispatchOrVerification() {
        val observation = tree(node("label", text = "合成内容"))
        for (action in listOf(JSONObject(), JSONObject().put("accepted", false).put("textVerified", true))) {
            val result = ObservationContract.execution(action, observation, observation)
            assertEquals("unknown", result.getString("dispatch"))
            assertEquals("unknown", result.getString("effect"))
            assertEquals("unverified", result.getString("verification"))
        }
        val rejected = ObservationContract.execution(JSONObject().put("accepted", false).put("dispatchState", "sent"), observation, observation)
        assertEquals("sent", rejected.getString("dispatch"))
        assertEquals("rejected", rejected.getString("acceptance"))
    }
}
