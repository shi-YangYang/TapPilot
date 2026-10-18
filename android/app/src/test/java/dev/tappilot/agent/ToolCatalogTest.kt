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

    @Test fun readinessAndPostActionSelectorContractsAreTypedAndOptional() {
        val wait = JSONObject().put("sinceRevision", 1).put("requireUsable", true)
            .put("selector", JSONObject().put("editable", true).put("enabled", true))
        ToolCatalog.validateRpc("wait_for_ui_change", wait)
        val action = JSONObject().put("action", "press_key").put("arguments", JSONObject().put("key", "back"))
            .put("waitFor", JSONObject().put("text", "合成目标")).put("waitMs", 1500)
        ToolCatalog.validateRpc("act_and_observe", action)
        for ((name, args) in listOf("wait_for_ui_change" to JSONObject(wait.toString()).put("requireUsable", "true"),
            "act_and_observe" to JSONObject(action.toString()).put("waitFor", JSONObject()))) {
            try { ToolCatalog.validateRpc(name, args); fail("Malformed readiness condition accepted") }
            catch (error: AgentError) { assertEquals("INVALID_ARGUMENT", error.code) }
        }
    }
}
