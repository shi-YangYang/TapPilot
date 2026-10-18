package dev.tappilot.agent

import org.json.JSONArray
import org.json.JSONObject

/** Service-created, per-command evidence. No transport argument or action JSON
 * flag can create it, and it never changes an observation's global readiness.
 */
internal class ActionReadinessEvidence(private val snapshotId: String, private val targetNodeId: String, private val action: String) {
    fun matches(result: JSONObject, before: JSONObject): Boolean {
        val resultAction = when (action) {
            "input_text" -> "set_text"
            "tap_element" -> "tap"
            "click_element" -> "click"
            else -> return false
        }
        return before.optString("snapshotId") == snapshotId && result.optString("targetNodeId") == targetNodeId &&
            result.optString("action") == resultAction
    }
}

/** Facts about native observations, not a claim that an application's task succeeded. */
internal object ObservationContract {
    private val contentFields = listOf("text", "contentDescription", "resourceId", "className")
    private val stateFields = listOf("clickable", "scrollable", "editable", "enabled", "password", "visible",
        "checkable", "checked", "selected", "focused", "focusable")

    /** Android can report visible=true while an entering window is still wholly
     * beyond the display edge. Such nodes are not ready for observation/action.
     * Partial intersections remain visible; target hit testing still clips them.
     */
    fun visibleOnScreen(nativeVisible: Boolean, bounds: List<Int>, width: Int, height: Int): Boolean =
        nativeVisible && bounds.size == 4 && width > 0 && height > 0 &&
            maxOf(0, bounds[0]) < minOf(width, bounds[2]) && maxOf(0, bounds[1]) < minOf(height, bounds[3])

    fun usable(observation: JSONObject): Boolean = quality(observation).getString("status") == "usable"

    /** A target selector is an observation condition, never a business-success claim. */
    fun windowReady(observation: JSONObject): Boolean =
        observation.optJSONObject("observationCapabilities")?.opt("windowReadiness") != true ||
            observation.optJSONObject("readiness")?.optString("status") == "ready"

    fun ready(observation: JSONObject, selector: JSONObject? = null): Boolean = usable(observation) && windowReady(observation) &&
        (selector == null || nodes(observation).any { node ->
            node.opt("visible") == true && node.opt("password") != true && selector.keys().asSequence().all { key ->
                if (key == "textContains") node.optString("text").contains(selector.getString(key))
                else node.opt(key) == selector.opt(key)
            }
        })

    fun quality(observation: JSONObject): JSONObject {
        val nodes = observation.optJSONArray("nodes")
        var readable = 0
        var actionable = 0
        if (nodes != null) for (index in 0 until nodes.length()) {
            val node = nodes.optJSONObject(index) ?: continue
            if (node.opt("visible") != true || node.opt("password") == true) continue
            if (listOf("text", "contentDescription").any { key ->
                val value = node.opt(key) as? String
                value != null && value.isNotBlank() && value.trim() != "[REDACTED]"
            }) readable++
            if (node.opt("enabled") == true && listOf("clickable", "editable", "scrollable").any { node.opt(it) == true }) actionable++
        }
        val status: String
        val reason: String
        when {
            readable == 0 && actionable == 0 -> { status = "unavailable"; reason = "no_accessible_content" }
            observation.opt("truncated") != false -> { status = "limited"; reason = "incomplete_tree" }
            else -> { status = "usable"; reason = "accessible_content" }
        }
        return JSONObject().put("status", status).put("reason", reason)
            .put("actionableCount", actionable).put("readableCount", readable)
    }

    /** Snapshot handles and event counts are deliberately excluded. Parent indexes
     * retain hierarchy while allowing an otherwise identical tree to get new IDs.
     * All exposed text remains significant: change frequency is not proof of irrelevance.
     */
    fun signature(observation: JSONObject): String {
        val nodes = observation.optJSONArray("nodes") ?: JSONArray()
        val ids = (0 until nodes.length()).map { nodes.optJSONObject(it)?.opt("nodeId") as? String }
        val positions = ids.withIndex().filter { it.value != null }.groupBy({ it.value!! }, { it.index })
        val semanticNodes = JSONArray()
        for (index in 0 until nodes.length()) {
            val node = nodes.optJSONObject(index)
            if (node == null) { semanticNodes.put(JSONObject.NULL); continue }
            val parent = node.opt("parentId") as? String
            val parentIndex = if (parent == null) -1 else positions[parent]?.singleOrNull() ?: -2
            val values = JSONArray().put(parentIndex)
            for (key in contentFields) values.put(node.opt(key) ?: JSONObject.NULL)
            values.put(node.optJSONArray("bounds") ?: JSONObject.NULL)
            for (key in stateFields) values.put(node.opt(key) ?: JSONObject.NULL)
            // Hint/value state affects observation meaning but must not become
            // target identity: successful input legitimately changes true→false.
            values.put(node.opt("showingHintText") ?: JSONObject.NULL)
            semanticNodes.put(values)
        }
        val semantic = JSONArray().put(observation.opt("packageName") ?: JSONObject.NULL)
            .put(observation.opt("windowId") ?: JSONObject.NULL)
            .put(observation.opt("truncated") ?: JSONObject.NULL).put(semanticNodes)
        // Only an in-memory digest is returned; no raw UI or digest needs persistence.
        return snapshotFingerprintDigest(listOf(semantic.toString()))
    }

