package dev.tappilot.agent

import org.json.JSONObject
import kotlin.math.hypot

/** In-memory native target evidence. Never log or persist this object or its signatures. */
internal class NodeActionGuard(private val value: JSONObject) {
    internal data class Box(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        fun intersect(other: Box): Box? = Box(maxOf(left, other.left), maxOf(top, other.top), minOf(right, other.right), minOf(bottom, other.bottom)).takeIf { it.left < it.right && it.top < it.bottom }
        fun contains(x: Int, y: Int) = x >= left && x < right && y >= top && y < bottom
        fun contains(other: Box) = left <= other.left && top <= other.top && right >= other.right && bottom >= other.bottom
    }
    internal data class Touch(val targetNodeId: String, val actedNodeId: String, val x: Int, val y: Int)
    /** Fixed structural facts only; never include labels, handles or signatures. */
    internal data class ContextChange(val region: String, val kind: String, val changedNodes: Int,
        val targetMatched: Boolean, val actionTargetMatched: Boolean) {
        fun toJson(): JSONObject = JSONObject().put("region", region).put("kind", kind).put("changedNodes", changedNodes)
            .put("targetMatched", targetMatched).put("actionTargetMatched", actionTargetMatched)
    }
    private val nodes = value.getJSONArray("nodes").let { array -> (0 until array.length()).map { array.getJSONObject(it) } }
    private val byId = nodes.associateBy { it.getString("nodeId") }
    private val children = nodes.filter { !it.isNull("parentId") }.groupBy { it.getString("parentId") }
    private val root: JSONObject
    init {
        if (value.optBoolean("truncated", true) || nodes.isEmpty() || nodes.size > 500) changed("TREE_INCOMPLETE")
        if (byId.size != nodes.size || nodes.count { it.isNull("parentId") } != 1) changed("TREE_INCOMPLETE")
        root = nodes.single { it.isNull("parentId") }
        nodes.forEach { ancestry(it) }
    }
    private fun id(node: JSONObject) = node.getString("nodeId")
    private fun parent(node: JSONObject) = if (node.isNull("parentId")) null else byId[node.getString("parentId")] ?: changed("TREE_INCOMPLETE")
    private fun ancestry(node: JSONObject): List<JSONObject> {
        val result = mutableListOf<JSONObject>(); var current: JSONObject? = node
        while (current != null) {
            if (result.any { it === current } || result.size > 500) changed("TREE_INCOMPLETE")
            result.add(current); current = parent(current)
        }
        return result
    }
    private fun descends(node: JSONObject, ancestor: JSONObject) = ancestry(node).any { it === ancestor }
    private fun own(node: JSONObject, omitLabel: Boolean = false): List<Any> {
        val strings = listOf("text" to 1000, "contentDescription" to 1000, "resourceId" to 512, "className" to 512).map { (key, limit) ->
            val text = node.opt(key) as? String ?: changed("TREE_INCOMPLETE")
            if (text.length >= limit) changed("TREE_INCOMPLETE")
            if (omitLabel && key in setOf("text", "contentDescription")) "" else text
        }
        val protected = if (!node.has("contextProtected")) false else node.opt("contextProtected") as? Boolean ?: changed("TREE_INCOMPLETE")
        val contextSignature = if (!node.has("contextSignature")) "" else node.opt("contextSignature") as? String ?: changed("TREE_INCOMPLETE")
        if (contextSignature.length > 128) changed("TREE_INCOMPLETE")
        return strings + stateFields.map { node.opt(it) as? Boolean ?: changed("TREE_INCOMPLETE") } + protected + contextSignature
    }
    private fun branch(node: JSONObject): List<Any> = listOf(own(node), (children[id(node)] ?: emptyList()).map(::branch))
    private fun actual(node: JSONObject): JSONObject {
        var current = node
        repeat(8) { if (current.optBoolean("clickable")) return current; current = parent(current) ?: return@repeat }
        if (!current.optBoolean("clickable")) reject("NO_CLICKABLE_TARGET")
        return current
    }
    private fun actionable(node: JSONObject) {
        if (!node.optBoolean("enabled")) reject("TARGET_DISABLED")
        if (!node.optBoolean("visible")) reject("TARGET_HIDDEN")
        if (node.optBoolean("password")) reject("SENSITIVE_TARGET")
    }
    private fun signature(node: JSONObject, action: String): List<Any>? {
        if (!node.optBoolean("enabled") || !node.optBoolean("visible") || node.optBoolean("password")) return null
        if (action == "input_text" && !node.optBoolean("editable") || action == "scroll" && !node.optBoolean("scrollable")) return null
        val chain = ancestry(node)
        if (chain.any { !it.optBoolean("visible") || it.optBoolean("password") }) return null
        val acted = if (action in clickActions) runCatching { actual(node) }.getOrNull() ?: return null else node
        if (!acted.optBoolean("enabled") || !acted.optBoolean("visible") || acted.optBoolean("password")) return null
        return listOf(chain.map { own(it) }, branch(acted), branch(node))
    }
    private fun context(independent: Map<String, Any> = emptyMap()): List<Any> {
        fun visit(node: JSONObject): List<Any> {
            independent[id(node)]?.let { return listOf(listOf("independent-list-item", it)) }
            val descendants = (children[id(node)] ?: emptyList()).flatMap(::visit)
            val meaningful = node.getString("text").isNotEmpty() || node.getString("contentDescription").isNotEmpty() ||
                node.optBoolean("contextProtected") || node.optString("contextSignature").isNotEmpty() ||
                listOf("clickable", "scrollable", "editable", "password", "checkable", "checked", "selected", "focused").any { node.getBoolean(it) } ||
                !node.getBoolean("enabled") || !node.getBoolean("visible")
            return if (meaningful) listOf(listOf(own(node), descendants)) else descendants
        }
        return visit(root)
    }
    private fun observedRegion(node: JSONObject): Box? {
        val b = node.getJSONArray("bounds")
        if (b.length() != 4) reject("INVALID_BOUNDS")
        // Native screen bounds are integers. Empty non-target layout regions do
        // not intercept a touch; the target/ancestor path still requires area.
        return Box(b.getInt(0), b.getInt(1), b.getInt(2), b.getInt(3)).takeIf { it.left < it.right && it.top < it.bottom }
    }
    private fun box(node: JSONObject): Box = observedRegion(node) ?: reject("INVALID_BOUNDS")
    private fun listItem(node: JSONObject): Pair<JSONObject, JSONObject>? {
        var current = node
        while (true) {
            val parent = parent(current) ?: return null
            // Android reports scrollable=false when all native list rows fit.
            // Its collection role still groups rows; generic non-scrollable
            // containers never acquire this exception from geometry alone.
            if (parent.optBoolean("scrollable") || parent.getString("className") in collectionClasses) return current to parent
            current = parent
        }
    }
    private fun itemIdentity(node: JSONObject): List<Any>? = if (node.optBoolean("clickable") && node.getString("className").isNotEmpty() &&
        (node.getString("text").isNotBlank() || node.getString("contentDescription").isNotBlank())) own(node) else null
    private fun itemContext(item: JSONObject): Any? = runCatching {
        val region = box(item)
        if (!item.getBoolean("enabled") || !item.getBoolean("visible") || item.getBoolean("password")) return null
        fun visit(node: JSONObject, insideControl: Boolean, visible: Boolean, insideProtected: Boolean): Any {
            if (!region.contains(box(node))) changed("PAGE_CONTEXT_CHANGED")
            val nestedControl = insideControl || node !== item && listOf("clickable", "scrollable", "editable", "checkable", "password").any { node.getBoolean(it) }
            val visibleBranch = visible && node.getBoolean("enabled") && node.getBoolean("visible") && !node.getBoolean("password")
            val protectedBranch = insideProtected || node.optBoolean("contextProtected")
            val descendants = children[id(node)] ?: emptyList()
            if (node !== item && descendants.isEmpty() && visibleBranch && !nestedControl && !protectedBranch && listOf("checked", "selected", "focused").none { node.getBoolean(it) }) {
                return listOf("label", own(node, true), node.getString("text").isNotEmpty(), node.getString("contentDescription").isNotEmpty())
            }
            return listOf("node", own(node), descendants.map { visit(it, nestedControl, visibleBranch, protectedBranch) })
        }
        visit(item, false, true, false)
    }.getOrNull()
    private fun independentContext(fresh: NodeActionGuard, selected: JSONObject, rebound: JSONObject, action: String): Boolean {
        if (action !in clickActions) return false
        val (oldItem, oldList) = listItem(selected) ?: return false
        val (newItem, newList) = fresh.listItem(rebound) ?: return false
        if (oldList.getString("className") !in collectionClasses || newList.getString("className") !in collectionClasses) return false
        if (actual(selected) !== oldItem || fresh.actual(rebound) !== newItem) return false
        // Form controls and nested buttons cannot use collection sibling relaxation.
        if (ancestry(selected).takeWhile { it !== oldList }.any { node -> listOf("editable", "checkable", "scrollable", "password").any { node.getBoolean(it) } }) return false
        val oldRows = children[id(oldList)] ?: return false; val newRows = fresh.children[fresh.id(newList)] ?: return false
        if (oldRows.size < 2 || oldRows.size != newRows.size) return false
        val oldKeys = oldRows.map { itemIdentity(it) ?: return false }; val newKeys = newRows.map { fresh.itemIdentity(it) ?: return false }
        if (oldKeys.toSet().size != oldRows.size || oldKeys != newKeys) return false
        val selectedIndex = oldRows.indexOf(oldItem)
        if (selectedIndex < 0 || newRows[selectedIndex] !== newItem || itemContext(oldItem) == null || fresh.itemContext(newItem) == null) return false
        val oldBox = box(oldItem); val newBox = fresh.box(newItem)
        val oldContexts = mutableMapOf<String, Any>(); val newContexts = mutableMapOf<String, Any>()
        oldRows.indices.filter { it != selectedIndex }.forEach { index ->
            val oldRow = oldRows[index]; val newRow = newRows[index]
            if (listOf(box(oldRow), fresh.box(newRow)).any { it.intersect(oldBox) != null || it.intersect(newBox) != null }) return@forEach
            val oldContext = itemContext(oldRow) ?: return@forEach; val newContext = fresh.itemContext(newRow) ?: return@forEach
            if (oldContext == newContext) { oldContexts[id(oldRow)] = oldContext; newContexts[fresh.id(newRow)] = newContext }
        }
        return oldContexts.isNotEmpty() && context(oldContexts) == fresh.context(newContexts)
    }
    private fun passiveAllowance(node: JSONObject, selected: JSONObject, acted: JSONObject): Boolean {
        if ((children[id(node)] ?: emptyList()).isNotEmpty() || node.optBoolean("contextProtected")) return false
        if (listOf("clickable", "scrollable", "editable", "password", "checkable", "checked", "selected", "focused").any { node.getBoolean(it) }) return false
        if (!node.getBoolean("visible") || !node.getBoolean("enabled") || !hasContent(node)) return false
        // A passive-looking label inside another button is still that button's
        // meaning. Ordinary scroll containers do not make a status interactive.
        if (ancestry(node).drop(1).any { ancestor ->
            !ancestor.getBoolean("visible") || !ancestor.getBoolean("enabled") || ancestor.optBoolean("contextProtected") ||
                listOf("clickable", "editable", "password", "checkable").any { ancestor.getBoolean(it) }
        }) return false
        if (descends(node, selected) || descends(selected, node) || descends(node, acted) || descends(acted, node)) return false
        val region = observedRegion(node) ?: return false
        val target = observedRegion(acted) ?: return false
        return region.intersect(target) == null
    }
    /** An explicit caller contract, not an inference that arbitrary labels are irrelevant.
     * Only the named passive labels may change; ordered topology, geometry and every
     * other node's content/state remain identical. Handles themselves may be renewed.
     */
    private fun declaredLabelContext(fresh: NodeActionGuard, allowed: List<JSONObject>, rebound: JSONObject, action: String): Boolean {
        val newActed = if (action in clickActions) fresh.actual(rebound) else rebound
        val oldAllowed = allowed.map(::id).toSet()
        val newAllowed = mutableSetOf<String>()
        fun pair(old: JSONObject, current: JSONObject): Boolean {
            val oldChildren = children[id(old)] ?: emptyList()
            val newChildren = fresh.children[fresh.id(current)] ?: emptyList()
            if (oldChildren.size != newChildren.size) return false
            if (id(old) in oldAllowed) {
                if (!fresh.passiveAllowance(current, rebound, newActed)) return false
                newAllowed.add(fresh.id(current))
            }
            return oldChildren.indices.all { pair(oldChildren[it], newChildren[it]) }
        }
        if (!pair(root, fresh.root) || newAllowed.size != allowed.size) return false
        fun canonical(guard: NodeActionGuard, node: JSONObject, allowance: Set<String>): Any {
            val mayChange = guard.id(node) in allowance
            val bounds = node.getJSONArray("bounds")
            if (bounds.length() != 4) changed("PAGE_CONTEXT_CHANGED")
            return listOf(guard.own(node, mayChange), (0 until 4).map(bounds::getInt),
                if (mayChange) listOf(node.getString("text").isNotEmpty(), node.getString("contentDescription").isNotEmpty()) else emptyList<Boolean>(),
                (guard.children[guard.id(node)] ?: emptyList()).map { canonical(guard, it, allowance) })
        }
        return canonical(this, root, oldAllowed) == canonical(fresh, fresh.root, newAllowed)
    }
    fun rebind(fresh: NodeActionGuard, nodeId: String, action: String, allowedLabelChanges: List<String> = emptyList()): String {
        if (value.getString("snapshotId").substringBeforeLast(':') != fresh.value.getString("snapshotId").substringBeforeLast(':') || fresh.value.getLong("revision") < value.getLong("revision")) changed("SESSION_CHANGED")
        if (value.getInt("windowId") != fresh.value.getInt("windowId") || value.getString("packageName") != fresh.value.getString("packageName")) changed("WINDOW_CHANGED")
        val selected = byId[nodeId] ?: throw AgentError("NODE_NOT_FOUND", "The target is absent from the retained snapshot")
        actionable(selected)
        ancestry(selected).forEach {
            if (!it.getBoolean("visible")) reject("HIDDEN_ANCESTOR")
            if (it.getBoolean("password")) reject("SENSITIVE_TARGET")
        }
        if (action == "input_text" && !selected.getBoolean("editable")) throw AgentError("NOT_EDITABLE", "The selected target is not an editable field")
        if (action == "scroll" && !selected.getBoolean("scrollable")) throw AgentError("NOT_SCROLLABLE", "The selected target is not a scrollable container")
        if (action in clickActions) actionable(actual(selected))
        if (allowedLabelChanges.size > 8 || allowedLabelChanges.toSet().size != allowedLabelChanges.size) invalidAllowance()
        val acted = if (action in clickActions) actual(selected) else selected
        val allowed = allowedLabelChanges.map { allowanceId ->
            val node = byId[allowanceId] ?: invalidAllowance()
            if (!passiveAllowance(node, selected, acted)) invalidAllowance()
            node
        }
        val identity = own(selected); val expectedSignature = signature(selected, action) ?: reject("NO_CLICKABLE_TARGET")
        if (nodes.count { own(it) == identity && signature(it, action) == expectedSignature } != 1) changed("TARGET_AMBIGUOUS")
        val candidates = fresh.nodes.filter { fresh.own(it) == identity && fresh.signature(it, action) == expectedSignature }
        if (candidates.isEmpty()) changed("TARGET_IDENTITY_CHANGED")
        if (candidates.size != 1) changed("TARGET_AMBIGUOUS")
        val rebound = candidates.single()
        if (allowed.isNotEmpty()) {
            if (!declaredLabelContext(fresh, allowed, rebound, action)) contextChanged(fresh, selected, rebound, action)
        } else if (context() != fresh.context() && !independentContext(fresh, selected, rebound, action)) contextChanged(fresh, selected, rebound, action)
        return fresh.id(rebound)
    }
    private fun contextChanged(fresh: NodeActionGuard, selected: JSONObject, rebound: JSONObject, action: String): Nothing =
        throw AgentError("TARGET_CHANGED", "The intended target or its relevant page context changed. No action was sent.", true, "PAGE_CONTEXT_CHANGED")
            .also { it.nativeContextChange = contextChange(fresh, selected, rebound, action) }

