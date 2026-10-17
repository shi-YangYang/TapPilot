@file:Suppress("DEPRECATION")

package dev.tappilot.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.Intent
import android.content.Context
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
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
        private val safetyLock = Any()
        /** An authenticated stop is durable independently of transport lifetime or main-loop cancellation. */
        internal fun latchEmergencyStop(context: Context) {
            val (service, persisted) = synchronized(safetyLock) {
                instance?.stopped = true
                val written = runCatching { context.getSharedPreferences("safety", Context.MODE_PRIVATE)
                    .edit().putBoolean("stopped", true).commit() }.getOrDefault(false)
                instance to written
            }
            service?.let { current -> synchronized(current.changes) { current.changes.notifyAll() } }
            val cleanup = { service?.advanceRevision(); Unit }
            if (Looper.myLooper() == Looper.getMainLooper()) cleanup() else (service?.main ?: Handler(Looper.getMainLooper())).post(cleanup)
            if (!persisted) throw AgentError("STOP_PERSISTENCE_FAILED", "已停止当前自动化，但无法持久保存急停状态；请在手机确认，暂勿重启服务")
        }
        private val selectorKeys = setOf("text", "textContains", "resourceId", "contentDescription", "className", "clickable", "scrollable", "editable", "enabled")
        private val booleanSelectors = setOf("clickable", "scrollable", "editable", "enabled")
        // Reserve space below 1 MiB for metadata and the RPC envelope (host frame cap: 2 MiB).
        private const val SNAPSHOT_NODE_BYTES = 1024 * 1024 - 8192
    }

    private data class NativeContext(val isProtected: Boolean, val signature: String)
    private data class NodeRef(val path: List<Int>, val fingerprint: SnapshotNodeFingerprint, val value: JSONObject, val contextSignature: String)
    private data class Snapshot(val id: String, val revision: Long, val windowId: Int, val packageName: String, val nodes: Map<String, NodeRef>, val truncated: Boolean, val maxNodes: Int, val maxDepth: Int, val windowTopology: Long, val missingChild: Boolean, val capacityTruncated: Boolean)
    private val main = Handler(Looper.getMainLooper())
    private val changes = Object()
    // Two of the four socket workers remain available for emergency stop and regular commands.
    private val waitSlots = Semaphore(2)
    private var session = UUID.randomUUID().toString()
    private var counter = 0L
    private var windowTopology = 0L
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
    private var commandMutationSent = false
    private var commandObservation: JSONObject? = null
    private var commandLabelAllowanceCount = 0

    override fun onServiceConnected() {
        super.onServiceConnected()
        session = UUID.randomUUID().toString()
        counter = 0L
        activityHint = null
        hintPackage = null
        advanceRevision()
        connected = true
        synchronized(safetyLock) {
            stopped = getSharedPreferences("safety", MODE_PRIVATE).getBoolean("stopped", true)
            instance = this
        }
        server?.close()
        server = null
        server = try {
            RpcServer(this, onFailure = { failed, code ->
                main.post {
                    if (server === failed) transportStatus = "ADB 连接异常（$code），请重新开启无障碍服务"
                }
            }).also { it.start(); transportStatus = "ADB localabstract:tappilot" }
        } catch (error: Exception) {
            // This exception is from local socket construction/start, never UI or model content.
            Log.w("TapPilot.Rpc", "RPC_START_FAILED", error)
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
        // Keep bounded node evidence across delayed events: each node action captures,
        // rebinds and checks current windows. Raw coordinate references retain a strict
        // topology epoch, because a new overlay need not alter the active app's tree.
        if (event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) windowTopology++
        advanceRevision(invalidateSnapshots = false)
    }

    override fun onInterrupt() { runCatching { stopAutomation() } }

    private fun disconnect() {
        connected = false
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
        latchEmergencyStop(this)
    }

    internal fun resumeLocally() {
        // Only called by MainActivity; no transport method or exported intent can resume.
        synchronized(safetyLock) {
            val preferences = getSharedPreferences("safety", MODE_PRIVATE)
            if (!preferences.edit().putBoolean("stopped", false).commit()) {
                // commit can update the in-process preference cache even when the disk write fails.
                preferences.edit().putBoolean("stopped", true).apply()
                stopped = true
                throw AgentError("RESUME_PERSISTENCE_FAILED", "无法保存恢复状态，自动化仍保持停止")
            }
            stopped = false
        }
        advanceRevision()
    }

    private fun advanceRevision(invalidateSnapshots: Boolean = true) {
        synchronized(changes) { revision++; changes.notifyAll() }
        if (invalidateSnapshots) snapshots.clear()
    }

    internal fun dispatch(method: String, params: JSONObject, canContinue: () -> Boolean = { true }): JSONObject {
        if (method == "emergency_stop") {
            stopAutomation()
            return JSONObject().put("stopped", true).put("revision", revision)
        }
        if (!canContinue()) throw AgentError("CANCELLED", "任务已停止")
        if (method == "act_and_observe") {
            if (!waitSlots.tryAcquire()) throw AgentError("BUSY", "At most two concurrent UI waits are supported", true)
            try { return actAndObserve(params, canContinue) } finally { waitSlots.release() }
        }
        if (method == "wait_for_ui_change") {
            if (!waitSlots.tryAcquire()) throw AgentError("BUSY", "At most two concurrent UI waits are supported", true)
            try { return waitForChange(params, canContinue) } finally { waitSlots.release() }
        }
        return executeOnMain(method, params, canContinue)
    }

    private fun executeOnMain(method: String, params: JSONObject, canContinue: () -> Boolean, deadline: Long = Long.MAX_VALUE, gestureCompletion: GestureCompletion? = null): JSONObject =
        onMain(deadline) {
            if (!connected) throw AgentError("SERVICE_UNAVAILABLE", "Accessibility service is disconnected", true)
            if (!canContinue()) throw AgentError("CANCELLED", "任务已停止")
            commandAllowed = canContinue
            commandMutationSent = false
            commandObservation = null
            commandLabelAllowanceCount = 0
            try { when (method) {
                "get_device_info" -> JSONObject()
                    .put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
                    .put("sdkInt", Build.VERSION.SDK_INT).put("androidVersion", Build.VERSION.RELEASE)
                    .put("serviceConnected", connected).put("stopped", stopped).put("revision", revision)
                    .put("locked", isLocked()).put("transport", "adb-localabstract")
                    .put("protocolVersion", 1).put("sessionId", session).put("executor", NodeActionGuard.EXECUTOR)
                "get_current_app" -> currentApp()
                "get_ui_tree" -> { assertReady(); snapshotJson(capture(intParam(params, "maxNodes", 300, 1, 500), intParam(params, "maxDepth", 20, 1, 40))) }
                "find_element" -> {
                    assertReady()
                    val selector = requiredSelector(params)
                    find(selector, intParam(params, "maxResults", 20, 1, 100))
                }
                "tap_element" -> tap(params, gestureCompletion)
                "click_element" -> click(params)
                "input_text" -> input(params)
                "scroll" -> scroll(params)
                "swipe" -> swipe(params, gestureCompletion)
                "press_key" -> pressKey(params)
                "open_settings" -> {
                    assertReady()
                    startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    accepted("open_settings")
                }
                else -> throw AgentError("UNKNOWN_METHOD", "Unsupported method")
            } } catch (error: AgentError) {
                if (method in setOf("tap_element", "click_element", "input_text", "scroll", "swipe") && !commandMutationSent) {
                    error.nativeNotSent = true
                    error.nativeObservation = commandObservation
                }
                throw error
            } finally { commandAllowed = { true }; commandObservation = null }
        }

    private fun actAndObserve(params: JSONObject, canContinue: () -> Boolean): JSONObject {
        ToolCatalog.validate("act_and_observe", params)
        if (Looper.myLooper() == Looper.getMainLooper()) throw AgentError("INVALID_THREAD", "Combined observation must run on a worker")
        val started = SystemClock.elapsedRealtime()
        // Leave transport time within the host's 10s RPC timeout. Every main-looper
        // command in this operation also respects this shared absolute deadline.
        val deadline = started + 9_000
        val operationSession = session
        val operationAllowed = { canContinue() && session == operationSession }
        val actionName = params.getString("action")
        val gesture = if (actionName == "swipe" || actionName == "tap_element") GestureCompletion() else null
        val action = executeOnMain(actionName, params.getJSONObject("arguments"), operationAllowed, deadline, gesture)
        val acted = SystemClock.elapsedRealtime()
        val result = JSONObject().put("action", action)
        var observationMs = 0L
        try {
            val waitMs = params.optInt("waitMs", 350)
            val waiter = ActionObservationWaiter(SystemClock::elapsedRealtime, { revision }, {
                assertObservationActive(canContinue)
                if (session != operationSession) throw AgentError("SERVICE_UNAVAILABLE", "Accessibility service session changed after the action", true)
                if (SystemClock.elapsedRealtime() >= deadline) throw when (gesture?.state) {
                    GestureCompletion.State.PENDING -> AgentError("GESTURE_COMPLETION_TIMEOUT", "The gesture was accepted but Android did not report completion before the operation deadline. Its effect is unknown; no action was repeated.")
                    GestureCompletion.State.CANCELLED -> AgentError("GESTURE_CANCELLED", "Android cancelled the accepted gesture. No action was repeated; inspect the current UI.")
                    else -> AgentError("COMMAND_TIMEOUT", "The action was accepted, but observation exceeded its deadline. Read the UI before deciding what to do next.")
                }
            }, ::waitForObservationSignal)
            val observation = waiter.observeAfterAction(action.getLong("revision"), waitMs, deadline, gesture,
                acted + action.optInt("durationMs", 0) + 750L) {
                val readStarted = SystemClock.elapsedRealtime()
                try {
                    executeOnMain("get_ui_tree", JSONObject().put("maxNodes", 300).put("maxDepth", 20), operationAllowed, deadline)
                } finally { observationMs += SystemClock.elapsedRealtime() - readStarted }
            }
            result.put("observation", observation)
        } catch (error: AgentError) {
            result.put("observation", JSONObject.NULL).put("observationError", error.toJson())
        }
        if (gesture != null) action.put("completion", when (gesture.state) {
            GestureCompletion.State.COMPLETED -> "completed"
            GestureCompletion.State.CANCELLED -> "cancelled"
            GestureCompletion.State.PENDING -> "unknown"
        })
        val ended = SystemClock.elapsedRealtime()
        return result.put("timings", JSONObject().put("actionMs", acted - started).put("waitMs", ended - acted - observationMs)
            .put("observationMs", observationMs).put("totalMs", ended - started))
    }

    private fun <T> onMain(operationDeadline: Long = Long.MAX_VALUE, block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val deadline = minOf(SystemClock.elapsedRealtime() + 8_000, operationDeadline)
        val remaining = deadline - SystemClock.elapsedRealtime()
        if (remaining <= 0) throw AgentError("COMMAND_TIMEOUT", "Command expired before dispatch. Read the UI again before retrying.")
        val task = FutureTask {
            commandDeadline = deadline
            try { checkDeadline(); block() } finally { commandDeadline = Long.MAX_VALUE }
        }
        main.post(task)
        try {
            return task.get(remaining, TimeUnit.MILLISECONDS)
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
            .put("checkable", node.isCheckable).put("checked", node.isChecked)
            .put("selected", node.isSelected).put("focused", node.isFocused)
            .put("visible", node.isVisibleToUser)
    }

    /** Keep native semantic content/association evidence private and in memory.
     * A protected bit alone cannot distinguish a pane or associated label that
     * changed meaning while retaining the same semantic role.
     */
    private fun nativeContext(node: AccessibilityNodeInfo): NativeContext {
        fun relationship(related: AccessibilityNodeInfo?): String? {
            if (related == null) return null
            try {
                checkDeadline()
                val password = related.isPassword
                val fields = listOf(related.windowId, related.hashCode(), related.packageName?.toString(),
                    related.className?.toString(), related.viewIdResourceName, password,
                    if (password) "[REDACTED]" else related.text?.toString(),
                    if (password) "[REDACTED]" else related.contentDescription?.toString(),
                    Build.VERSION.SDK_INT >= 28 && related.isHeading,
                    if (password) "[REDACTED]" else if (Build.VERSION.SDK_INT >= 28) related.paneTitle?.toString() else null)
                // JSON preserves field boundaries even when app text contains NUL.
                return snapshotFingerprintDigest(listOf(JSONArray(fields).toString()))
            } finally { related.recycle() }
        }
        val heading = Build.VERSION.SDK_INT >= 28 && node.isHeading
        val paneTitle = if (Build.VERSION.SDK_INT >= 28) node.paneTitle?.toString() else null
        checkDeadline()
        val labelFor = relationship(node.labelFor)
        checkDeadline()
        val labeledBy = relationship(node.labeledBy)
        val isProtected = node.isPassword || heading || !paneTitle.isNullOrEmpty() || labelFor != null || labeledBy != null
        val signature = if (!isProtected) "" else snapshotFingerprintDigest(listOf(JSONArray(listOf(heading,
            if (node.isPassword) "[REDACTED]" else paneTitle, labelFor, labeledBy)).toString()))
        return NativeContext(isProtected, signature)
    }

    private fun fingerprint(node: AccessibilityNodeInfo, context: NativeContext = nativeContext(node)): SnapshotNodeFingerprint {
        // Hash full text in memory without retaining or logging it; returned UI text is capped separately.
        val rect = Rect().also { node.getBoundsInScreen(it) }
        val flags = listOf(node.isClickable, node.isScrollable, node.isEditable, node.isEnabled, node.isPassword,
            node.isVisibleToUser, node.isCheckable, node.isChecked, node.isSelected, node.isFocused, context.isProtected)
        val childCount = node.childCount
        val fields = listOf(node.packageName, node.className, node.viewIdResourceName,
            if (flags[4]) "[REDACTED]" else node.text,
            if (flags[4]) "[REDACTED]" else node.contentDescription,
            rect.toShortString(), context.signature) + flags.take(6) + childCount + flags.drop(6)
        val stateBits = flags.withIndex().fold(0) { bits, (index, enabled) -> if (enabled) bits or (1 shl index) else bits }
        return SnapshotNodeFingerprint(snapshotFingerprintDigest(fields), listOf(rect.left, rect.top, rect.right, rect.bottom), stateBits, childCount)
    }

    private fun capture(maxNodes: Int = 300, maxDepth: Int = 20, retain: Boolean = true, refreshNodes: Boolean = false): Snapshot {
        // Accessibility may return a complete but obsolete cached tree before
        // its content-change event is delivered. Missing-child recovery alone
        // cannot detect that case. Every observation/dispatch validation must
        // start with fresh native evidence, never authorize from that cache.
        val cleared = Build.VERSION.SDK_INT >= 33 && clearCache()
        val refreshEveryNode = refreshNodes || !cleared
        val root = root()
        try {
            val refs = LinkedHashMap<String, NodeRef>()
            var truncated = false
            var missingChild = false
            var capacityTruncated = false
            var visited = 0
            var serializedNodeBytes = 2 // JSON array brackets.
            var byteBudgetExhausted = false
            fun visit(node: AccessibilityNodeInfo, path: List<Int>, parentId: String?, depth: Int) {
                checkDeadline()
                if (byteBudgetExhausted || refs.size >= maxNodes || visited >= maxNodes * 4) { truncated = true; capacityTruncated = true; return }
                visited++
                // Older Android versions have no public service cache-clear API.
                // Refresh each parent before its child list is inspected when
                // cache invalidation is unavailable. Failed refresh is missing evidence.
                if (refreshEveryNode && !node.refresh()) { truncated = true; missingChild = true; return }
                var nextParent = parentId
                if (path.isEmpty() || node.isVisibleToUser) {
                    val id = "n${refs.size}"
                    val value = nodeJson(node, id, parentId)
                    val nodeBytes = value.toString().toByteArray(Charsets.UTF_8).size + if (refs.isEmpty()) 0 else 1
                    if (serializedNodeBytes + nodeBytes > SNAPSHOT_NODE_BYTES) {
                        byteBudgetExhausted = true
                        truncated = true
                        capacityTruncated = true
                        return
                    }
                    checkDeadline()
                    val context = nativeContext(node)
                    refs[id] = NodeRef(path, fingerprint(node, context), value, context.signature)
                    serializedNodeBytes += nodeBytes
                    nextParent = id
                }
                if (depth >= maxDepth) { if (node.childCount > 0) { truncated = true; capacityTruncated = true }; return }
                for (index in 0 until node.childCount) {
                    if (byteBudgetExhausted || refs.size >= maxNodes || visited >= maxNodes * 4) { truncated = true; capacityTruncated = true; break }
                    // A declared but unreadable child is missing evidence, not an
                    // empty branch. It may contain an overlay or sensitive control.
                    val child = node.getChild(index)
                    if (child == null) { truncated = true; missingChild = true; continue }
                    try { visit(child, path + index, nextParent, depth + 1) } finally { child.recycle() }
                }
            }
            visit(root, emptyList(), null, 0)
            val snapshot = Snapshot("$session:${++counter}", revision, root.windowId, root.packageName?.toString().orEmpty(), refs, truncated, maxNodes, maxDepth, windowTopology, missingChild, capacityTruncated)
            if (retain) {
                snapshots[snapshot.id] = snapshot
                while (snapshots.size > 4) snapshots.remove(snapshots.keys.first())
            }
            return snapshot
        } finally { root.recycle() }
    }

    private fun snapshotJson(snapshot: Snapshot, forGuard: Boolean = false): JSONObject = JSONObject()
        .put("snapshotId", snapshot.id).put("revision", snapshot.revision).put("executor", NodeActionGuard.EXECUTOR)
        .put("packageName", snapshot.packageName.take(512)).put("windowId", snapshot.windowId)
        .put("nodes", JSONArray(snapshot.nodes.values.map { ref ->
            if (!forGuard) ref.value else JSONObject().also { value ->
                ref.value.keys().forEach { key -> value.put(key, ref.value.get(key)) }
                value.put("contextProtected", ref.fingerprint.stateBits and (1 shl 10) != 0)
                value.put("contextSignature", ref.contextSignature)
            }
        })).put("truncated", snapshot.truncated)

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
        return JSONObject().put("snapshotId", snapshot.id).put("revision", snapshot.revision).put("executor", NodeActionGuard.EXECUTOR)
            .put("packageName", snapshot.packageName.take(512)).put("windowId", snapshot.windowId)
            .put("elements", JSONArray(matches.take(maxResults).map { it.value }))
            .put("truncated", snapshot.truncated || matches.size > maxResults)
    }

    /** Capture and rebind inside the phone command, immediately before native dispatch.
     * Accessibility is cross-process: this narrows the race, it does not promise an atomic UI transaction.
     */
    private fun resolve(params: JSONObject, action: String): Triple<Snapshot, NodeRef, AccessibilityNodeInfo> {
        assertReady()
        val snapshotId = stringParam(params, "snapshotId", 128)
        val nodeId = stringParam(params, "nodeId", 64)
        val previous = snapshots[snapshotId] ?: run {
            commandObservation = snapshotJson(capture())
            throw staleSnapshot(SnapshotStaleReason.SNAPSHOT_MISSING)
        }
        val fresh = captureWithMissingChildRecovery({ refresh ->
            assertReady()
            // One extra fresh read handles transiently unavailable adapter
            // children; never wait for all labels to stop or repeat a mutation.
            capture(previous.maxNodes, previous.maxDepth, refreshNodes = refresh && Build.VERSION.SDK_INT < 33)
        }, { it.missingChild && !it.capacityTruncated })
        val observation = snapshotJson(fresh)
        commandObservation = observation
        val allowances = params.optJSONArray("allowedLabelChanges")?.let { array ->
            (0 until array.length()).map(array::getString)
        } ?: emptyList()
        val previousGuard = NodeActionGuard(snapshotJson(previous, forGuard = true))
        val freshGuard = NodeActionGuard(snapshotJson(fresh, forGuard = true))
        val reboundId = try { previousGuard.rebind(freshGuard, nodeId, action, allowances) }
        catch (error: AgentError) {
            if (error.reason == "PAGE_CONTEXT_CHANGED") {
                previousGuard.changedLabelNodeIds(freshGuard)?.let { changed ->
                    observation.put("changedLabelNodeIds", JSONArray(changed))
                    throw AgentError(error.code,
                        "The target still matches, but labels identified by observation.changedLabelNodeIds changed. No action was sent. Inspect their meaning; only unrelated status labels may be explicitly declared in allowedLabelChanges. Never exempt recipients, accounts or amounts.",
                        error.retryable, error.reason).also { it.nativeContextChange = error.nativeContextChange }
                }
            }
            throw error
        }
        commandLabelAllowanceCount = allowances.size
        val ref = fresh.nodes[reboundId] ?: throw AgentError("NODE_NOT_FOUND", "The rebound target is absent")
        return Triple(fresh, ref, resolveLive(fresh, ref))
    }

    private fun resolveLive(snapshot: Snapshot, ref: NodeRef): AccessibilityNodeInfo {
        var node = root()
        try {
            if (node.windowId != snapshot.windowId || node.packageName?.toString() != snapshot.packageName) throw staleSnapshot(SnapshotStaleReason.WINDOW_CHANGED)
            for (index in ref.path) {
                val next = node.getChild(index) ?: throw staleSnapshot(SnapshotStaleReason.NODE_UNAVAILABLE)
                node.recycle(); node = next
            }
            if (!node.refresh()) throw staleSnapshot(SnapshotStaleReason.NODE_UNAVAILABLE)
            fingerprint(node).changeFrom(ref.fingerprint)?.let { throw staleSnapshot(it) }
            if (node.packageName?.toString() == packageName || node.packageName?.toString() != snapshot.packageName) throw AgentError("PROTECTED_APP", "Nodes outside the current foreground app cannot be operated")
            if (!node.isVisibleToUser) throw AgentError("NODE_NOT_VISIBLE", "Node is not currently visible")
            if (!node.isEnabled) throw AgentError("NODE_DISABLED", "Node is disabled")
            if (node.isPassword) throw AgentError("SENSITIVE_FIELD", "Password fields cannot be operated")
            return node
        } catch (error: Exception) { node.recycle(); throw error }
    }

    /** Windows above the observed app may intercept touch even when absent from its tree. */
    private fun assertUnobscured(snapshot: Snapshot, region: NodeActionGuard.Box) {
        val currentWindows = windows
        try {
            val active = currentWindows.firstOrNull { it.id == snapshot.windowId }
                ?: throw AgentError("TARGET_CHANGED", "The active window could not be verified", true, "WINDOW_CHANGED")
            if (currentWindows.any { window ->
                if (window.id == active.id || window.layer <= active.layer) false
                else {
                    val bounds = Rect().also { window.getBoundsInScreen(it) }
                    region.intersect(NodeActionGuard.Box(bounds.left, bounds.top, bounds.right, bounds.bottom)) != null
                }
            }) throw AgentError("NODE_NOT_ACTIONABLE", "Another window covers the selected target. No action was sent.", false, "WINDOW_OBSCURED")
        } finally { currentWindows.forEach { it.recycle() } }
    }

    private fun nodeAccepted(action: String, method: String, targetId: String, actedId: String = targetId): JSONObject = accepted(action)
        .put("executor", NodeActionGuard.EXECUTOR).put("method", method).put("targetNodeId", targetId)
        .put("actedNodeId", actedId).put("dispatchState", "sent")
        .put("contextVerification", if (commandLabelAllowanceCount > 0) "explicit_label_changes" else "default_context")
        .put("allowedLabelChangesCount", commandLabelAllowanceCount)

    private fun tap(params: JSONObject, completion: GestureCompletion?): JSONObject {
        val (snapshot, ref, target) = resolve(params, "tap_element")
        try {
            val guard = NodeActionGuard(snapshotJson(snapshot))
            val metrics = resources.displayMetrics
            val touch = guard.touch(ref.value.getString("nodeId"), metrics.widthPixels, metrics.heightPixels)
            val actedRef = snapshot.nodes[touch.actedNodeId] ?: throw AgentError("NODE_NOT_FOUND", "The touch target is absent")
            val acted = if (actedRef === ref) target else resolveLive(snapshot, actedRef)
            try {
                assertUnobscured(snapshot, NodeActionGuard.Box(touch.x - 1, touch.y - 1, touch.x + 2, touch.y + 2))
                assertReady()
                dispatchTouch(touch.x, touch.y, touch.x, touch.y, 80, completion)
                return nodeAccepted("tap", "dispatchGesture", touch.targetNodeId, touch.actedNodeId).put("completion", "pending").put("durationMs", 80)
            } finally { if (acted !== target) acted.recycle() }
        } finally { target.recycle() }
    }

    /** An event alone is not proof of changed UI, but a changed or incomplete tree is. */
    private fun verifyUnchangedTree(snapshot: Snapshot) {
        val validator = StreamingSnapshotValidator(snapshot.nodes.values.map { SnapshotNodeState(it.path, it.fingerprint) }, !snapshot.truncated)
        val refreshEveryNode = !(Build.VERSION.SDK_INT >= 33 && clearCache())
        val root = root()
        try {
            if (root.windowId != snapshot.windowId || root.packageName?.toString() != snapshot.packageName) {
                throw staleSnapshot(SnapshotStaleReason.WINDOW_CHANGED)
            }
            var visited = 0
            fun visit(node: AccessibilityNodeInfo, path: List<Int>, depth: Int) {
                checkDeadline()
                if (validator.count >= snapshot.maxNodes || visited >= snapshot.maxNodes * 4) validator.incomplete()
                visited++
                if (refreshEveryNode && !node.refresh()) validator.incomplete()
                if (path.isEmpty() || node.isVisibleToUser) validator.accept(path, fingerprint(node))
                if (depth >= snapshot.maxDepth) {
                    if (node.childCount > 0) validator.incomplete()
                    return
                }
                for (index in 0 until node.childCount) {
                    if (validator.count >= snapshot.maxNodes || visited >= snapshot.maxNodes * 4) validator.incomplete()
                    // Match capture: an unavailable declared child never proves
                    // a complete tree, even when the old visible paths match.
                    val child = node.getChild(index) ?: validator.incomplete()
                    try { visit(child, path + index, depth + 1) } finally { child.recycle() }
                }
            }
            // Equality with the original complete tree implies the same serialized
            // size. Verification needs no JSON construction or byte-budget recount.
            visit(root, emptyList(), 0)
            validator.finish()
        } finally { root.recycle() }
    }

    private fun click(params: JSONObject): JSONObject {
        val (snapshot, ref, target) = resolve(params, "click_element")
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
            if (!acted.refresh()) throw staleSnapshot(SnapshotStaleReason.NODE_UNAVAILABLE)
            fingerprint(acted).changeFrom(actedEntry.value.fingerprint)?.let { throw staleSnapshot(it) }
            val guard = NodeActionGuard(snapshotJson(snapshot))
            // A semantic click must not bypass the same-window visibility guard
            // merely because ACTION_CLICK can activate a covered control.
            val touch = guard.touch(ref.value.getString("nodeId"), resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
            if (touch.actedNodeId != actedEntry.key) throw AgentError("TARGET_CHANGED", "The native click destination changed", true, "TARGET_IDENTITY_CHANGED")
            assertUnobscured(snapshot, guard.targetBounds(actedEntry.key))
            val actedValue = nodeJson(acted, actedEntry.key, null)
            assertReady()
            commandMutationSent = true
            if (!acted.performAction(AccessibilityNodeInfo.ACTION_CLICK)) throw AgentError("ACTION_REJECTED", "Android or the app rejected ACTION_CLICK; inspect the UI before retrying")
            return nodeAccepted("click", "ACTION_CLICK", ref.value.getString("nodeId"), actedEntry.key).put("target", ref.value).put("actedNode", actedValue).put("ancestorHops", ancestorHops)
        } finally {
            if (acted !== target) acted.recycle()
            target.recycle()
        }
    }

    private fun input(params: JSONObject): JSONObject {
        val text = stringParam(params, "text", 16_384, allowEmpty = true)
        val (snapshot, ref, node) = resolve(params, "input_text")
        try {
            if (!node.isEditable) throw AgentError("NOT_EDITABLE", "Node is not an editable field")
            val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
            assertReady()
            assertUnobscured(snapshot, NodeActionGuard(snapshotJson(snapshot)).targetBounds(ref.value.getString("nodeId")))
            commandMutationSent = true
            if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw AgentError("ACTION_REJECTED", "App rejected ACTION_SET_TEXT; custom editors may not support native text input")
            val result = nodeAccepted("set_text", "ACTION_SET_TEXT", ref.value.getString("nodeId"))
            // This checks a field value, not an application-level completion claim.
            result.put("textVerified", node.refresh() && node.text?.toString().orEmpty() == text)
            return result
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
        val (snapshot, ref, node) = resolve(params, "scroll")
        try {
            if (!node.isScrollable) throw AgentError("NOT_SCROLLABLE", "Selected node is not scrollable; select a scrollable container from the tree")
            assertReady()
            assertUnobscured(snapshot, NodeActionGuard(snapshotJson(snapshot)).targetBounds(ref.value.getString("nodeId")))
            commandMutationSent = true
            if (!node.performAction(action)) throw AgentError("ACTION_REJECTED", "Scroll was rejected or the container reached its boundary")
            return nodeAccepted("scroll", "ACTION_SCROLL", ref.value.getString("nodeId")).put("direction", direction)
        } finally { node.recycle() }
    }

    private fun swipe(params: JSONObject, completion: GestureCompletion? = null): JSONObject {
        assertReady()
        val snapshotId = stringParam(params, "snapshotId", 128)
        val snapshot = snapshots[snapshotId] ?: throw staleSnapshot(SnapshotStaleReason.SNAPSHOT_MISSING)
        if (snapshot.windowTopology != windowTopology) throw staleSnapshot(SnapshotStaleReason.WINDOW_CHANGED)
        if (snapshot.truncated) throw AgentError("TRUNCATED_SNAPSHOT", "Coordinate gestures require a complete snapshot. Read with larger maxNodes/maxDepth, or use native scroll.")
        verifyUnchangedTree(snapshot)
        val metrics = resources.displayMetrics
        val sx = intParam(params, "startX", null, 0, metrics.widthPixels - 1)
        val sy = intParam(params, "startY", null, 0, metrics.heightPixels - 1)
        val ex = intParam(params, "endX", null, 0, metrics.widthPixels - 1)
        val ey = intParam(params, "endY", null, 0, metrics.heightPixels - 1)
        val duration = intParam(params, "durationMs", 350, 50, 2000)
        if (kotlin.math.hypot((ex - sx).toDouble(), (ey - sy).toDouble()) <= 24) {
            NodeActionGuard(snapshotJson(snapshot)).validateShortGesture(sx, sy, ex, ey)
        }
        assertUnobscured(snapshot, NodeActionGuard.Box(minOf(sx, ex) - 1, minOf(sy, ey) - 1, maxOf(sx, ex) + 2, maxOf(sy, ey) + 2))
        dispatchTouch(sx, sy, ex, ey, duration, completion)
        return accepted("swipe").put("completion", "pending").put("durationMs", duration).put("dispatchState", "sent").put("executor", NodeActionGuard.EXECUTOR)
    }

    private fun dispatchTouch(sx: Int, sy: Int, ex: Int, ey: Int, duration: Int, completion: GestureCompletion?) {
        val path = Path().apply { moveTo(sx.toFloat(), sy.toFloat()); lineTo(ex.toFloat(), ey.toFloat()) }
        val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, duration.toLong())).build()
        val gestureSession = session
        val callback = object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                completion?.finish(cancelled = false)
                if (connected && session == gestureSession) advanceRevision(invalidateSnapshots = false)
            }
            override fun onCancelled(gestureDescription: GestureDescription?) {
                completion?.finish(cancelled = true)
                if (connected && session == gestureSession) advanceRevision(invalidateSnapshots = false)
            }
        }
        assertReady()
        commandMutationSent = true
        if (!dispatchGesture(gesture, callback, main)) throw AgentError("ACTION_REJECTED", "Android rejected the gesture")
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

    private fun assertObservationActive(canContinue: () -> Boolean) {
        if (!canContinue()) throw AgentError("CANCELLED", "任务已停止")
        if (!connected) throw AgentError("SERVICE_UNAVAILABLE", "Accessibility service is disconnected", true)
        if (stopped) throw AgentError("EMERGENCY_STOPPED", "Automation is stopped. Resume manually in the TapPilot phone app.")
        assertUnlocked()
    }

    private fun waitForObservationSignal(observedRevision: Long, maxWaitMs: Long) {
        synchronized(changes) {
            if (revision == observedRevision && connected && !stopped) {
                try {
                    // Revision is rechecked under the callback's monitor, avoiding lost events.
                    // The worker wakes at least every 100ms for cancellation/lock checks.
                    changes.wait(maxWaitMs)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw AgentError("SERVICE_UNAVAILABLE", "Wait cancelled because the service stopped", true)
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