    /** Postcondition evidence is read back from the final native observation.
     * IDs are scoped to one snapshot, so a unique target and its meaningful ancestor
     * chain must correspond. An immediate performAction acknowledgement cannot verify it.
     */
    fun verificationScope(action: JSONObject, before: JSONObject?, after: JSONObject?, expectedInput: String? = null,
                          beforeEvidence: ActionReadinessEvidence? = null): String? {
        if (action.opt("accepted") != true || before == null || after == null || !ready(after)) return null
        if (!ready(before) && !(usable(before) && beforeEvidence?.matches(action, before) == true)) return null
        if (before.opt("packageName") != after.opt("packageName") || before.opt("windowId") != after.opt("windowId") ||
            before.optString("snapshotId").substringBeforeLast(':') != after.optString("snapshotId").substringBeforeLast(':')) return null
        val input = action.optString("action") == "set_text" && expectedInput != null
        val toggle = action.optString("action") in setOf("tap", "click")
        if (!input && !toggle) return null
        val oldNodes = nodes(before); val newNodes = nodes(after)
        val targetId = action.optString(if (input) "targetNodeId" else "actedNodeId")
        val old = oldNodes.singleOrNull { it.optString("nodeId") == targetId } ?: return null
        if (input && old.opt("editable") != true || toggle && old.opt("checkable") != true) return null
        // Empty structural wrappers are not an identity. A resource id, accessible
        // label or description anchors the target before geometry is considered.
        if (listOf("resourceId", "contentDescription").all { old.optString(it).isBlank() } &&
            (input || old.optString("text").isBlank())) return null
        val expectedIdentity = evidenceIdentity(old, oldNodes, input, toggle) ?: return null
        if (oldNodes.count { evidenceIdentity(it, oldNodes, input, toggle) == expectedIdentity } != 1) return null
        val current = newNodes.singleOrNull { evidenceIdentity(it, newNodes, input, toggle) == expectedIdentity } ?: return null
        // Geometry may reject a moved unique target, but must never disambiguate
        // equal semantic controls. Otherwise a reordered sibling could verify an
        // input/toggle that was never changed by this action.
        val oldBounds = old.optJSONArray("bounds") ?: return null
        val newBounds = current.optJSONArray("bounds") ?: return null
        if (oldBounds.length() != 4 || oldBounds.toString() != newBounds.toString()) return null
        return when {
            input && current.opt("showingHintText") == false && current.opt("text") == expectedInput -> "input_value"
            toggle && old.opt("checked") is Boolean && current.opt("checked") is Boolean && old.opt("checked") != current.opt("checked") -> "checked_state"
            else -> null
        }
    }

    private fun nodes(observation: JSONObject): List<JSONObject> = observation.optJSONArray("nodes")?.let { array ->
        (0 until array.length()).mapNotNull(array::optJSONObject)
    } ?: emptyList()

    private fun evidenceIdentity(node: JSONObject, all: List<JSONObject>, input: Boolean, toggle: Boolean): List<Any?>? {
        if (node.opt("visible") != true || node.opt("enabled") != true || node.opt("password") != false) return null
        if (input && node.opt("editable") != true || toggle && node.opt("checkable") != true) return null
        val byId = all.groupBy { it.optString("nodeId") }
        if (byId.any { it.key.isEmpty() || it.value.size != 1 }) return null
        fun identity(value: JSONObject, target: Boolean): List<Any?> {
            val strings = contentFields.filterNot { target && input && it == "text" }.map { value.opt(it) }
            val states = stateFields.filterNot { it == "focused" || target && toggle && it == "checked" }.map { value.opt(it) }
            return strings + states
        }
        val chain = mutableListOf<List<Any?>>()
        val seen = mutableSetOf<String>()
        var parent = node
        while (true) {
            if (!seen.add(parent.optString("nodeId")) || parent.opt("password") != false || parent.opt("visible") != true) return null
            chain.add(identity(parent, parent === node))
            val parentId = parent.opt("parentId") as? String ?: break
            parent = byId[parentId]?.singleOrNull() ?: return null
        }
        return chain
    }

    fun execution(action: JSONObject, before: JSONObject?, after: JSONObject?, observationError: Boolean = false,
                  expectedInput: String? = null, beforeEvidence: ActionReadinessEvidence? = null): JSONObject {
        val accepted = action.opt("accepted") == true
        val comparable = accepted && !observationError && before != null && after != null &&
            quality(before).getString("status") == "usable" && quality(after).getString("status") == "usable"
        val effect = if (!comparable) "unknown" else if (signature(before!!) == signature(after!!)) "unchanged" else "changed"
        val scope = if (observationError) null else verificationScope(action, before, after, expectedInput, beforeEvidence)
        return JSONObject()
            .put("dispatch", if (accepted || action.opt("dispatchState") == "sent") "sent" else "unknown")
            .put("acceptance", when (action.opt("accepted")) { true -> "accepted"; false -> "rejected"; else -> "unknown" })
            .put("effect", effect)
            .put("verification", if (scope != null) "verified" else "unverified")
            .also { if (scope != null) it.put("verificationScope", scope) }
    }
}