    /** This runs only after unique target/action signature matching. Positional
     * comparisons establish a location only when the entire native topology and
     * target correspondence align; a replaced branch yields unknown evidence.
     * These facts describe location, never whether a changed label is safe.
     */
    private fun contextChange(fresh: NodeActionGuard, selected: JSONObject, rebound: JSONObject, action: String): ContextChange {
        val unknownStructure = ContextChange("unknown", "structure", 0, false, false)
        val pairs = mutableListOf<Pair<JSONObject, JSONObject>>()
        fun align(old: JSONObject, current: JSONObject): Boolean {
            val oldChildren = children[id(old)] ?: emptyList()
            val newChildren = fresh.children[fresh.id(current)] ?: emptyList()
            if (old.getString("className") != current.getString("className") || old.getString("resourceId") != current.getString("resourceId") || oldChildren.size != newChildren.size) return false
            pairs.add(old to current)
            return oldChildren.indices.all { align(oldChildren[it], newChildren[it]) }
        }
        if (!align(root, fresh.root) || pairs.none { it.first === selected && it.second === rebound }) return unknownStructure
        val acted = if (action in clickActions) actual(selected) else selected
        val newActed = if (action in clickActions) fresh.actual(rebound) else rebound
        if (pairs.none { it.first === acted && it.second === newActed }) return unknownStructure
        fun sameBounds(old: JSONObject, current: JSONObject): Boolean {
            val a = old.getJSONArray("bounds"); val b = current.getJSONArray("bounds")
            return a.length() == 4 && b.length() == 4 && (0 until 4).all { a.getInt(it) == b.getInt(it) }
        }
        fun matched(target: JSONObject): Boolean = pairs.filter { descends(it.first, target) || descends(target, it.first) }
            .all { (old, current) -> own(old) == fresh.own(current) && sameBounds(old, current) }
        val regions = mutableSetOf<String>(); val kinds = mutableSetOf<String>(); var changedNodes = 0
        // A ScrollView groups form controls, not independent collection rows.
        val targetItem = listItem(selected)?.takeIf { it.second.getString("className") in collectionClasses }
        for ((old, current) in pairs) {
            val nodeKinds = mutableSetOf<String>()
            if (old.getString("text") != current.getString("text") || old.getString("contentDescription") != current.getString("contentDescription")) nodeKinds.add("content")
            if (stateFields.any { old.getBoolean(it) != current.getBoolean(it) } || old.optBoolean("contextProtected") != current.optBoolean("contextProtected")) nodeKinds.add("state")
            // This digest covers several native semantics. It is not evidence
            // that only visible text changed, and the digest itself stays private.
            if (old.optString("contextSignature") != current.optString("contextSignature")) nodeKinds.add("unknown")
            if (!sameBounds(old, current)) nodeKinds.add("geometry")
            if (nodeKinds.isEmpty()) continue
            changedNodes++; kinds.addAll(nodeKinds)
            regions.add(when {
                old === selected -> "target"
                descends(selected, old) -> "ancestor"
                descends(old, acted) -> "target_descendant"
                else -> {
                    val item = listItem(old)
                    if (targetItem != null && item?.second === targetItem.second && item.first !== targetItem.first) "peer_item" else "outside_target"
                }
            })
        }
        return ContextChange(if (regions.size > 1) "mixed" else regions.singleOrNull() ?: "unknown",
            if (kinds.size > 1) "mixed" else kinds.singleOrNull() ?: "unknown", changedNodes, matched(selected), matched(acted))
    }
    /** Factual, bounded diagnostics only: changed labels are not permission to ignore them.
     * Handles refer to the fresh observation; no prior text is exposed. Mixed
     * geometry/role/state/semantic/structure changes deliberately yield no hint.
     */
    fun changedLabelNodeIds(fresh: NodeActionGuard): List<String>? = runCatching {
        if (value.getString("snapshotId").substringBeforeLast(':') != fresh.value.getString("snapshotId").substringBeforeLast(':') ||
            fresh.value.getLong("revision") < value.getLong("revision") || value.getInt("windowId") != fresh.value.getInt("windowId") ||
            value.getString("packageName") != fresh.value.getString("packageName")) return@runCatching null
        val changedLabels = mutableListOf<String>()
        fun compare(old: JSONObject, current: JSONObject): Boolean {
            if (own(old, true) != fresh.own(current, true)) return false
            val oldBounds = old.getJSONArray("bounds"); val newBounds = current.getJSONArray("bounds")
            if (oldBounds.length() != 4 || newBounds.length() != 4 || (0 until 4).any { oldBounds.getInt(it) != newBounds.getInt(it) }) return false
            val oldChildren = children[id(old)] ?: emptyList()
            val newChildren = fresh.children[fresh.id(current)] ?: emptyList()
            if (oldChildren.size != newChildren.size) return false
            if (old.getString("text") != current.getString("text") || old.getString("contentDescription") != current.getString("contentDescription")) {
                changedLabels.add(fresh.id(current))
                if (changedLabels.size > 8) return false
            }
            return oldChildren.indices.all { compare(oldChildren[it], newChildren[it]) }
        }
        if (compare(root, fresh.root) && changedLabels.isNotEmpty()) changedLabels.toList() else null
    }.getOrNull()

