package dev.tappilot.agent

import org.json.JSONArray
import org.json.JSONObject

/** Validate the computer's RPC arguments before native actions are dispatched. */
internal object ToolCatalog {
    private fun text(max: Int = 1000, min: Int = 1) = JSONObject().put("type", "string").put("maxLength", max).put("minLength", min)
    private fun number(min: Int, max: Int) = JSONObject().put("type", "integer").put("minimum", min).put("maximum", max)
    private fun enum(vararg values: String) = text().put("enum", JSONArray(values.toList()))
    private fun obj(fields: Map<String, JSONObject>, required: List<String> = emptyList()) = JSONObject().put("type", "object")
        .put("properties", JSONObject(fields)).put("required", JSONArray(required)).put("additionalProperties", false)
    private val node = mapOf("snapshotId" to text(128), "nodeId" to text(64))
    private val declaredLabels = node + ("allowedLabelChanges" to JSONObject().put("type", "array")
        .put("items", text(64)).put("minItems", 1).put("maxItems", 8).put("uniqueItems", true))
    private val selector = obj(mapOf("text" to text(), "textContains" to text(), "resourceId" to text(),
        "contentDescription" to text(), "className" to text(), "clickable" to JSONObject().put("type", "boolean"),
        "scrollable" to JSONObject().put("type", "boolean"), "editable" to JSONObject().put("type", "boolean"), "enabled" to JSONObject().put("type", "boolean"))).put("minProperties", 1)
    val actions = linkedMapOf(
        "tap_visual" to obj(mapOf("captureId" to text(128), "x" to number(0, 16384), "y" to number(0, 16384), "targetDescription" to text(256)), listOf("captureId", "x", "y", "targetDescription")),
        "swipe_visual" to obj(mapOf("captureId" to text(128), "startX" to number(0, 16384), "startY" to number(0, 16384), "endX" to number(0, 16384), "endY" to number(0, 16384), "durationMs" to number(200, 1000), "targetDescription" to text(256)), listOf("captureId", "startX", "startY", "endX", "endY", "targetDescription")),
        "tap_element" to obj(declaredLabels, node.keys.toList()),
        "click_element" to obj(declaredLabels, node.keys.toList()),
        "input_text" to obj(declaredLabels + ("text" to text(4096, 0)), listOf("snapshotId", "nodeId", "text")),
        "scroll" to obj(node + ("direction" to enum("forward", "backward", "up", "down", "left", "right")), listOf("snapshotId", "nodeId", "direction")),
        "swipe" to obj(mapOf("snapshotId" to text(128), "startX" to number(0, 16384), "startY" to number(0, 16384), "endX" to number(0, 16384), "endY" to number(0, 16384), "durationMs" to number(50, 2000)), listOf("snapshotId", "startX", "startY", "endX", "endY")),
        "press_key" to obj(mapOf("key" to enum("back", "home", "recents")), listOf("key")),
        "open_settings" to obj(emptyMap())
    )
    private val anyArgs = obj(emptyMap()).put("additionalProperties", true)
    private val schemas = linkedMapOf(
        "get_ui_tree" to obj(mapOf("maxNodes" to number(1, 500), "maxDepth" to number(1, 40))),
        "get_current_app" to obj(emptyMap()),
        "take_screenshot" to obj(emptyMap()),
        "find_element" to obj(mapOf("selector" to selector, "maxResults" to number(1, 100)), listOf("selector")),
        "wait_for_ui_change" to obj(mapOf("sinceRevision" to number(0, Int.MAX_VALUE), "snapshotId" to text(128), "timeoutMs" to number(1, 5000), "selector" to selector, "requireUsable" to JSONObject().put("type", "boolean")), listOf("sinceRevision")),
        "act_and_observe" to obj(mapOf("action" to enum(*actions.keys.toTypedArray()), "arguments" to anyArgs, "waitMs" to number(0, 1500), "waitFor" to selector), listOf("action", "arguments"))
    )
    fun validate(name: String, args: JSONObject) {
        val schema = schemas[name] ?: throw AgentError("UNKNOWN_TOOL", "请求了未开放的工具")
        validateValue(args, schema, "arguments")
        if (name == "act_and_observe") validateAction(args.getString("action"), args.getJSONObject("arguments"))
    }
    fun validateRpc(name: String, args: JSONObject) {
        when {
            name in actions -> validateAction(name, args)
            name == "get_device_info" || name == "emergency_stop" -> validateValue(args, obj(emptyMap()), "arguments")
            name == "wait_for_ui_change" -> validateValue(args, obj(mapOf("sinceRevision" to number(0, Int.MAX_VALUE), "snapshotId" to text(128), "timeoutMs" to number(1, 25000), "selector" to selector, "requireUsable" to JSONObject().put("type", "boolean")), listOf("sinceRevision")), "arguments")
            else -> validate(name, args)
        }
    }
    fun validateAction(action: String, args: JSONObject) = validateValue(args, actions[action] ?: throw AgentError("UNKNOWN_TOOL", "不支持此动作"), "arguments")
    private fun validateValue(value: Any?, schema: JSONObject, path: String) {
        fun invalid(): Nothing = throw AgentError("INVALID_ARGUMENT", "$path 不符合工具参数格式")
        when (schema.getString("type")) {
            "object" -> {
                if (value !is JSONObject || value.length() < schema.optInt("minProperties", 0)) invalid()
                val properties = schema.getJSONObject("properties")
                val required = schema.getJSONArray("required")
                for (i in 0 until required.length()) if (!value.has(required.getString(i))) invalid()
                value.keys().forEach { key ->
                    if (!properties.has(key)) { if (!schema.optBoolean("additionalProperties")) invalid() }
                    else validateValue(value.opt(key), properties.getJSONObject(key), "$path.$key")
                }
            }
            "string" -> {
                if (value !is String || value.length !in schema.optInt("minLength", 0)..schema.optInt("maxLength", Int.MAX_VALUE)) invalid()
                schema.optJSONArray("enum")?.let { options -> if ((0 until options.length()).none { options.getString(it) == value }) invalid() }
            }
            "integer" -> if (value !is Number || !value.toDouble().isFinite() || value.toDouble() % 1.0 != 0.0 || value.toDouble() < schema.getDouble("minimum") || value.toDouble() > schema.getDouble("maximum")) invalid()
            "array" -> {
                if (value !is JSONArray || value.length() !in schema.optInt("minItems", 0)..schema.optInt("maxItems", Int.MAX_VALUE)) invalid()
                val items = (0 until value.length()).map(value::get)
                if (schema.optBoolean("uniqueItems") && items.toSet().size != items.size) invalid()
                items.forEach { validateValue(it, schema.getJSONObject("items"), "$path[]") }
            }
            "boolean" -> if (value !is Boolean) invalid()
            else -> invalid()
        }
    }
}
