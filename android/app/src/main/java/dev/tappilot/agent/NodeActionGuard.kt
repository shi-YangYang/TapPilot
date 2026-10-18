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
    internal data class RebindEvidence(val nodeId: String, val contextVerification: String, val automaticLabelChangesCount: Int = 0)
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
        val strings = stringLimits.flatMap { (key, limit) ->
            val text = node.opt(key) as? String ?: changed("TREE_INCOMPLETE")
            if (text.length > limit) changed("TREE_INCOMPLETE")
            // The public tree clips text for transport, not because native
            // evidence is incomplete. Only private evidence captured by the
            // service may prove equality beyond that clipped prefix.
            val signature = if (text.length == limit) {
                val proof = node.optJSONObject("nativeFieldSignatures")?.opt(key) as? String ?: changed("TREE_INCOMPLETE")
                if (!digestPattern.matches(proof)) changed("TREE_INCOMPLETE")
                proof
            } else ""
            if (omitLabel && key in setOf("text", "contentDescription")) listOf("", "") else listOf(text, signature)
        }
        val protected = if (!node.has("contextProtected")) false else node.opt("contextProtected") as? Boolean ?: changed("TREE_INCOMPLETE")
        val contextSignature = if (!node.has("contextSignature")) "" else node.opt("contextSignature") as? String ?: changed("TREE_INCOMPLETE")
        if (contextSignature.length > 128) changed("TREE_INCOMPLETE")
        return strings + stateFields.map { node.opt(it) as? Boolean ?: changed("TREE_INCOMPLETE") } + protected + contextSignature + nativeNavigationEvidence(node)
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
    private fun context(independent: Map<String, Any> = emptyMap(), collectionOrder: Map<String, List<JSONObject>> = emptyMap()): List<Any> {
        fun visit(node: JSONObject): List<Any> {
            independent[id(node)]?.let { return listOf(listOf("independent-list-item", it)) }
            val descendants = (collectionOrder[id(node)] ?: children[id(node)] ?: emptyList()).flatMap(::visit)
            val meaningful = node.getString("text").isNotEmpty() || node.getString("contentDescription").isNotEmpty() ||
                node.optBoolean("contextProtected") || node.optString("contextSignature").isNotEmpty() || hasNativeNavigationRole(node) ||
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
            if (node !== item && descendants.isEmpty() && visibleBranch && !nestedControl && !protectedBranch && !hasClippedLabel(node) && listOf("checked", "selected", "focused").none { node.getBoolean(it) }) {
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
        // Native collections identify independently actionable rows. Reordering
        // those same uniquely identified rows does not change the selected row.
        // A repeated label, replacement, added/removed row or changed row state
        // is not evidence of a permutation and keeps the conservative contract.
        if (oldKeys.toSet().size != oldRows.size || newKeys.toSet().size != newRows.size || oldKeys.toSet() != newKeys.toSet()) return false
        val newByKey = newKeys.zip(newRows).toMap()
        val alignedRows = oldKeys.map { newByKey.getValue(it) }
        val selectedIndex = oldRows.indexOf(oldItem)
        if (selectedIndex < 0 || alignedRows[selectedIndex] !== newItem || itemContext(oldItem) == null || fresh.itemContext(newItem) == null) return false
        val oldBox = box(oldItem); val newBox = fresh.box(newItem)
        val oldContexts = mutableMapOf<String, Any>(); val newContexts = mutableMapOf<String, Any>()
        oldRows.indices.filter { it != selectedIndex }.forEach { index ->
            val oldRow = oldRows[index]; val newRow = alignedRows[index]
            // Compare overlap within each observation. A row may legitimately
            // occupy the target's former position after a list permutation;
            // dispatch still resolves and hit-tests the freshly observed node.
            if (box(oldRow).intersect(oldBox) != null || fresh.box(newRow).intersect(newBox) != null) return@forEach
            val oldContext = itemContext(oldRow) ?: return@forEach; val newContext = fresh.itemContext(newRow) ?: return@forEach
            if (oldContext == newContext) { oldContexts[id(oldRow)] = oldContext; newContexts[fresh.id(newRow)] = newContext }
        }
        return context(oldContexts) == fresh.context(newContexts, mapOf(fresh.id(newList) to alignedRows))
    }
    private fun passiveAllowance(node: JSONObject, selected: JSONObject, acted: JSONObject): Boolean {
        if ((children[id(node)] ?: emptyList()).isNotEmpty() || node.optBoolean("contextProtected")) return false
        // A caller only sees the clipped prefix, so cannot declare its hidden
        // tail irrelevant. Full native equality permits execution, not waiver.
        if (hasClippedLabel(node)) return false
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
    /** A dedicated search toolbar owns its editor and explicit submit control.
     * Its query, mode, controls and geometry remain exact. Only native collection
     * content in the separate body may load/reorder; ordinary outside labels,
     * form state and protected context remain significant. This is not a generic
     * editable-field or arbitrary disjoint-region exemption.
     */
    private fun searchToolbarContext(fresh: NodeActionGuard, selected: JSONObject, rebound: JSONObject, action: String): Boolean {
        if (action != "input_text" && action !in clickActions) return false
        fun searchLabel(node: JSONObject) = listOf("text", "contentDescription").any { node.getString(it).trim().lowercase() in searchLabels }
        fun toolbar(guard: NodeActionGuard, target: JSONObject): JSONObject? {
            val editors = guard.nodes.filter { it.getBoolean("editable") && it.getBoolean("focused") && searchLabel(it) }
            val editor = editors.singleOrNull() ?: return null
            val bar = guard.parent(editor) ?: return null
            if (bar === guard.root || !bar.getBoolean("enabled") || !bar.getBoolean("visible") ||
                listOf("clickable", "scrollable", "editable", "checkable", "password").any { bar.getBoolean(it) }) return null
            val submit = guard.children[guard.id(bar)].orEmpty().filter {
                it !== editor && it.getBoolean("clickable") && !it.getBoolean("editable") && searchLabel(it)
            }.singleOrNull() ?: return null
            if (if (action == "input_text") target !== editor else guard.actual(target) !== submit) return null
            val area = guard.box(bar); val display = guard.box(guard.root)
            if (!display.contains(area) || area.bottom - area.top > (display.bottom - display.top) / 4) return null
            return bar
        }
        val oldBar = toolbar(this, selected) ?: return false
        val newBar = toolbar(fresh, rebound) ?: return false
        if (branch(oldBar) != fresh.branch(newBar)) return false
        fun sameGeometry(old: JSONObject, current: JSONObject): Boolean {
            if (box(old) != fresh.box(current)) return false
            val oldChildren = children[id(old)].orEmpty(); val newChildren = fresh.children[fresh.id(current)].orEmpty()
            return oldChildren.size == newChildren.size && oldChildren.indices.all { sameGeometry(oldChildren[it], newChildren[it]) }
        }
        if (!sameGeometry(oldBar, newBar)) return false
        fun outside(guard: NodeActionGuard, bar: JSONObject) = guard.nodes.filter { !guard.descends(it, bar) && !guard.descends(bar, it) }
        fun safeOutside(guard: NodeActionGuard, bar: JSONObject): Boolean {
            val area = guard.box(bar)
            return outside(guard, bar).all { node ->
                !node.optBoolean("contextProtected") && listOf("editable", "checkable", "password", "focused").none { node.getBoolean(it) } &&
                    guard.observedRegion(node)?.intersect(area) == null
            }
        }
        if (!safeOutside(this, oldBar) || !safeOutside(fresh, newBar)) return false
        fun normalized(guard: NodeActionGuard, node: JSONObject): JSONObject =
            if (node.getString("className") in searchBodyClasses && !guard.descends(node, if (guard === this) oldBar else newBar))
                JSONObject(node.toString()).put("scrollable", false) else node
        // New small voice/help surfaces in an already observed search body may
        // appear as root siblings. Their position alone is insufficient: require
        // the same existing native body region, with no form/sensitive semantics.
        val oldBodies = outside(this, oldBar).mapNotNull { body ->
            val area = observedRegion(body) ?: return@mapNotNull null
            area.takeIf { body.getString("className") in searchBodyClasses && area.top >= box(oldBar).bottom &&
                fresh.nodes.any { current -> area == fresh.observedRegion(current) && own(normalized(this, body)) == fresh.own(normalized(fresh, current)) } }
        }
        val addedSurfaces = fresh.children[fresh.id(fresh.root)].orEmpty().filter { surface ->
            val area = fresh.observedRegion(surface) ?: return@filter false
            val body = oldBodies.firstOrNull { it.contains(area) } ?: return@filter false
            if (surface.getString("className") !in setOf("android.view.ViewGroup", "android.widget.FrameLayout") ||
                surface.getString("text").isNotEmpty() || surface.getString("contentDescription").isNotEmpty() ||
                area.bottom - area.top > (body.bottom - body.top) / 4 ||
                children[id(root)].orEmpty().any { old -> observedRegion(old) == area && own(old) == fresh.own(surface) }) return@filter false
            val descendants = fresh.nodes.filter { fresh.descends(it, surface) }
            descendants.size in 2..8 && descendants.count { it.getBoolean("clickable") } <= 1 && descendants.all {
                fresh.observedRegion(it)?.let(area::contains) == true && !sensitive(it) && !it.optBoolean("contextProtected") &&
                    listOf("editable", "checkable", "password", "scrollable").none { field -> it.getBoolean(field) }
            }
        }.map(fresh::id).toSet()
        fun context(guard: NodeActionGuard, bar: JSONObject, added: Set<String>): List<Any> {
            fun visit(node: JSONObject): List<Any> {
                if (node === bar) return listOf(listOf("unchanged-search-toolbar"))
                if (guard.id(node) in added) return emptyList()
                if (node.getString("className") in collectionClasses && !guard.descends(bar, node) &&
                    node.getString("text").isEmpty() && node.getString("contentDescription").isEmpty() &&
                    !node.getBoolean("clickable")) return emptyList()
                val value = normalized(guard, node)
                val descendants = guard.children[guard.id(node)].orEmpty().flatMap(::visit)
                val meaningful = value.getString("text").isNotEmpty() || value.getString("contentDescription").isNotEmpty() ||
                    value.optBoolean("contextProtected") || value.optString("contextSignature").isNotEmpty() ||
                    listOf("clickable", "scrollable", "editable", "password", "checkable", "checked", "selected", "focused").any { value.getBoolean(it) } ||
                    !value.getBoolean("enabled") || !value.getBoolean("visible")
                return if (meaningful) listOf(listOf(guard.own(value), descendants)) else descendants
            }
            return visit(guard.root)
        }
        return context(this, oldBar, emptySet()) == context(fresh, newBar, addedSurfaces)
    }
    private fun nativeTabBar(target: JSONObject): JSONObject? {
        val guard = this
        val acted = guard.actual(target)
        if (acted.opt("nativeTabRole") != true || acted.optJSONObject("nativeCollectionItem") == null) return null
        val bar = guard.ancestry(acted).drop(1).firstOrNull { it.optJSONObject("nativeCollection") != null } ?: return null
        val info = bar.getJSONObject("nativeCollection")
        if (info.keys().asSequence().toSet() != setOf("rows", "columns", "hierarchical", "selectionMode") ||
            info.opt("rows") != 1 || info.opt("hierarchical") != false || info.opt("selectionMode") != 1) return null
        val count = (info.opt("columns") as? Int)?.takeIf { it in 2..8 } ?: return null
        val area = guard.observedRegion(bar) ?: return null
        if (!guard.box(guard.root).contains(area) || guard.ancestry(bar).any { !it.getBoolean("enabled") || !it.getBoolean("visible") }) return null
        val descendants = guard.nodes.filter { it !== bar && guard.descends(it, bar) }
        val tabs = descendants.filter { it.opt("nativeTabRole") == true || it.optJSONObject("nativeCollectionItem") != null }
        if (tabs.size != count || acted !in tabs) return null
        val columns = mutableSetOf<Int>()
        for (tab in tabs) {
            val item = tab.optJSONObject("nativeCollectionItem") ?: return null
            if (item.keys().asSequence().toSet() != setOf("row", "rowSpan", "column", "columnSpan", "heading", "selected") ||
                item.opt("row") != 0 || item.opt("rowSpan") != 1 || item.opt("columnSpan") != 1 || item.opt("heading") != false ||
                item.opt("selected") != tab.getBoolean("selected") || tab.opt("nativeTabRole") != true ||
                (!tab.getBoolean("selected") && !tab.getBoolean("clickable")) || !tab.getBoolean("enabled") || !tab.getBoolean("visible") ||
                listOf("editable", "scrollable", "checkable", "password").any { tab.getBoolean(it) }) return null
            val column = item.opt("column") as? Int ?: return null
            if (column !in 0 until count || !columns.add(column) || !area.contains(guard.box(tab))) return null
            val branch = guard.nodes.filter { guard.descends(it, tab) }
            if (branch.none { it.getString("text").isNotBlank() || it.getString("contentDescription").isNotBlank() } || branch.any {
                !guard.box(tab).contains(guard.box(it)) || !it.getBoolean("enabled") || !it.getBoolean("visible") ||
                    it !== tab && listOf("clickable", "editable", "scrollable", "checkable", "password").any { flag -> it.getBoolean(flag) }
            }) return null
        }
        if (tabs.count { it.getBoolean("selected") } != 1 || acted.getBoolean("selected")) return null
        // Distinct native columns must also have independently identifiable
        // content; duplicated labels are not disambiguated by coordinates.
        fun identity(node: JSONObject): List<Any> = listOf(stringLimits.map { node.getString(it.first) },
            guard.children[guard.id(node)].orEmpty().map(::identity))
        if (tabs.map(::identity).toSet().size != count || tabs.indices.any { i ->
            tabs.indices.any { j -> i < j && guard.box(tabs[i]).intersect(guard.box(tabs[j])) != null }
        }) return null
        // Intermediary layout wrappers are allowed, extra controls/content
        // and nested collections in the bar are not.
        if ((listOf(bar) + descendants).any { node ->
            node !== bar && node.optJSONObject("nativeCollection") != null ||
                tabs.none { guard.descends(node, it) } && (
                    node.getString("text").isNotEmpty() || node.getString("contentDescription").isNotEmpty() ||
                        node.opt("nativeTabRole") == true || node.optJSONObject("nativeCollectionItem") != null ||
                        listOf("clickable", "editable", "scrollable", "checkable", "password").any { node.getBoolean(it) })
        }) return null
        // A tab may navigate a form or review page; native role alone says
        // nothing about recipient/account/payment context. This deny rule
        // is intentionally conservative and is not a semantic classifier.
        if (guard.nodes.any { node ->
            node.getBoolean("visible") && (listOf("editable", "checkable", "password").any { node.getBoolean(it) } ||
                sensitive(node) || hasClippedLabel(node) || businessContext.containsMatchIn(
                    listOf("text", "contentDescription", "resourceId").joinToString(" ") { node.getString(it) }.replace('_', ' ')))
        }) return null
        return bar
    }

    private fun nativeTabPassiveLabel(node: JSONObject, bar: JSONObject, target: JSONObject): Boolean =
        !descends(node, bar) && passiveAllowance(node, target, actual(target)) &&
            node.optString("contextSignature").isEmpty() && !hasNativeNavigationRole(node) &&
            box(node).intersect(box(bar)) == null

    /** A private readiness digest, never action authorization. Native tab bars
     * can settle while independent display labels refresh. The full guard still
     * checks the requested action and its native scope immediately before dispatch.
     */
    internal fun nativeTabReadinessSignature(): String? = runCatching {
        val candidates = nodes.filter { it.opt("nativeTabRole") == true && !it.getBoolean("selected") }
        if (candidates.isEmpty()) return@runCatching null
        val target = candidates.first()
        val bar = nativeTabBar(target) ?: return@runCatching null
        // nativeTabBar already validates every item in this complete collection.
        // Additional native tab candidates outside it mean multiple scopes, not
        // a reason to rescan the entire tree once per tab on every sample.
        if (candidates.any { !descends(it, bar) }) return@runCatching null
        val allowed = nodes.filter { nativeTabPassiveLabel(it, bar, target) }
        if (allowed.isEmpty() || allowed.size > 8) return@runCatching null
        snapshotFingerprintDigest(listOf(org.json.JSONArray(listOf(value.getString("snapshotId").substringBeforeLast(':'), value.getInt("windowId"),
            value.getString("packageName"), declaredLabelCanonical(root, allowed.map(::id).toSet(), exactNative = true))).toString()))
    }.getOrNull()

    /** Native tabs define a limited navigation action, not a general exemption for
     * disjoint text. Require a complete, unchanged single-selection tab bar and
     * reject forms/business contexts before considering passive outside leaves.
     * This cannot infer that an arbitrary button is unrelated to refreshed text.
     */
    private fun nativeTabNavigationContext(fresh: NodeActionGuard, selected: JSONObject, rebound: JSONObject, action: String): Int = runCatching {
        if (action !in clickActions) return@runCatching 0
        val previousBar = nativeTabBar(selected) ?: return@runCatching 0
        val currentBar = fresh.nativeTabBar(rebound) ?: return@runCatching 0
        val freshChanged = changedLabelNodeIds(fresh)?.toSet() ?: return@runCatching 0
        val allowed = mutableListOf<JSONObject>()
        fun align(old: JSONObject, current: JSONObject) {
            if (fresh.id(current) in freshChanged) allowed.add(old)
            val before = children[id(old)].orEmpty(); val after = fresh.children[fresh.id(current)].orEmpty()
            before.indices.forEach { align(before[it], after[it]) }
        }
        align(root, fresh.root)
        if (allowed.isEmpty() || allowed.size > 8 || allowed.any { node ->
            !nativeTabPassiveLabel(node, previousBar, selected)
        }) return@runCatching 0
        if (freshChanged.any { nodeId ->
            val node = fresh.byId.getValue(nodeId)
            !fresh.nativeTabPassiveLabel(node, currentBar, rebound)
        }) return@runCatching 0
        if (declaredLabelContext(fresh, allowed, rebound, action, exactNative = true)) allowed.size else 0
    }.getOrDefault(0)

    /** An explicit caller contract, not an inference that arbitrary labels are irrelevant.
     * Only the named passive labels may change; ordered topology, geometry and every
     * other node's content/state remain identical. Handles themselves may be renewed.
     */
    private fun declaredLabelContext(fresh: NodeActionGuard, allowed: List<JSONObject>, rebound: JSONObject, action: String, exactNative: Boolean = false): Boolean {
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
        return declaredLabelCanonical(root, oldAllowed, exactNative) == fresh.declaredLabelCanonical(fresh.root, newAllowed, exactNative)
    }
    private fun declaredLabelCanonical(node: JSONObject, allowance: Set<String>, exactNative: Boolean): Any {
        val mayChange = id(node) in allowance
        val bounds = node.getJSONArray("bounds")
        if (bounds.length() != 4) changed("PAGE_CONTEXT_CHANGED")
        return listOf(own(node, mayChange), (0 until 4).map(bounds::getInt), node.opt("nativeDrawingOrder") ?: 0,
            if (exactNative) privateNativeEvidence(node) else emptyList<Any>(),
            if (mayChange) listOf(node.getString("text").isNotEmpty(), node.getString("contentDescription").isNotEmpty()) else emptyList<Boolean>(),
            children[id(node)].orEmpty().map { declaredLabelCanonical(it, allowance, exactNative) })
    }

    fun rebind(fresh: NodeActionGuard, nodeId: String, action: String, allowedLabelChanges: List<String> = emptyList()): String =
        rebindEvidence(fresh, nodeId, action, allowedLabelChanges).nodeId

    fun rebindEvidence(fresh: NodeActionGuard, nodeId: String, action: String, allowedLabelChanges: List<String> = emptyList()): RebindEvidence {
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
            return RebindEvidence(fresh.id(rebound), "explicit_label_changes")
        }
        if (context() != fresh.context() && !independentContext(fresh, selected, rebound, action) && !searchToolbarContext(fresh, selected, rebound, action)) {
            val automatic = nativeTabNavigationContext(fresh, selected, rebound, action)
            if (automatic == 0) contextChanged(fresh, selected, rebound, action)
            return RebindEvidence(fresh.id(rebound), "native_tab_navigation", automatic)
        }
        return RebindEvidence(fresh.id(rebound), "default_context")
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
            if (listOf("text", "contentDescription").any { old.optJSONObject("nativeFieldSignatures")?.optString(it).orEmpty() != current.optJSONObject("nativeFieldSignatures")?.optString(it).orEmpty() }) nodeKinds.add("content")
            if (stateFields.any { old.getBoolean(it) != current.getBoolean(it) } || old.optBoolean("contextProtected") != current.optBoolean("contextProtected")) nodeKinds.add("state")
            // This digest covers several native semantics. It is not evidence
            // that only visible text changed, and the digest itself stays private.
            if (old.optString("contextSignature") != current.optString("contextSignature") ||
                nativeNavigationEvidence(old) != nativeNavigationEvidence(current)) nodeKinds.add("unknown")
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
            if (old.opt("nativeDrawingOrder") != current.opt("nativeDrawingOrder")) return false
            if (listOf("text", "contentDescription").any { key ->
                (old.getString(key).length >= 1000 || current.getString(key).length >= 1000) &&
                    (old.getString(key) != current.getString(key) || old.optJSONObject("nativeFieldSignatures")?.optString(key).orEmpty() != current.optJSONObject("nativeFieldSignatures")?.optString(key).orEmpty())
            }) return false
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
    /** Native drawing order is relative to the native accessibility parent.
     * Ignore only a passive scroll container proved behind the target branch;
     * its overlapping children still receive their own blocker/sensitive checks.
     * Never compare compact parentIds: capture may omit invisible native nodes.
     */
    private fun passiveContainerBehind(node: JSONObject, target: JSONObject): Boolean {
        if (!node.getBoolean("scrollable") || !node.getBoolean("enabled") || node.optBoolean("contextProtected") ||
            listOf("clickable", "editable", "checkable", "password", "checked", "selected", "focused").any { node.getBoolean(it) } ||
            listOf("text", "contentDescription").any { node.getString(it).isNotEmpty() }) return false
        fun nativePath(value: JSONObject): List<Int>? {
            val path = value.optJSONArray("nativePath") ?: return null
            if (path.length() > 40) return null
            return (0 until path.length()).map { index ->
                val part = path.opt(index) as? Int ?: return null
                if (part < 0) return null
                part
            }
        }
        val path = nativePath(node)?.takeIf { it.isNotEmpty() } ?: return false
        val order = node.opt("nativeDrawingOrder") as? Int ?: return false
        if (order <= 0) return false
        val siblingsParent = path.dropLast(1)
        val branch = ancestry(target).firstOrNull { candidate ->
            val other = nativePath(candidate)
            other != null && other.size == path.size && other.dropLast(1) == siblingsParent && other != path
        } ?: return false
        val targetOrder = branch.opt("nativeDrawingOrder") as? Int ?: return false
        return targetOrder > order
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
            if (passiveContainerBehind(node, acted)) continue
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
            if (containing.any { hasContent(it) && !descends(it, actual) && !descends(actual, it) && !passiveContainerBehind(it, actual) }) reject("AMBIGUOUS_TOUCH_TARGET")
            return actual
        }
        if (hit(startX, startY) !== hit(endX, endY)) reject("TOUCH_TARGET_MISMATCH")
    }
    fun targetBounds(nodeId: String): Box = box(byId[nodeId] ?: reject("INVALID_HIERARCHY"))
    companion object {
        const val EXECUTOR = "node-v1"
        private val stateFields = listOf("clickable", "scrollable", "editable", "enabled", "password", "checkable", "checked", "selected", "focused", "visible")
        private val stringLimits = listOf("text" to 1000, "contentDescription" to 1000, "resourceId" to 512, "className" to 512)
        private val digestPattern = Regex("[0-9a-f]{64}")
        private val clickActions = setOf("tap_element", "click_element")
        private val collectionClasses = setOf("androidx.recyclerview.widget.RecyclerView", "android.support.v7.widget.RecyclerView", "android.widget.ListView", "android.widget.GridView")
        private val searchLabels = setOf("搜索", "搜尋", "search")
        private val searchBodyClasses = collectionClasses + setOf("android.widget.ScrollView", "android.widget.HorizontalScrollView")
        private val businessContext = Regex("收件|收款|收货|账号|账户|金额|余额|付款|支付|订单|账单|总价|合计|价格|转账|\\b(recipient|receiver|beneficiary|account|amount|balance|payment|invoice|order|price|total|checkout|bank|credit|debit)\\b", RegexOption.IGNORE_CASE)
        private fun jsonEvidence(value: Any?): Any = when (value) {
            null, JSONObject.NULL -> ""
            is JSONObject -> value.keys().asSequence().sorted().map { listOf(it, jsonEvidence(value.opt(it))) }.toList()
            is org.json.JSONArray -> (0 until value.length()).map { jsonEvidence(value.opt(it)) }
            is String, is Boolean, is Number -> value
            else -> changed("TREE_INCOMPLETE")
        }
        private fun nativeNavigationEvidence(node: JSONObject): List<Any> = listOf(
            jsonEvidence(node.opt("nativeCollection")), jsonEvidence(node.opt("nativeCollectionItem")), node.opt("nativeTabRole") ?: false)
        private fun hasNativeNavigationRole(node: JSONObject) = node.optJSONObject("nativeCollection") != null ||
            node.optJSONObject("nativeCollectionItem") != null || node.opt("nativeTabRole") == true
        private fun privateNativeEvidence(node: JSONObject): List<Any> = node.keys().asSequence().filter { it.startsWith("native") }
            .sorted().map { listOf(it, jsonEvidence(node.opt(it))) }.toList()
        private val sensitiveLabel = Regex("付款|支付|下单|提交订单|确认购买|立即购买|删除|清空|转账|发红包|发送|发布|卸载|恢复出厂|重置设备|\\b(pay|purchase|checkout|buy\\s+now|delete|erase|send|submit|publish|uninstall|transfer)\\b", RegexOption.IGNORE_CASE)
        private fun hasClippedLabel(node: JSONObject) = listOf("text", "contentDescription").any { node.getString(it).length >= 1000 }
        /** Native-only evidence. Never return these signatures or unbounded strings through RPC. */
        internal fun nativeStringEvidence(text: String, description: String, resourceId: String, className: String): JSONObject {
            val values = listOf(text, description, resourceId, className)
            val signatures = JSONObject()
            stringLimits.forEachIndexed { index, (key, limit) ->
                if (values[index].length >= limit) signatures.put(key, snapshotFingerprintDigest(listOf(values[index])))
            }
            return JSONObject().put("nativeFieldSignatures", signatures)
                .put("nativeSensitive", sensitiveLabel.containsMatchIn(values.take(3).joinToString(" ").replace('_', ' ')))
        }
        private fun sensitive(node: JSONObject): Boolean {
            val native = if (node.has("nativeSensitive")) node.opt("nativeSensitive") as? Boolean ?: changed("TREE_INCOMPLETE") else false
            return native || sensitiveLabel.containsMatchIn(listOf("text", "contentDescription", "resourceId").joinToString(" ") { node.getString(it) }.replace('_', ' '))
        }
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