    /** Applies sensitive-label policy to the entire actual clicked container. */
    fun clickTarget(nodeId: String): String {
        val selected = byId[nodeId] ?: reject("INVALID_HIERARCHY"); actionable(selected)
        val acted = actual(selected); actionable(acted)
        ancestry(selected).forEach { if (!it.getBoolean("visible")) reject("HIDDEN_ANCESTOR"); if (it.getBoolean("password")) reject("SENSITIVE_TARGET") }
        if (nodes.any { descends(it, acted) && sensitive(it) }) throw AgentError("MANUAL_ACTION_REQUIRED", "This control may send, purchase, delete or submit. Complete this step manually.")
        return id(acted)
    }
    fun touch(nodeId: String, screenWidth: Int, screenHeight: Int): Touch {
        val acted = byId[clickTarget(nodeId)]!!; val selected = byId[nodeId]!!
        val region = ancestry(selected).fold(Box(0, 0, screenWidth, screenHeight) as Box?) { area, node -> area?.intersect(box(node)) } ?: reject("TARGET_CLIPPED")
        val blockers = mutableListOf<Box>()
        for (node in nodes) {
            if (!node.getBoolean("visible")) continue
            val bounds = observedRegion(node) ?: continue
            if (bounds.intersect(region) == null) continue
            if (node.getBoolean("password")) reject("SENSITIVE_TARGET")
            if (sensitive(node)) throw AgentError("MANUAL_ACTION_REQUIRED", "The intended touch region intersects a potentially sensitive control. Complete this step manually.")
            if (node === acted || descends(acted, node)) continue
            if (node.getBoolean("clickable") || hasContent(node) && !descends(node, acted)) blockers.add(bounds)
        }
        val point = touchPoint(region, blockers) ?: reject("AMBIGUOUS_TOUCH_TARGET")
        val containing = nodes.filter { it.getBoolean("visible") && observedRegion(it)?.contains(point.first, point.second) == true }
        val clickable = containing.filter { it.getBoolean("clickable") }
        val deepest = clickable.filter { node -> clickable.none { it !== node && descends(it, node) } }
        if (deepest.size != 1 || deepest.single() !== acted) reject("TOUCH_TARGET_MISMATCH")
        return Touch(nodeId, id(acted), point.first, point.second)
    }
    /** Raw short gestures must obey the same hit/sensitive policy as node taps. */
    fun validateShortGesture(startX: Int, startY: Int, endX: Int, endY: Int) {
        fun hit(x: Int, y: Int): JSONObject {
            val containing = nodes.filter { it.getBoolean("visible") && observedRegion(it)?.contains(x, y) == true }
            if (containing.any { it.getBoolean("password") }) reject("SENSITIVE_TARGET")
            val clickable = containing.filter { it.getBoolean("clickable") }
            val deepest = clickable.filter { candidate -> clickable.none { it !== candidate && descends(it, candidate) } }
            if (deepest.isEmpty()) reject("NO_CLICKABLE_TARGET")
            if (deepest.size != 1) reject("AMBIGUOUS_TOUCH_TARGET")
            val actual = deepest.single()
            clickTarget(id(actual))
            if (containing.any(::sensitive)) throw AgentError("MANUAL_ACTION_REQUIRED", "The touch intersects a potentially sensitive control. Complete this step manually.")
            if (containing.any { hasContent(it) && !descends(it, actual) && !descends(actual, it) }) reject("AMBIGUOUS_TOUCH_TARGET")
            return actual
        }
        if (hit(startX, startY) !== hit(endX, endY)) reject("TOUCH_TARGET_MISMATCH")
    }
    fun targetBounds(nodeId: String): Box = box(byId[nodeId] ?: reject("INVALID_HIERARCHY"))
    companion object {
        const val EXECUTOR = "node-v1"
        private val stateFields = listOf("clickable", "scrollable", "editable", "enabled", "password", "checkable", "checked", "selected", "focused", "visible")
        private val clickActions = setOf("tap_element", "click_element")
        private val collectionClasses = setOf("androidx.recyclerview.widget.RecyclerView", "android.support.v7.widget.RecyclerView", "android.widget.ListView", "android.widget.GridView")
        private val sensitiveLabel = Regex("付款|支付|下单|提交订单|确认购买|立即购买|删除|清空|转账|发红包|发送|发布|卸载|恢复出厂|重置设备|\\b(pay|purchase|checkout|buy\\s+now|delete|erase|send|submit|publish|uninstall|transfer)\\b", RegexOption.IGNORE_CASE)
        private fun sensitive(node: JSONObject) = sensitiveLabel.containsMatchIn(listOf("text", "contentDescription", "resourceId").joinToString(" ") { node.getString(it) }.replace('_', ' '))
        private fun hasContent(node: JSONObject) = listOf("clickable", "scrollable", "editable", "checkable", "password").any { node.getBoolean(it) } || listOf("text", "contentDescription").any { node.getString(it).isNotBlank() }
        private fun changed(reason: String): Nothing = throw AgentError("TARGET_CHANGED", "The intended target or its relevant page context changed. No action was sent.", true, reason)
        private fun invalidAllowance(): Nothing = throw AgentError("INVALID_ARGUMENT", "allowedLabelChanges must name at most eight distinct passive, unprotected labels outside the target region.")
        private fun reject(reason: String): Nothing = throw AgentError("NODE_NOT_ACTIONABLE", "The selected target cannot be safely operated. No action was sent.", false, reason)
        internal fun touchPoint(region: Box, blockers: List<Box>): Pair<Int, Int>? {
            var remaining = listOf(region)
            for (blocker in blockers) {
                remaining = remaining.flatMap { area ->
                    val overlap = area.intersect(blocker) ?: return@flatMap listOf(area)
                    listOf(Box(area.left, area.top, area.right, overlap.top), Box(area.left, overlap.bottom, area.right, area.bottom), Box(area.left, overlap.top, overlap.left, overlap.bottom), Box(overlap.right, overlap.top, area.right, overlap.bottom)).filter { it.left < it.right && it.top < it.bottom }
                }
                if (remaining.isEmpty() || remaining.size > 4096) return null
            }
            return remaining.map { area ->
                val x = (area.left + area.right) / 2; val y = (area.top + area.bottom) / 2
                val clearance = minOf(x - area.left, y - area.top, area.right - x, area.bottom - y)
                Triple(x to y, clearance, area)
            }.filter { it.second >= 4 }.sortedWith(compareByDescending<Triple<Pair<Int, Int>, Int, Box>> { it.second }.thenByDescending { (it.third.right - it.third.left) * (it.third.bottom - it.third.top) }.thenBy { hypot(it.first.first - (region.left + region.right) / 2.0, it.first.second - (region.top + region.bottom) / 2.0) }.thenBy { it.first.second }.thenBy { it.first.first }).firstOrNull()?.first
        }
    }
}
