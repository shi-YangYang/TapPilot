package dev.tappilot.agent

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class ToolCatalogTest {
    private fun arguments(action: String) = JSONObject().put("snapshotId", "fixture:1").put("nodeId", "field").also {
        if (action == "input_text") it.put("text", "合成输入")
        if (action == "scroll") it.put("direction", "forward")
    }
    private fun rejected(action: String, value: Any) {
        try {
            ToolCatalog.validateAction(action, arguments(action).put("allowedLabelChanges", value))
            fail("Invalid explicit contract was accepted")
        } catch (error: AgentError) { assertEquals("INVALID_ARGUMENT", error.code) }
    }
    @Test fun explicitLabelChangesAreBoundedOptionalAndOnlyOnSupportedActions() {
        for (action in listOf("tap_element", "click_element", "input_text")) {
            ToolCatalog.validateAction(action, arguments(action))
            val args = arguments(action).put("allowedLabelChanges", JSONArray(listOf("status")))
            ToolCatalog.validateRpc(action, args)
            ToolCatalog.validateRpc("act_and_observe", JSONObject().put("action", action).put("arguments", args))
            for (bad in listOf(JSONArray(), JSONArray(listOf("status", "status")), JSONArray((1..9).map { "n$it" }),
                JSONArray(listOf("")), JSONArray(listOf("x".repeat(65))), JSONArray(listOf(1)), "status", JSONObject.NULL)) rejected(action, bad)
        }
        rejected("scroll", JSONArray(listOf("status")))
    }
}
