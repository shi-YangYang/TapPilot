@file:Suppress("DEPRECATION")

package dev.tappilot.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** All node access and mutation runs on the main looper. No live node survives a command. */
class AgentAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile var instance: AgentAccessibilityService? = null
            private set
        private val selectorKeys = setOf("text", "textContains", "resourceId", "contentDescription", "className", "clickable", "scrollable", "editable", "enabled")
        private val booleanSelectors = setOf("clickable", "scrollable", "editable", "enabled")
        // Reserve space below 1 MiB for metadata and the RPC envelope (host frame cap: 2 MiB).
        private const val SNAPSHOT_NODE_BYTES = 1024 * 1024 - 8192
    }

    private data class NodeRef(val path: List<Int>, val fingerprint: String, val value: JSONObject)
    private data class Snapshot(val id: String, val revision: Long, val windowId: Int, val packageName: String, val nodes: Map<String, NodeRef>, val truncated: Boolean, val maxNodes: Int, val maxDepth: Int)
    private val main = Handler(Looper.getMainLooper())
    private val changes = Object()
    // Two of the four socket workers remain available for emergency stop and regular commands.
    private val waitSlots = Semaphore(2)
    private var session = UUID.randomUUID().toString()
    private var counter = 0L
    private val snapshots = LinkedHashMap<String, Snapshot>()
    @Volatile private var revision = 0L
    @Volatile private var connected = false
    @Volatile private var stopped = true
    @Volatile var transportStatus: String = "未启动"
        private set
    private var server: RpcServer? = null
    private var activityHint: String? = null
    private var hintPackage: String? = null
    private var commandDeadline = Long.MAX_VALUE
    private var commandAllowed: () -> Boolean = { true }

    override fun onServiceConnected() {
        super.onServiceConnected()
        session = UUID.randomUUID().toString()
        counter = 0L
        activityHint = null
        hintPackage = null
        advanceRevision()
        connected = true
        stopped = getSharedPreferences("safety", MODE_PRIVATE).getBoolean("stopped", true)
        instance = this
        server?.close()
        server = try {
            RpcServer(this).also { it.start(); transportStatus = "ADB localabstract:tappilot" }
        } catch (_: Exception) {
            transportStatus = "启动失败，请关闭并重新开启无障碍服务"
            null
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            activityHint = event.className?.toString()
            hintPackage = event.packageName?.toString()
        }
        // Content notifications can arrive even when the accessible tree is unchanged.
        // Keep bounded snapshots for full-tree revalidation; window changes still invalidate.
        advanceRevision(invalidateSnapshots = event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
            event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED)
    }

    override fun onInterrupt() { stopAutomation() }

    private fun disconnect() {
        connected = false
        AgentTaskService.cancelActive("无障碍服务已断开")
        if (instance === this) instance = null
        advanceRevision()
        server?.close()
        server = null
        transportStatus = "已断开"
    }

    override fun onUnbind(intent: Intent?): Boolean {
        disconnect()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        disconnect()
        super.onDestroy()
    }

    internal fun stopAutomation() {
        stopped = true
        AgentTaskService.cancelActive("已紧急停止")
        getSharedPreferences("safety", MODE_PRIVATE).edit().putBoolean("stopped", true).commit()
        advanceRevision()
    }

    internal fun resumeLocally() {
        // Only called by MainActivity; no transport method or exported intent can resume.
        stopped = false
        advanceRevision()
    }

    private fun advanceRevision(invalidateSnapshots: Boolean = true) {
        synchronized(changes) { revision++; changes.notifyAll() }
        if (invalidateSnapshots) snapshots.clear()
    }

    internal fun dispatch(method: String, params: JSONObject, canContinue: () -> Boolean = { true }): JSONObject {
        if (!canContinue()) throw AgentError("CANCELLED", "任务已停止")
        if (method == "act_and_observe") {
            if (!waitSlots.tryAcquire()) throw AgentError("BUSY", "At most two concurrent UI waits are supported", true)
            try { return actAndObserve(params, canContinue) } finally { waitSlots.release() }
        }
        // Latch immediately on the socket worker, before any already-queued main-loop action.
        if (method == "emergency_stop") {
            stopped = true
            synchronized(changes) { changes.notifyAll() }
        }
        if (method == "wait_for_ui_change") {
            if (!waitSlots.tryAcquire()) throw AgentError("BUSY", "At most two concurrent UI waits are supported", true)
            try { return waitForChange(params, canContinue) } finally { waitSlots.release() }
        }
        return onMain {
            if (!connected) throw AgentError("SERVICE_UNAVAILABLE", "Accessibility service is disconnected", true)
            if (!canContinue()) throw AgentError("CANCELLED", "任务已停止")
            commandAllowed = canContinue
            try { when (method) {
                "get_device_info" -> JSONObject()
                    .put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
                    .put("sdkInt", Build.VERSION.SDK_INT).put("androidVersion", Build.VERSION.RELEASE)
                    .put("serviceConnected", connected).put("stopped", stopped).put("revision", revision)
                    .put("locked", isLocked()).put("transport", "adb-localabstract")
                    .put("protocolVersion", 1).put("sessionId", session)
                "emergency_stop" -> { stopAutomation(); JSONObject().put("stopped", true).put("revision", revision) }
                "get_current_app" -> currentApp()
                "get_ui_tree" -> { assertReady(); snapshotJson(capture(intParam(params, "maxNodes", 300, 1, 500), intParam(params, "maxDepth", 20, 1, 40))) }
                "find_element" -> {
                    assertReady()
                    val selector = requiredSelector(params)
                    find(selector, intParam(params, "maxResults", 20, 1, 100))
                }
                "click_element" -> click(params)
                "input_text" -> input(params)
                "scroll" -> scroll(params)
                "swipe" -> swipe(params)
                "press_key" -> pressKey(params)
                "open_settings" -> {
                    assertReady()
                    startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    accepted("open_settings")
                }
                else -> throw AgentError("UNKNOWN_METHOD", "Unsupported method")
            } } finally { commandAllowed = { true } }
        }
    }

    private fun actAndObserve(params: JSONObject, canContinue: () -> Boolean): JSONObject {
        ToolCatalog.validate("act_and_observe", params)
        if (Looper.myLooper() == Looper.getMainLooper()) throw AgentError("INVALID_THREAD", "Combined observation must run on a worker")
        val started = SystemClock.elapsedRealtime()
        val action = dispatch(params.getString("action"), params.getJSONObject("arguments"), canContinue)
        val acted = SystemClock.elapsedRealtime()
        val result = JSONObject().put("action", action)
        var waited = acted
        try {
            val waitMs = params.optInt("waitMs", 350)
            // The action's synthetic revision is already included; wait for a subsequent event.
            if (waitMs > 0) waitForChange(JSONObject().put("sinceRevision", action.getLong("revision")).put("timeoutMs", waitMs), canContinue)
            waited = SystemClock.elapsedRealtime()
            result.put("observation", dispatch("get_ui_tree", JSONObject().put("maxNodes", 300).put("maxDepth", 20), canContinue))
        } catch (error: AgentError) {
            result.put("observation", JSONObject.NULL).put("observationError", JSONObject().put("code", error.code)
                .put("message", error.message).put("retryable", error.retryable))
        }
        val ended = SystemClock.elapsedRealtime()
        return result.put("timings", JSONObject().put("actionMs", acted - started).put("waitMs", waited - acted)
            .put("observationMs", ended - waited).put("totalMs", ended - started))
    }

    private fun <T> onMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val deadline = SystemClock.elapsedRealtime() + 8_000
        val task = FutureTask {
            commandDeadline = deadline
            try { checkDeadline(); block() } finally { commandDeadline = Long.MAX_VALUE }
        }
        main.post(task)
        try {
            return task.get(8, TimeUnit.SECONDS)
        } catch (_: TimeoutException) {
            // FutureTask.run() is a no-op after cancellation: timed-out queued actions never execute.
            task.cancel(false)
            main.removeCallbacks(task)
            throw AgentError("COMMAND_TIMEOUT", "Command timed out; an action already dispatched to Android may have executed. Read the UI before retrying.", false)
        } catch (error: ExecutionException) {
            val cause = error.cause
            if (cause is AgentError) throw cause
            throw AgentError("ANDROID_ERROR", "Android rejected the operation; inspect the current UI", false)
        } catch (_: InterruptedException) {
            task.cancel(false)
            main.removeCallbacks(task)
            Thread.currentThread().interrupt()
            throw AgentError("SERVICE_UNAVAILABLE", "Command cancelled because the connection service stopped", true)
        }
    }

    private fun isLocked(): Boolean = getSystemService(KeyguardManager::class.java).isKeyguardLocked

    private fun assertReady() {
        if (!commandAllowed()) throw AgentError("CANCELLED", "任务已停止")
        checkDeadline()
        if (!connected) throw AgentError("SERVICE_UNAVAILABLE", "Accessibility service is disconnected", true)
        if (stopped) throw AgentError("EMERGENCY_STOPPED", "Automation is stopped. Resume manually in the TapPilot phone app.")
        assertUnlocked()
    }

    private fun checkDeadline() {
        if (SystemClock.elapsedRealtime() >= commandDeadline) throw AgentError("COMMAND_TIMEOUT", "Command expired before dispatch. Read the UI again before retrying.")
    }

    private fun assertUnlocked() {
        if (isLocked()) throw AgentError("DEVICE_LOCKED", "Unlock the phone manually; lock-screen automation is not supported")
    }

    private fun root(allowOwnApp: Boolean = false): AccessibilityNodeInfo {
        assertUnlocked()
        val node = rootInActiveWindow ?: throw AgentError("NO_ACTIVE_WINDOW", "No accessible active window. Unlock the device or open an accessible app.", true)
        if (!allowOwnApp && node.packageName?.toString() == packageName) {
            node.recycle()
            throw AgentError("PROTECTED_APP", "TapPilot's safety controls cannot be read or operated remotely. Use open_settings or navigate manually.")
        }
        return node
    }

    private fun currentApp(): JSONObject {
        val root = root(allowOwnApp = true)
        return try {
            val pkg = root.packageName?.toString().orEmpty()
            JSONObject().put("packageName", pkg.take(512)).put("windowId", root.windowId)
                .put("activityHint", if (pkg == hintPackage) activityHint?.take(512) ?: JSONObject.NULL else JSONObject.NULL)
                .put("activityHintIsAuthoritative", false).put("revision", revision).put("stopped", stopped)
        } finally { root.recycle() }
    }

    private fun nodeJson(node: AccessibilityNodeInfo, nodeId: String, parentId: String?): JSONObject {
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        val password = node.isPassword
        return JSONObject().put("nodeId", nodeId).put("parentId", parentId ?: JSONObject.NULL)
            .put("text", if (password) "[REDACTED]" else node.text?.toString()?.take(1000) ?: "")
            .put("contentDescription", if (password) "[REDACTED]" else node.contentDescription?.toString()?.take(1000) ?: "")
            .put("resourceId", node.viewIdResourceName?.take(512) ?: "").put("className", node.className?.toString()?.take(512) ?: "")
            .put("bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)))
            .put("clickable", node.isClickable).put("scrollable", node.isScrollable)
            .put("editable", node.isEditable).put("enabled", node.isEnabled).put("password", password)
            .put("visible", node.isVisibleToUser)
    }

    private fun fingerprint(node: AccessibilityNodeInfo): String {
        // Hash full text in memory without retaining or logging it; returned UI text is capped separately.
        val rect = Rect().also { node.getBoundsInScreen(it) }
        val value = listOf(node.packageName, node.className, node.viewIdResourceName,
            if (node.isPassword) "[REDACTED]" else node.text,
            if (node.isPassword) "[REDACTED]" else node.contentDescription,
            rect.toShortString(), node.isClickable, node.isScrollable, node.isEditable,
            node.isEnabled, node.isPassword, node.isVisibleToUser, node.childCount,
            node.isCheckable, node.isChecked, node.isSelected, node.isFocused).joinToString("\u0000")
        return MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    private fun capture(maxNodes: Int = 300, maxDepth: Int = 20, retain: Boolean = true): Snapshot {
        val root = root()
        try {
            val refs = LinkedHashMap<String, NodeRef>()
            var truncated = false
            var visited = 0
            var serializedNodeBytes = 2 // JSON array brackets.
            var byteBudgetExhausted = false
            fun visit(node: AccessibilityNodeInfo, path: List<Int>, parentId: String?, depth: Int) {
                checkDeadline()
                if (byteBudgetExhausted || refs.size >= maxNodes || visited >= maxNodes * 4) { truncated = true; return }
                visited++
                var nextParent = parentId
                if (path.isEmpty() || node.isVisibleToUser) {
                    val id = "n${refs.size}"
                    val value = nodeJson(node, id, parentId)
                    val nodeBytes = value.toString().toByteArray(Charsets.UTF_8).size + if (refs.isEmpty()) 0 else 1
                    if (serializedNodeBytes + nodeBytes > SNAPSHOT_NODE_BYTES) {
                        byteBudgetExhausted = true
                        truncated = true
                        return
                    }
                    checkDeadline()
                    refs[id] = NodeRef(path, fingerprint(node), value)
                    serializedNodeBytes += nodeBytes
                    nextParent = id
                }
                if (depth >= maxDepth) { if (node.childCount > 0) truncated = true; return }
                for (index in 0 until node.childCount) {
                    if (byteBudgetExhausted || refs.size >= maxNodes || visited >= maxNodes * 4) { truncated = true; break }
                    val child = node.getChild(index) ?: continue
                    try { visit(child, path + index, nextParent, depth + 1) } finally { child.recycle() }
                }
            }
            visit(root, emptyList(), null, 0)
            val snapshot = Snapshot("$session:${++counter}", revision, root.windowId, root.packageName?.toString().orEmpty(), refs, truncated, maxNodes, maxDepth)
            if (retain) {
                snapshots[snapshot.id] = snapshot
                while (snapshots.size > 4) snapshots.remove(snapshots.keys.first())
            }
            return snapshot
        } finally { root.recycle() }
    }

    private fun snapshotJson(snapshot: Snapshot): JSONObject = JSONObject()
        .put("snapshotId", snapshot.id).put("revision", snapshot.revision)
        .put("packageName", snapshot.packageName.take(512)).put("windowId", snapshot.windowId)
        .put("nodes", JSONArray(snapshot.nodes.values.map { it.value })).put("truncated", snapshot.truncated)

    private fun requiredSelector(params: JSONObject): JSONObject =
        (params.opt("selector") as? JSONObject ?: throw AgentError("INVALID_ARGUMENT", "selector must be an object")).also(::validateSelector)

    private fun validateSelector(selector: JSONObject) {
        if (selector.length() == 0) throw AgentError("INVALID_ARGUMENT", "selector must include at least one supported condition")
        selector.keys().forEach { key ->
            if (key !in selectorKeys) throw AgentError("INVALID_ARGUMENT", "Unsupported selector property: $key")
            val value = selector.opt(key)
            if (key in booleanSelectors) {
                if (value !is Boolean) throw AgentError("INVALID_ARGUMENT", "$key must be a boolean")
            } else if (value !is String || value.length > 1000) throw AgentError("INVALID_ARGUMENT", "$key must be a string of at most 1000 characters")
        }
    }

    private fun matches(node: JSONObject, selector: JSONObject): Boolean = selector.keys().asSequence().all { key ->
        when (key) {
            "textContains" -> node.getString("text").contains(selector.getString(key))
            else -> node.opt(key) == selector.opt(key)
        }
    }

    private fun find(selector: JSONObject, maxResults: Int): JSONObject {
        val snapshot = capture(500, 40)
        val matches = snapshot.nodes.values.filter { matches(it.value, selector) }
        return JSONObject().put("snapshotId", snapshot.id).put("revision", snapshot.revision)
            .put("packageName", snapshot.packageName.take(512)).put("windowId", snapshot.windowId)
            .put("elements", JSONArray(matches.take(maxResults).map { it.value }))
            .put("truncated", snapshot.truncated || matches.size > maxResults)
    }

    private fun resolve(params: JSONObject): Triple<Snapshot, NodeRef, AccessibilityNodeInfo> {
        assertReady()
        val snapshotId = stringParam(params, "snapshotId", 128)
        val nodeId = stringParam(params, "nodeId", 64)
        val snapshot = snapshots[snapshotId] ?: throw stale()
        if (snapshot.revision != revision) verifyUnchangedTree(snapshot)
        val ref = snapshot.nodes[nodeId] ?: throw AgentError("NODE_NOT_FOUND", "nodeId does not belong to this snapshot")
        var node = root()
        try {
            if (node.windowId != snapshot.windowId || node.packageName?.toString() != snapshot.packageName) throw stale()
            for (index in ref.path) {
                val next = node.getChild(index) ?: throw stale()
                node.recycle()
                node = next
            }
            if (!node.refresh() || fingerprint(node) != ref.fingerprint) throw stale()
            if (node.packageName?.toString() == packageName || node.packageName?.toString() != snapshot.packageName) throw AgentError("PROTECTED_APP", "Nodes outside the current foreground app cannot be operated")
            if (!node.isVisibleToUser) throw AgentError("NODE_NOT_VISIBLE", "Node is not currently visible")
            if (!node.isEnabled) throw AgentError("NODE_DISABLED", "Node is disabled")
            if (node.isPassword) throw AgentError("SENSITIVE_FIELD", "Password fields cannot be operated")
            return Triple(snapshot, ref, node)
        } catch (error: Exception) { node.recycle(); throw error }
    }

    private fun stale(): AgentError = AgentError("STALE_SNAPSHOT", "The UI changed or the snapshot expired. Read the UI again before acting.", true)

    /** An event alone is not proof of changed UI, but a changed or incomplete tree is. */
    private fun verifyUnchangedTree(snapshot: Snapshot) {
        if (snapshot.truncated) throw stale()
        val fresh = capture(snapshot.maxNodes, snapshot.maxDepth, retain = false)
        if (fresh.windowId != snapshot.windowId || fresh.packageName != snapshot.packageName || fresh.truncated ||
            fresh.nodes.size != snapshot.nodes.size || snapshot.nodes.any { (id, ref) ->
                val actual = fresh.nodes[id]
                actual == null || ref.path != actual.path || ref.fingerprint != actual.fingerprint
            }) throw stale()
    }

    private fun click(params: JSONObject): JSONObject {
        val (snapshot, ref, target) = resolve(params)
        var acted = target
        var path = ref.path
        var ancestorHops = 0
        try {
            while (!acted.isClickable && ancestorHops < 8 && path.isNotEmpty()) {
                val parent = acted.parent ?: break
                if (acted !== target) acted.recycle()
                acted = parent
                path = path.dropLast(1)
                ancestorHops++
            }
            if (!acted.isClickable) throw AgentError("NOT_CLICKABLE", "Neither this node nor its first eight ancestors is clickable; no coordinate fallback was attempted")
            if (!acted.isEnabled || !acted.isVisibleToUser || acted.isPassword || acted.packageName?.toString() != snapshot.packageName) {
                throw AgentError("NODE_NOT_ACTIONABLE", "The clickable ancestor is disabled, hidden, sensitive, or belongs to another app")
            }
            val actedEntry = snapshot.nodes.entries.firstOrNull { it.value.path == path }
                ?: throw AgentError("NODE_NOT_ACTIONABLE", "Clickable ancestor was not included in the snapshot; read a deeper tree before acting")
            if (!acted.refresh() || fingerprint(acted) != actedEntry.value.fingerprint) throw stale()
            val actedValue = nodeJson(acted, actedEntry.key, null)
            assertReady()
            if (!acted.performAction(AccessibilityNodeInfo.ACTION_CLICK)) throw AgentError("ACTION_REJECTED", "Android or the app rejected ACTION_CLICK; inspect the UI before retrying")
            return accepted("click").put("target", ref.value).put("actedNode", actedValue).put("ancestorHops", ancestorHops)
        } finally {
            if (acted !== target) acted.recycle()
            target.recycle()
        }
    }

    private fun input(params: JSONObject): JSONObject {
        val text = stringParam(params, "text", 16_384, allowEmpty = true)
        val (_, _, node) = resolve(params)
        try {
            if (!node.isEditable) throw AgentError("NOT_EDITABLE", "Node is not an editable field")
            val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
            assertReady()
            if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw AgentError("ACTION_REJECTED", "App rejected ACTION_SET_TEXT; custom editors may not support native text input")
            return accepted("set_text")
        } finally { node.recycle() }
    }

    private fun scroll(params: JSONObject): JSONObject {
        val direction = stringParam(params, "direction", 16)
        val action = when (direction) {
            "forward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            "backward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            "up" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id
            "down" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id
            "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id
            "right" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id
            else -> throw AgentError("INVALID_ARGUMENT", "direction must be forward/backward/up/down/left/right")
        }
        val (_, _, node) = resolve(params)
        try {
            if (!node.isScrollable) throw AgentError("NOT_SCROLLABLE", "Selected node is not scrollable; select a scrollable container from the tree")
            assertReady()
            if (!node.performAction(action)) throw AgentError("ACTION_REJECTED", "Scroll was rejected or the container reached its boundary")
            return accepted("scroll").put("direction", direction)
        } finally { node.recycle() }
    }

    private fun swipe(params: JSONObject): JSONObject {
        assertReady()
        val snapshotId = stringParam(params, "snapshotId", 128)
        val snapshot = snapshots[snapshotId] ?: throw stale()
        if (snapshot.truncated) throw AgentError("TRUNCATED_SNAPSHOT", "Coordinate gestures require a complete snapshot. Read with larger maxNodes/maxDepth, or use native scroll.")
        verifyUnchangedTree(snapshot)
        val metrics = resources.displayMetrics
        val sx = intParam(params, "startX", null, 0, metrics.widthPixels - 1)
        val sy = intParam(params, "startY", null, 0, metrics.heightPixels - 1)
        val ex = intParam(params, "endX", null, 0, metrics.widthPixels - 1)
        val ey = intParam(params, "endY", null, 0, metrics.heightPixels - 1)
        val duration = intParam(params, "durationMs", 350, 50, 2000)
        val path = Path().apply { moveTo(sx.toFloat(), sy.toFloat()); lineTo(ex.toFloat(), ey.toFloat()) }
        val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, duration.toLong())).build()
        val callback = object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) { advanceRevision() }
            override fun onCancelled(gestureDescription: GestureDescription?) { advanceRevision() }
        }
        assertReady()
        if (!dispatchGesture(gesture, callback, main)) throw AgentError("ACTION_REJECTED", "Android rejected the gesture")
        return accepted("swipe").put("completion", "pending").put("durationMs", duration)
    }

    private fun pressKey(params: JSONObject): JSONObject {
        assertReady()
        val root = root()
        root.recycle()
        val key = stringParam(params, "key", 16)
        val action = when (key) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            else -> throw AgentError("INVALID_ARGUMENT", "key must be back/home/recents")
        }
        assertReady()
        if (!performGlobalAction(action)) throw AgentError("ACTION_REJECTED", "Android rejected the global action")
        return accepted(key)
    }

    private fun accepted(action: String): JSONObject {
        advanceRevision()
        return JSONObject().put("accepted", true).put("action", action).put("revision", revision)
            .put("verificationRequired", true)
    }

    private fun waitForChange(params: JSONObject, canContinue: () -> Boolean = { true }): JSONObject {
        val sinceValue = params.opt("sinceRevision")
        if (sinceValue !is Number || sinceValue.toDouble() % 1.0 != 0.0 || sinceValue.toLong() < 0) throw AgentError("INVALID_ARGUMENT", "sinceRevision must be a nonnegative integer")
        val since = sinceValue.toLong()
        val timeout = intParam(params, "timeoutMs", 10_000, 0, 25_000)
        val selector = if (params.has("selector")) requiredSelector(params) else null
        val deadline = SystemClock.elapsedRealtime() + timeout
        while (true) {
            if (!canContinue()) throw AgentError("CANCELLED", "任务已停止")
            val beforeRead = revision
            val current = onMain {
                assertReady()
                if (since > revision) throw AgentError("INVALID_ARGUMENT", "sinceRevision is from another service session or is in the future")
                if (selector != null) find(selector, 20) else JSONObject().put("revision", revision)
            }
            val observed = current.getLong("revision")
            val matched = selector != null && current.getJSONArray("elements").length() > 0
            val changed = observed != since
            if (matched || (selector == null && changed)) {
                return current.put("changed", changed).put("timedOut", false).put("matched", matched)
            }
            val remaining = deadline - SystemClock.elapsedRealtime()
            if (remaining <= 0) return current.put("changed", changed).put("timedOut", true).put("matched", false)
            synchronized(changes) {
                // Recheck after inspecting the tree so an event between read and wait cannot be lost.
                if (revision == beforeRead && connected && !stopped) {
                    try { changes.wait(remaining) } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                        throw AgentError("SERVICE_UNAVAILABLE", "Wait cancelled because the service stopped", true)
                    }
                }
            }
        }
    }

    private fun stringParam(params: JSONObject, key: String, max: Int, allowEmpty: Boolean = false): String {
        val value = params.opt(key)
        if (value !is String || value.length > max || (!allowEmpty && value.isEmpty())) throw AgentError("INVALID_ARGUMENT", "$key must be ${if (allowEmpty) "a" else "a non-empty"} string of at most $max characters")
        return value
    }

    private fun intParam(params: JSONObject, key: String, default: Int?, min: Int, max: Int): Int {
        val value = params.opt(key) ?: return default ?: throw AgentError("INVALID_ARGUMENT", "$key is required")
        if (value !is Number || value.toDouble() % 1.0 != 0.0 || value.toLong() !in min.toLong()..max.toLong()) throw AgentError("INVALID_ARGUMENT", "$key must be an integer from $min to $max")
        return value.toInt()
    }
}
