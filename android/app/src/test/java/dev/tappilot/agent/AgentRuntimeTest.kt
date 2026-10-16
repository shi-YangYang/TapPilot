package dev.tappilot.agent

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AgentRuntimeTest {
    private fun tree(id: String = "s1", text: String = "电池") = JSONObject().put("snapshotId", id).put("revision", 1).put("packageName", "fixture.settings")
        .put("nodes", JSONArray().put(JSONObject().put("nodeId", "n1").put("text", text).put("clickable", true).put("enabled", true).put("visible", true)))
    private fun call(action: String, args: JSONObject) = JSONObject().put("tool_calls", JSONArray().put(JSONObject().put("id", "c1").put("type", "function")
        .put("function", JSONObject().put("name", "act_and_observe").put("arguments", JSONObject().put("action", action).put("arguments", args).toString()))))
    private fun model(vararg replies: JSONObject) = object : ModelGateway {
        var index = 0
        override fun complete(messages: JSONArray, tools: JSONArray) = replies[index++]
        override fun cancel() {}
    }
    @Test fun initialObservationThenActionAndFinishUsesOneModelRoundPerAction() {
        val calls = mutableListOf<String>()
        val gateway = model(call("click_element", JSONObject().put("snapshotId", "s1").put("nodeId", "n1")), JSONObject().put("content", "已读取电池页面"))
        val result = AgentRuntime(gateway, PhoneExecutor { name, _, _ ->
            calls.add(name)
            if (name == "get_ui_tree") tree() else JSONObject().put("action", JSONObject().put("accepted", true)).put("observation", tree("s2", "电量 80%"))
        }).run("查看电池")
        assertEquals("已读取电池页面", result)
        assertEquals(listOf("get_ui_tree", "act_and_observe"), calls)
    }
    @Test fun nestedUnknownFieldsAreRejectedBeforeExecution() {
        try {
            ToolCatalog.validate("act_and_observe", JSONObject().put("action", "click_element").put("arguments", JSONObject().put("snapshotId", "s1").put("nodeId", "n1").put("approved", true)))
            fail("unknown field accepted")
        } catch (error: AgentError) { assertEquals("INVALID_ARGUMENT", error.code) }
    }
    @Test fun sensitiveSubmitStopsBeforeClick() {
        var mutations = 0
        val runtime = AgentRuntime(model(call("click_element", JSONObject().put("snapshotId", "s1").put("nodeId", "n1"))), PhoneExecutor { name, _, _ ->
            if (name != "get_ui_tree") mutations++
            tree(text = "确认付款")
        })
        try { runtime.run("查看订单"); fail("sensitive submit was accepted") }
        catch (error: AgentError) { assertEquals("CONFIRMATION_REQUIRED", error.code) }
        assertEquals(0, mutations)
    }
    @Test fun cancelAfterModelResponsePreventsAction() {
        var mutations = 0
        lateinit var runtime: AgentRuntime
        val gateway = object : ModelGateway {
            override fun complete(messages: JSONArray, tools: JSONArray): JSONObject {
                runtime.cancel()
                return call("open_settings", JSONObject())
            }
            override fun cancel() {}
        }
        runtime = AgentRuntime(gateway, PhoneExecutor { name, _, _ -> if (name != "get_ui_tree") mutations++; tree() })
        try { runtime.run("打开设置"); fail("cancelled task proceeded") } catch (error: AgentError) { assertEquals("CANCELLED", error.code) }
        assertEquals(0, mutations)
    }
    @Test fun oldUiTextIsRemovedFromNextRequest() {
        var requests = 0
        val gateway = object : ModelGateway {
            override fun complete(messages: JSONArray, tools: JSONArray): JSONObject {
                if (requests++ == 0) return call("open_settings", JSONObject())
                assertFalse(messages.toString().contains("old-fixture-text"))
                assertTrue(messages.toString().contains("new-fixture-text"))
                return JSONObject().put("content", "完成")
            }
            override fun cancel() {}
        }
        AgentRuntime(gateway, PhoneExecutor { name, _, _ -> if (name == "get_ui_tree") tree(text = "old-fixture-text") else JSONObject().put("action", JSONObject().put("accepted", true)).put("observation", tree("s2", "new-fixture-text")) }).run("打开设置")
    }
    @Test fun sensitiveDescendantOfClickedContainerStopsBeforeClick() {
        val screen = tree(text = "").apply {
            getJSONArray("nodes").put(JSONObject().put("nodeId", "label").put("parentId", "n1").put("text", "发送").put("visible", true))
        }
        var clicks = 0
        val runtime = AgentRuntime(model(call("click_element", JSONObject().put("snapshotId", "s1").put("nodeId", "n1"))), PhoneExecutor { name, _, _ ->
            if (name != "get_ui_tree") clicks++
            screen
        })
        try { runtime.run("查看会话"); fail("parent bypassed submit protection") } catch (error: AgentError) { assertEquals("CONFIRMATION_REQUIRED", error.code) }
        assertEquals(0, clicks)
    }
    @Test fun metadataReadRetainsLatestTreeInModelContext() {
        var requests = 0
        val gateway = object : ModelGateway {
            override fun complete(messages: JSONArray, tools: JSONArray): JSONObject {
                if (requests++ == 0) return JSONObject().put("tool_calls", JSONArray().put(JSONObject().put("id", "meta").put("type", "function")
                    .put("function", JSONObject().put("name", "get_current_app").put("arguments", "{}"))))
                assertTrue(messages.toString().contains("retain-this-ui-label"))
                return JSONObject().put("content", "完成")
            }
            override fun cancel() {}
        }
        AgentRuntime(gateway, PhoneExecutor { name, _, _ -> if (name == "get_ui_tree") tree(text = "retain-this-ui-label") else JSONObject().put("packageName", "fixture.settings") }).run("查看界面")
    }
    @Test fun wrongNestedParameterTypesRejected() {
        try {
            ToolCatalog.validate("act_and_observe", JSONObject().put("action", "input_text").put("arguments", JSONObject().put("snapshotId", "s1").put("nodeId", "n1").put("text", true)))
            fail("wrong type accepted")
        } catch (error: AgentError) { assertEquals("INVALID_ARGUMENT", error.code) }
    }
    @Test fun acceptedActionWithoutObservationCannotClaimCompletion() {
        val gateway = model(call("open_settings", JSONObject()), JSONObject().put("content", "已完成"))
        val runtime = AgentRuntime(gateway, PhoneExecutor { name, _, _ -> if (name == "get_ui_tree") tree() else
            JSONObject().put("action", JSONObject().put("accepted", true)).put("observation", JSONObject.NULL).put("observationError", JSONObject().put("code", "NO_ACTIVE_WINDOW")) })
        try { runtime.run("打开设置"); fail("unverified completion accepted") } catch (error: AgentError) { assertEquals("OBSERVATION_REQUIRED", error.code) }
    }
    @Test fun innocentChildCannotActivateSensitiveClickableAncestor() {
        val screen = tree(text = "确认付款").apply {
            getJSONArray("nodes").put(JSONObject().put("nodeId", "child").put("parentId", "n1").put("text", "继续").put("clickable", false).put("visible", true))
        }
        var clicks = 0
        val runtime = AgentRuntime(model(call("click_element", JSONObject().put("snapshotId", "s1").put("nodeId", "child"))), PhoneExecutor { name, _, _ ->
            if (name != "get_ui_tree") clicks++
            screen
        })
        try { runtime.run("查看订单"); fail("child bypassed submit protection") } catch (error: AgentError) { assertEquals("CONFIRMATION_REQUIRED", error.code) }
        assertEquals(0, clicks)
    }
    @Test fun partialFindRequiresFullReadBeforeClick() {
        var round = 0
        var clicks = 0
        val gateway = object : ModelGateway {
            override fun complete(messages: JSONArray, tools: JSONArray): JSONObject {
                return when (round++) {
                    0 -> JSONObject().put("tool_calls", JSONArray().put(JSONObject().put("id", "find").put("type", "function").put("function", JSONObject().put("name", "find_element").put("arguments", "{\"selector\":{\"text\":\"电池\"}}"))))
                    1 -> call("click_element", JSONObject().put("snapshotId", "partial").put("nodeId", "n1"))
                    else -> { assertTrue(messages.toString().contains("READ_REQUIRED")); JSONObject().put("content", "需要重新读取") }
                }
            }
            override fun cancel() {}
        }
        AgentRuntime(gateway, PhoneExecutor { name, _, _ -> when (name) {
            "get_ui_tree" -> tree()
            "find_element" -> JSONObject().put("snapshotId", "partial").put("elements", tree().getJSONArray("nodes"))
            else -> { clicks++; JSONObject() }
        } }).run("查看电池")
        assertEquals(0, clicks)
    }
    @Test fun plainHttpAndCredentialUrlsRejected() {
        for (url in listOf("http://127.0.0.1/v1", "https://secret@example.com/v1", "https://example.com/v1?key=secret")) {
            try { ModelSettings(url, "", "model").endpoint(); fail("unsafe endpoint accepted") } catch (error: AgentError) { assertEquals("INVALID_CONFIG", error.code) }
        }
    }
}
