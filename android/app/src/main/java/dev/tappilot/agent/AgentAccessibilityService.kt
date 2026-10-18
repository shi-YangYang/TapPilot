@file:Suppress("DEPRECATION")

package dev.tappilot.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.Intent
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Path
import android.graphics.Rect
import android.graphics.Bitmap
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.Executor

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
            service?.let { current ->
                current.visualCaptures.clear()
                synchronized(current.changes) { current.changes.notifyAll() }
            }
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
    private data class NodeRef(val path: List<Int>, val fingerprint: SnapshotNodeFingerprint, val value: JSONObject, val contextSignature: String, val stringEvidence: JSONObject, val drawingOrder: Int, val navigationEvidence: JSONObject)
    private data class Snapshot(val id: String, val revision: Long, val windowId: Int, val packageName: String, val nodes: Map<String, NodeRef>, val truncated: Boolean, val maxNodes: Int, val maxDepth: Int, val windowTopology: Long, val missingChild: Boolean, val capacityTruncated: Boolean, val windowEpoch: WindowReadinessTracker.Epoch, val readiness: WindowReadiness, val interactionSignature: String = "", val interactionEligible: Boolean = false, val rawSwipeWindow: RawSwipeWindowPolicy.Stamp? = null)
    private val main = Handler(Looper.getMainLooper())
    private val changes = Object()
    // Two of the four socket workers remain available for emergency stop and regular commands.
    private val waitSlots = Semaphore(2)
    private val windowReadiness = WindowReadinessTracker()
    private val rawSwipeWindows = RawSwipeWindowTracker()
    private var lastRawSwipeCaptureUptime: Long? = null
    private val screenshotGate = ScreenshotGate()
    private val visualCaptures = VisualCaptureStore<VisualReference>(SystemClock::elapsedRealtime)
    @Volatile private var session = UUID.randomUUID().toString()
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
    private var commandReadinessEvidence: ActionReadinessEvidence? = null
    private var commandLabelAllowanceCount = 0
    private var commandContextVerification = "default_context"
    private var commandAutomaticLabelChangesCount = 0

    override fun onServiceConnected() {
        super.onServiceConnected()
        session = UUID.randomUUID().toString()
        visualCaptures.clear()
        counter = 0L
        windowReadiness.reset()
        rawSwipeWindows.reset()
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
        // Keep the existing strict topology epoch for visual references and label
        // inheritance. Raw swipe uses actual activation/geometry plus a fresh
        // overlay check instead of treating every window notification as a switch.
        if (event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) windowTopology++
        if (event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED || event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            windowReadiness.invalidateActionInheritance()
            observeRawSwipeWindows(event)
        }
        advanceRevision(invalidateSnapshots = false)
    }

    override fun onInterrupt() { runCatching { stopAutomation() } }

    private fun disconnect() {
        connected = false
        visualCaptures.clear()
        windowReadiness.reset()
        rawSwipeWindows.reset()
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
        if (method == "take_screenshot") return screenshot(params, canContinue)
        if (method == "get_ui_tree" || method == "find_element") {
            ToolCatalog.validateRpc(method, params)
            if (!waitSlots.tryAcquire()) throw AgentError("BUSY", "At most two concurrent UI waits are supported", true)
            try {
                val selector = if (method == "find_element") requiredSelector(params) else null
                val snapshot = readWindowSnapshot(if (selector == null) intParam(params, "maxNodes", 300, 1, 500) else 500,
                    if (selector == null) intParam(params, "maxDepth", 20, 1, 40) else 40, canContinue)
                return if (selector == null) snapshotJson(snapshot) else find(snapshot, selector, intParam(params, "maxResults", 20, 1, 100))
            } finally { waitSlots.release() }
        }
        if (method == "act_and_observe" || method in VisualTapPolicy.ACTIONS) {
            if (!waitSlots.tryAcquire()) throw AgentError("BUSY", "At most two concurrent UI waits are supported", true)
            try {
                val combined = if (method in VisualTapPolicy.ACTIONS) {
                    ToolCatalog.validateRpc(method, params)
                    JSONObject().put("action", method).put("arguments", params)
                } else params
                return actAndObserve(combined, canContinue)
            } finally { waitSlots.release() }
        }
        if (method == "wait_for_ui_change") {
            if (!waitSlots.tryAcquire()) throw AgentError("BUSY", "At most two concurrent UI waits are supported", true)
            try { return waitForChange(params, canContinue) } finally { waitSlots.release() }
        }
        return executeOnMain(method, params, canContinue)
    }

    /** Workers own all waiting. Main-thread work is one finite native capture at
     * a time, with no live node retained between samples. Only the final snapshot
     * enters the handle cache, so waiting cannot evict another caller's evidence.
     */
    private fun readWindowSnapshot(maxNodes: Int, maxDepth: Int, canContinue: () -> Boolean,
                                   operationDeadline: Long = Long.MAX_VALUE, settleDeadline: Long? = null,
                                   retain: Boolean = true, readyNotBefore: Long = Long.MIN_VALUE): Snapshot {
        if (Looper.myLooper() == Looper.getMainLooper()) throw AgentError("INVALID_THREAD", "Window readiness must run on a worker")
        val started = SystemClock.elapsedRealtime()
        val deadline = minOf(operationDeadline, settleDeadline ?: (started + 2_500), started + 2_500)
        val operationSession = session
        fun active() {
            assertObservationActive(canContinue)
            if (session != operationSession) throw AgentError("SERVICE_UNAVAILABLE", "Accessibility service session changed while observing", true)
        }
        val waiter = WindowReadinessWaiter(SystemClock::elapsedRealtime, { revision }, ::active, ::waitForObservationSignal, windowReadiness)
        val result = waiter.await(started, deadline, readyNotBefore) {
            // wait_for_ui_change retains its existing final-read allowance after
            // timeout, but that read cannot extend startup stability evidence.
            val readDeadline = if (SystemClock.elapsedRealtime() < deadline) deadline else minOf(operationDeadline, SystemClock.elapsedRealtime() + 2_000)
            val snapshot = onMain(readDeadline) {
                active()
                val previousAllowed = commandAllowed
                commandAllowed = canContinue
                try {
                    assertReady()
                    captureWithMissingChildRecovery({ refresh ->
                        capture(maxNodes, maxDepth, retain = false, refreshNodes = refresh && Build.VERSION.SDK_INT < 33)
                    }, { it.missingChild && !it.capacityTruncated })
                } finally { commandAllowed = previousAllowed }
            }
            WindowReadinessWaiter.Sample(snapshot, snapshot.windowEpoch, snapshot.interactionSignature, snapshot.interactionEligible)
        }
        active()
        return onMain(operationDeadline) {
            active()
            // Preserve the sample's original raw-swipe stamp. A window event
            // between capture and publication must never re-sign old evidence.
            val snapshot = result.sample.value.copy(readiness = windowReadiness.validateReadiness(result.sample.epoch, result.readiness))
            if (retain) remember(snapshot)
            snapshot
        }
    }

    private fun requireWindowReady(previous: Snapshot, fresh: Snapshot, labelContextValidated: Boolean = false): Boolean {
        if (previous.readiness.ready && fresh.readiness.ready && windowReadiness.known(fresh.windowEpoch)) return false
        if (labelContextValidated && previous.readiness.ready && fresh.interactionEligible &&
            previous.windowTopology == fresh.windowTopology && windowReadiness.canInheritForDeclaredLabels(previous.windowEpoch, fresh.windowEpoch, previous.readiness.ready)) return true
        throw AgentError("UI_NOT_READY", "The window is still initializing. No action was sent. Read a ready observation before choosing another action.", false, "OBSERVATION_SETTLING")
    }

    private fun executeOnMain(method: String, params: JSONObject, canContinue: () -> Boolean, deadline: Long = Long.MAX_VALUE,
                              gestureCompletion: GestureCompletion? = null, beforeObservation: ((JSONObject?, ActionReadinessEvidence?) -> Unit)? = null): JSONObject =
        onMain(deadline) {
            if (!connected) throw AgentError("SERVICE_UNAVAILABLE", "Accessibility service is disconnected", true)
            if (!canContinue()) throw AgentError("CANCELLED", "任务已停止")
            commandAllowed = canContinue
            commandMutationSent = false
            commandObservation = null
            commandReadinessEvidence = null
            commandLabelAllowanceCount = 0
            commandContextVerification = "default_context"
            commandAutomaticLabelChangesCount = 0
            try { when (method) {
                "get_device_info" -> JSONObject()
                    .put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
                    .put("sdkInt", Build.VERSION.SDK_INT).put("androidVersion", Build.VERSION.RELEASE)
                    .put("serviceConnected", connected).put("stopped", stopped).put("revision", revision)
                    .put("locked", isLocked()).put("transport", "adb-localabstract")
                    .put("protocolVersion", 1).put("sessionId", session).put("executor", NodeActionGuard.EXECUTOR)
                    .put("observationContract", "semantic-v1")
                    .put("observationCapabilities", observationCapabilities())
                    .put("screenshotSupported", screenshotSupported())
                    .put("visualActionContract", VisualTapPolicy.CONTRACT)
                    .put("visualActionCapabilities", JSONArray(VisualTapPolicy.ACTIONS))
                "get_current_app" -> currentApp()
                "get_ui_tree" -> {
                    assertReady()
                    val maxNodes = intParam(params, "maxNodes", 300, 1, 500)
                    val maxDepth = intParam(params, "maxDepth", 20, 1, 40)
                    snapshotJson(captureWithMissingChildRecovery({ refresh ->
                        capture(maxNodes, maxDepth, refreshNodes = refresh && Build.VERSION.SDK_INT < 33)
                    }, { it.missingChild && !it.capacityTruncated }))
                }
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
                    markMutationAttempt()
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
            } finally {
                beforeObservation?.invoke(commandObservation, commandReadinessEvidence)
                commandAllowed = { true }; commandObservation = null; commandReadinessEvidence = null
            }
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
        val expectedInput = if (actionName == "input_text") params.getJSONObject("arguments").getString("text") else null
        val waitFor = params.optJSONObject("waitFor")
        val gesture = if (actionName in setOf("swipe", "tap_element") || actionName in VisualTapPolicy.ACTIONS) GestureCompletion() else null
        var before: JSONObject? = null
        var beforeEvidence: ActionReadinessEvidence? = null
        val action = if (actionName in VisualTapPolicy.ACTIONS) visualGesture(actionName, params.getJSONObject("arguments"), operationAllowed, deadline, gesture!!)
        else executeOnMain(actionName, params.getJSONObject("arguments"), operationAllowed, deadline, gesture) { observation, evidence ->
            before = observation; beforeEvidence = evidence
        }
        val acted = SystemClock.elapsedRealtime()
        val result = JSONObject().put("action", action)
        val checkedTarget = before?.optJSONArray("nodes")?.let { nodes ->
            (0 until nodes.length()).mapNotNull(nodes::optJSONObject).any {
                it.optString("nodeId") == action.optString("actedNodeId") && it.opt("checkable") == true
            }
        } == true && actionName in setOf("tap_element", "click_element")
        var observationMs = 0L
        var startupDeadline: Long? = null
        try {
            val waitMs = params.optInt("waitMs", 350)
            // A matching field value is immediate acknowledgement, not evidence
            // that debounced controls/results have updated. This applies to all
            // native text input, without app-specific timing or another action.
            val readyNotBefore = if (actionName == "input_text" && waitMs > 0) acted + 1_000 else Long.MIN_VALUE
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
                acted + action.optInt("durationMs", 0) + 750L,
                usable = { observation ->
                    ObservationContract.ready(observation, waitFor) &&
                        (expectedInput == null && !checkedTarget || ObservationContract.verificationScope(action, before, observation, expectedInput, beforeEvidence) != null)
                }) {
                val readStarted = SystemClock.elapsedRealtime()
                try {
                    // One budget covers this action's new interaction generation,
                    // including transitions inside the same Android window. A zero
                    // wait requests one immediate, honestly unconfirmed observation.
                    if (startupDeadline == null) startupDeadline = minOf(deadline, readStarted + if (waitMs == 0) 0 else 2_500)
                    snapshotJson(readWindowSnapshot(300, 20, operationAllowed, deadline, startupDeadline!!, readyNotBefore = readyNotBefore))
                } finally { observationMs += SystemClock.elapsedRealtime() - readStarted }
            }
            result.put("observation", observation)
            val ready = ObservationContract.ready(observation, waitFor)
            result.put("observationWait", JSONObject().put("ready", ready)
                .put("status", if (!ready) "timed_out" else if (waitFor != null) "matched" else "ready"))
        } catch (error: AgentError) {
            result.put("observation", JSONObject.NULL).put("observationError", error.toJson())
        }
        if (gesture != null) action.put("completion", when (gesture.state) {
            GestureCompletion.State.COMPLETED -> "completed"
            GestureCompletion.State.CANCELLED -> "cancelled"
            GestureCompletion.State.PENDING -> "unknown"
        })
        val execution = ObservationContract.execution(action, before, result.optJSONObject("observation"), result.has("observationError"), expectedInput, beforeEvidence)
        // Do not retain an earlier immediate readback after the final observation
        // lost/changed the input or the app transformed its value asynchronously.
        if (actionName == "input_text") action.put("textVerified", execution.optString("verificationScope") == "input_value")
        result.put("execution", execution)
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
            if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0 && cause != null) {
                Log.w("TapPilot.Executor", DebugFailureDiagnostics.codeLocations(cause))
            }
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
        val coordinates = listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)
        val metrics = resources.displayMetrics
        val password = node.isPassword
        return JSONObject().put("nodeId", nodeId).put("parentId", parentId ?: JSONObject.NULL)
            .put("text", if (password) "[REDACTED]" else node.text?.toString()?.take(1000) ?: "")
            .put("contentDescription", if (password) "[REDACTED]" else node.contentDescription?.toString()?.take(1000) ?: "")
            .put("resourceId", node.viewIdResourceName?.take(512) ?: "").put("className", node.className?.toString()?.take(512) ?: "")
            .put("bounds", JSONArray(coordinates))
            .put("clickable", node.isClickable).put("scrollable", node.isScrollable)
            .put("editable", node.isEditable).put("enabled", node.isEnabled).put("password", password)
            .put("checkable", node.isCheckable).put("checked", node.isChecked)
            .put("selected", node.isSelected).put("focused", node.isFocused)
            .put("visible", ObservationContract.visibleOnScreen(node.isVisibleToUser, coordinates, metrics.widthPixels, metrics.heightPixels))
            .also { if (node.isEditable) it.put("showingHintText", node.isShowingHintText) }
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

    /** Native component semantics, kept private. A horizontal collection alone
     * is not a navigation bar. Unknown/localized roles fail closed; text values,
     * package names and view resource IDs never infer a tab or dynamic status.
     */
    private fun nativeNavigation(node: AccessibilityNodeInfo): JSONObject = JSONObject()
        .put("nativeCollection", node.collectionInfo?.let { info -> JSONObject()
            .put("rows", info.rowCount).put("columns", info.columnCount)
            .put("hierarchical", info.isHierarchical).put("selectionMode", info.selectionMode) } ?: JSONObject.NULL)
        .put("nativeCollectionItem", node.collectionItemInfo?.let { item -> JSONObject()
            .put("row", item.rowIndex).put("rowSpan", item.rowSpan).put("column", item.columnIndex)
            .put("columnSpan", item.columnSpan).put("heading", item.isHeading).put("selected", item.isSelected) } ?: JSONObject.NULL)
        .put("nativeTabRole", node.extras.getCharSequence("AccessibilityNodeInfo.roleDescription")?.toString()
            ?.trim()?.lowercase(java.util.Locale.ROOT) in setOf("tab", "标签", "标签页", "標籤", "標籤頁"))

    private fun fingerprint(node: AccessibilityNodeInfo, context: NativeContext = nativeContext(node), navigation: JSONObject = nativeNavigation(node)): SnapshotNodeFingerprint {
        // Hash full text in memory without retaining or logging it; returned UI text is capped separately.
        val rect = Rect().also { node.getBoundsInScreen(it) }
        val flags = listOf(node.isClickable, node.isScrollable, node.isEditable, node.isEnabled, node.isPassword,
            node.isVisibleToUser, node.isCheckable, node.isChecked, node.isSelected, node.isFocused, context.isProtected)
        val childCount = node.childCount
        val fields = listOf(node.packageName, node.className, node.viewIdResourceName,
            if (flags[4]) "[REDACTED]" else node.text,
            if (flags[4]) "[REDACTED]" else node.contentDescription,
            rect.toShortString(), context.signature, node.drawingOrder, navigation.toString()) + flags.take(6) + childCount + flags.drop(6)
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
                    val navigation = nativeNavigation(node)
                    val stringEvidence = NodeActionGuard.nativeStringEvidence(
                        if (node.isPassword) "[REDACTED]" else node.text?.toString().orEmpty(),
                        if (node.isPassword) "[REDACTED]" else node.contentDescription?.toString().orEmpty(),
                        node.viewIdResourceName.orEmpty(), node.className?.toString().orEmpty())
                    refs[id] = NodeRef(path, fingerprint(node, context, navigation), value, context.signature, stringEvidence, node.drawingOrder, navigation)
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
            val scope = WindowReadinessTracker.Scope(session, root.packageName?.toString().orEmpty(), root.windowId)
            val captured = Snapshot("$session:${++counter}", revision, root.windowId, root.packageName?.toString().orEmpty(), refs, truncated, maxNodes, maxDepth, windowTopology, missingChild, capacityTruncated,
                windowReadiness.enter(scope), WindowReadiness.captured(false),
                rawSwipeWindow = captureRawSwipeWindow(root.packageName?.toString().orEmpty(), root.windowId))
            val json = snapshotJson(captured)
            val privateObservation = snapshotJson(captured, forGuard = true)
            // Interaction readiness may describe a stable native navigation
            // surface while its independent display labels keep refreshing.
            // The subsequent action still revalidates its complete context.
            val navigationSurface = runCatching { NodeActionGuard(privateObservation).nativeTabReadinessSignature() }.getOrNull()
            val signature = WindowInteractionSurface.signature(json, captured.rawSwipeWindow?.context, navigationSurface)
            // A launch animation can leave the screen-space node matrix
            // temporarily translated even while repeated trees look stable.
            // API 34 supplies a separate local coordinate space. Only a proven
            // unscaled full-window root may use this consistency check.
            // Older/custom virtual node providers may not populate this API;
            // an empty local rectangle is missing evidence, not a contradiction.
            val localRoot = if (Build.VERSION.SDK_INT >= 34) Rect().also { root.getBoundsInWindow(it) }.takeUnless { it.isEmpty }?.let {
                RawSwipeWindowPolicy.Rect(it.left, it.top, it.right, it.bottom)
            } else null
            val screenRoot = refs.values.first().value.getJSONArray("bounds").let {
                RawSwipeWindowPolicy.Rect(it.getInt(0), it.getInt(1), it.getInt(2), it.getInt(3))
            }
            val frame = captured.rawSwipeWindow?.context
            val frameConsistent = WindowInteractionSurface.rootFrameConsistent(screenRoot, localRoot, frame?.bounds,
                frame?.displayWidth, frame?.displayHeight)
            if (!frameConsistent && applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
                Log.d("TapPilot.Readiness", "sampleRejected reason=ROOT_WINDOW_TRANSFORM")
            }
            val eligible = WindowInteractionSurface.eligible(json) && frameConsistent
            // Register native samples in capture order, not worker completion
            // order. External same-window changes revoke earlier stability too.
            val authorizationSignature = WindowInteractionSurface.authorizationSignature(privateObservation, captured.rawSwipeWindow?.context)
            checkDeadline()
            val epoch = windowReadiness.observe(scope, signature, eligible, authorizationSignature)
            val snapshot = captured.copy(windowEpoch = epoch, readiness = WindowReadiness.captured(windowReadiness.known(epoch, signature)),
                interactionSignature = signature, interactionEligible = eligible)
            if (retain) remember(snapshot)
            return snapshot
        } finally { root.recycle() }
    }

    /** Main-looper only. Waits retain their final tree, not every intermediate read. */
    private fun remember(snapshot: Snapshot) {
        snapshots[snapshot.id] = snapshot
        while (snapshots.size > 4) snapshots.remove(snapshots.keys.first())
    }

    private fun snapshotJson(snapshot: Snapshot, forGuard: Boolean = false): JSONObject = JSONObject()
        .put("snapshotId", snapshot.id).put("revision", snapshot.revision).put("executor", NodeActionGuard.EXECUTOR)
        .put("packageName", snapshot.packageName.take(512)).put("windowId", snapshot.windowId)
        .put("nodes", JSONArray(snapshot.nodes.values.map { ref ->
            if (!forGuard) ref.value else JSONObject().also { value ->
                ref.value.keys().forEach { key -> value.put(key, ref.value.get(key)) }
                value.put("contextProtected", ref.fingerprint.stateBits and (1 shl 10) != 0)
                value.put("contextSignature", ref.contextSignature)
                // Native sibling order is private hit-test evidence. The public
                // parentId may skip invisible ancestors and cannot prove siblings.
                value.put("nativePath", JSONArray(ref.path)).put("nativeDrawingOrder", ref.drawingOrder)
                ref.navigationEvidence.keys().forEach { key -> value.put(key, ref.navigationEvidence.get(key)) }
                ref.stringEvidence.keys().forEach { key -> value.put(key, ref.stringEvidence.get(key)) }
            }
        })).put("truncated", snapshot.truncated)
        .put("observationContract", "semantic-v1")
        .put("observationCapabilities", observationCapabilities())
        .put("readiness", snapshot.readiness.json())
        .also { it.put("quality", ObservationContract.quality(it)) }

    private fun observationCapabilities(): JSONObject = JSONObject().put("readinessWait", true).put("actionSelectorWait", true).put("windowReadiness", true)

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

    private fun find(selector: JSONObject, maxResults: Int): JSONObject = find(capture(500, 40), selector, maxResults)

    private fun find(snapshot: Snapshot, selector: JSONObject, maxResults: Int): JSONObject {
        val matches = snapshot.nodes.values.filter { matches(it.value, selector) }
        return JSONObject().put("snapshotId", snapshot.id).put("revision", snapshot.revision).put("executor", NodeActionGuard.EXECUTOR)
            .put("packageName", snapshot.packageName.take(512)).put("windowId", snapshot.windowId)
            .put("elements", JSONArray(matches.take(maxResults).map { it.value }))
            .put("truncated", snapshot.truncated || matches.size > maxResults)
            .put("observationContract", "semantic-v1").put("observationCapabilities", observationCapabilities())
            .put("readiness", snapshot.readiness.json())
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
        val binding = try { previousGuard.rebindEvidence(freshGuard, nodeId, action, allowances) }
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
        // Preserve the concrete target/context refusal when that evidence changed;
        // otherwise a newly observed surface still needs its own readiness proof.
        val reboundId = binding.nodeId
        val inherited = requireWindowReady(previous, fresh,
            binding.contextVerification in setOf("explicit_label_changes", "native_tab_navigation"))
        if (inherited) commandReadinessEvidence = ActionReadinessEvidence(fresh.id, reboundId, action)
        commandLabelAllowanceCount = allowances.size
        commandContextVerification = binding.contextVerification
        commandAutomaticLabelChangesCount = binding.automaticLabelChangesCount
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

    private fun readRawSwipeWindows(): List<RawSwipeWindowPolicy.Window> {
        val current = windows
        try {
            return current.map { window ->
                checkDeadline()
                val bounds = Rect().also { window.getBoundsInScreen(it) }
                RawSwipeWindowPolicy.Window(window.id, window.type,
                    if (Build.VERSION.SDK_INT >= 30) window.displayId else Display.DEFAULT_DISPLAY,
                    window.layer, window.isActive, window.isFocused,
                    RawSwipeWindowPolicy.Rect(bounds.left, bounds.top, bounds.right, bounds.bottom))
            }
        } finally { current.forEach { it.recycle() } }
    }

    private fun observeRawSwipeWindows(event: AccessibilityEvent) {
        try {
            val current = readRawSwipeWindows()
            val changedWindow = current.singleOrNull { it.id == event.windowId }
            val relevantDisplay = changedWindow == null || changedWindow.displayId == Display.DEFAULT_DISPLAY
            // Older APIs cannot classify a window event: retain conservative
            // invalidation there. Focus/activation flags revoke even if a late
            // callback only lets us observe A after an intervening B.
            val transition = relevantDisplay && event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED &&
                (Build.VERSION.SDK_INT < 28 || event.windowChanges and
                    (AccessibilityEvent.WINDOWS_CHANGE_ACTIVE or AccessibilityEvent.WINDOWS_CHANGE_FOCUSED) != 0)
            val beforeEpoch = rawSwipeWindows.currentEpoch
            val activation = RawSwipeWindowPolicy.activation(session, Display.DEFAULT_DISPLAY, current)
            val afterEpoch = rawSwipeWindows.observe(activation, transition)
            if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0 && transition) {
                val captureUptime = lastRawSwipeCaptureUptime
                Log.d("TapPilot.RawSwipe", "window_event activationKnown=${activation != null} epochDelta=${afterEpoch - beforeEpoch}" +
                    " activeFlag=${event.windowChanges and AccessibilityEvent.WINDOWS_CHANGE_ACTIVE != 0}" +
                    " focusedFlag=${event.windowChanges and AccessibilityEvent.WINDOWS_CHANGE_FOCUSED != 0}" +
                    " captureKnown=${captureUptime != null} eventAfterCaptureMs=${captureUptime?.let { event.eventTime - it }}" +
                    " deliveryLagMs=${SystemClock.uptimeMillis() - event.eventTime}")
            }
        } catch (_: Exception) {
            // Unknown window state cannot preserve old coordinate authority.
            rawSwipeWindows.observe(null)
        }
    }

    private fun captureRawSwipeWindow(packageName: String, windowId: Int,
                                      observedWindows: List<RawSwipeWindowPolicy.Window>? = null): RawSwipeWindowPolicy.Stamp? {
        try {
            val current = observedWindows ?: readRawSwipeWindows()
            val display = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
                ?: return rawSwipeWindows.capture(null)
            val size = Point().also { display.getRealSize(it) }
            checkDeadline()
            return rawSwipeWindows.capture(RawSwipeWindowPolicy.context(session, packageName, windowId,
                Display.DEFAULT_DISPLAY, size.x, size.y, display.rotation, current)).also {
                if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) lastRawSwipeCaptureUptime = SystemClock.uptimeMillis()
            }
        } catch (error: AgentError) {
            throw error
        } catch (_: Exception) {
            // UI-tree reads can still be useful when window metadata is missing;
            // such a snapshot never authorizes a raw coordinate gesture.
            return rawSwipeWindows.capture(null)
        }
    }

    private fun requireRawSwipeWindowSame(snapshot: Snapshot, current: RawSwipeWindowPolicy.Stamp?, phase: String) {
        try { RawSwipeWindowPolicy.requireSame(snapshot.rawSwipeWindow, current) }
        catch (error: AgentError) {
            if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
                val rootBounds = snapshot.nodes.values.firstOrNull { it.path.isEmpty() }?.value?.optJSONArray("bounds")
                    ?.takeIf { it.length() == 4 }?.let { RawSwipeWindowPolicy.Rect(it.getInt(0), it.getInt(1), it.getInt(2), it.getInt(3)) }
                Log.d("TapPilot.RawSwipe", "refused phase=$phase ${RawSwipeWindowPolicy.comparisonDiagnostic(snapshot.rawSwipeWindow, current, rootBounds)}")
            }
            throw error
        }
    }

    private fun assertRawSwipeUnobscured(snapshot: Snapshot, region: RawSwipeWindowPolicy.Rect) {
        val root = root()
        try {
            val current = readRawSwipeWindows()
            val stamp = captureRawSwipeWindow(root.packageName?.toString().orEmpty(), root.windowId, current)
            requireRawSwipeWindowSame(snapshot, stamp, "dispatch")
            RawSwipeWindowPolicy.requireUnobscured(stamp!!.context, current, region)
        } finally { root.recycle() }
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
        .put("contextVerification", commandContextVerification)
        .put("allowedLabelChangesCount", commandLabelAllowanceCount)
        .put("automaticLabelChangesCount", commandAutomaticLabelChangesCount)
        .also { if (commandReadinessEvidence != null) it.put("readinessEvidence",
            if (commandContextVerification == "native_tab_navigation") "native_tab_navigation" else "declared_label_changes") }

    private fun tap(params: JSONObject, completion: GestureCompletion?): JSONObject {
        val (snapshot, ref, target) = resolve(params, "tap_element")
        try {
            val guard = NodeActionGuard(snapshotJson(snapshot, forGuard = true))
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
            requireRawSwipeWindowSame(snapshot,
                captureRawSwipeWindow(root.packageName?.toString().orEmpty(), root.windowId), "snapshot")
            val epoch = windowReadiness.enter(WindowReadinessTracker.Scope(session, root.packageName?.toString().orEmpty(), root.windowId))
            if (!snapshot.readiness.ready || !windowReadiness.known(epoch)) {
                val fresh = capture(snapshot.maxNodes, snapshot.maxDepth)
                commandObservation = snapshotJson(fresh)
                requireWindowReady(snapshot, fresh)
            }
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
            // size, so verification needs no byte-budget recount.
            visit(root, emptyList(), 0)
            validator.finish()
            // The full tree was just verified, including hierarchy and bounds.
            // Preserve it as the pre-gesture observation so actAndObserve can
            // compare the returned page instead of reporting every swipe unknown.
            commandObservation = snapshotJson(snapshot)
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
            val guard = NodeActionGuard(snapshotJson(snapshot, forGuard = true))
            // A semantic click must not bypass the same-window visibility guard
            // merely because ACTION_CLICK can activate a covered control.
            val touch = guard.touch(ref.value.getString("nodeId"), resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
            if (touch.actedNodeId != actedEntry.key) throw AgentError("TARGET_CHANGED", "The native click destination changed", true, "TARGET_IDENTITY_CHANGED")
            assertUnobscured(snapshot, guard.targetBounds(actedEntry.key))
            val actedValue = nodeJson(acted, actedEntry.key, null)
            assertReady()
            markMutationAttempt()
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
            assertUnobscured(snapshot, NodeActionGuard(snapshotJson(snapshot, forGuard = true)).targetBounds(ref.value.getString("nodeId")))
            markMutationAttempt()
            if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw AgentError("ACTION_REJECTED", "App rejected ACTION_SET_TEXT; custom editors may not support native text input")
            val result = nodeAccepted("set_text", "ACTION_SET_TEXT", ref.value.getString("nodeId"))
            // This checks a field value, not an application-level completion claim.
            result.put("textVerified", node.refresh() && !node.isShowingHintText && node.text?.toString().orEmpty() == text)
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
            assertUnobscured(snapshot, NodeActionGuard(snapshotJson(snapshot, forGuard = true)).targetBounds(ref.value.getString("nodeId")))
            markMutationAttempt()
            if (!node.performAction(action)) throw AgentError("ACTION_REJECTED", "Scroll was rejected or the container reached its boundary")
            return nodeAccepted("scroll", "ACTION_SCROLL", ref.value.getString("nodeId")).put("direction", direction)
        } finally { node.recycle() }
    }

    private fun swipe(params: JSONObject, completion: GestureCompletion? = null): JSONObject {
        assertReady()
        val snapshotId = stringParam(params, "snapshotId", 128)
        val snapshot = snapshots[snapshotId] ?: throw staleSnapshot(SnapshotStaleReason.SNAPSHOT_MISSING)
        if (snapshot.truncated) throw AgentError("TRUNCATED_SNAPSHOT", "Coordinate gestures require a complete snapshot. Read with larger maxNodes/maxDepth, or use native scroll.")
        verifyUnchangedTree(snapshot)
        val metrics = resources.displayMetrics
        val sx = intParam(params, "startX", null, 0, metrics.widthPixels - 1)
        val sy = intParam(params, "startY", null, 0, metrics.heightPixels - 1)
        val ex = intParam(params, "endX", null, 0, metrics.widthPixels - 1)
        val ey = intParam(params, "endY", null, 0, metrics.heightPixels - 1)
        val duration = intParam(params, "durationMs", 350, 50, 2000)
        if (kotlin.math.hypot((ex - sx).toDouble(), (ey - sy).toDouble()) <= 24) {
            NodeActionGuard(snapshotJson(snapshot, forGuard = true)).validateShortGesture(sx, sy, ex, ey)
        }
        assertRawSwipeUnobscured(snapshot, RawSwipeWindowPolicy.Rect(minOf(sx, ex) - 1, minOf(sy, ey) - 1, maxOf(sx, ex) + 2, maxOf(sy, ey) + 2))
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
                if (connected && session == gestureSession) {
                    // Concurrent readers cannot reuse stability established while
                    // a long accepted gesture was still moving the screen.
                    windowReadiness.invalidateAfterAction()
                    advanceRevision(invalidateSnapshots = false)
                }
            }
            override fun onCancelled(gestureDescription: GestureDescription?) {
                completion?.finish(cancelled = true)
                if (connected && session == gestureSession) {
                    windowReadiness.invalidateAfterAction()
                    advanceRevision(invalidateSnapshots = false)
                }
            }
        }
        assertReady()
        markMutationAttempt()
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
        markMutationAttempt()
        if (!performGlobalAction(action)) throw AgentError("ACTION_REJECTED", "Android rejected the global action")
        return accepted(key)
    }

    private fun markMutationAttempt() {
        commandMutationSent = true
        visualCaptures.clear()
        windowReadiness.invalidateAfterAction()
    }

    private fun accepted(action: String): JSONObject {
        advanceRevision()
        return JSONObject().put("accepted", true).put("action", action).put("revision", revision)
            .put("verificationRequired", true).put("dispatchState", "sent").put("executor", NodeActionGuard.EXECUTOR)
    }

    private fun waitForChange(params: JSONObject, canContinue: () -> Boolean = { true }): JSONObject {
        ToolCatalog.validateRpc("wait_for_ui_change", params)
        val since = params.getLong("sinceRevision")
        val timeout = intParam(params, "timeoutMs", 10_000, 1, 25_000)
        val selector = if (params.has("selector")) requiredSelector(params) else null
        val requireUsable = params.optBoolean("requireUsable", false)
        // The wait budget and the final native read are independently bounded. A
        // deadline read may detect a silent change; it must not return cached UI.
        val waitDeadline = SystemClock.elapsedRealtime() + timeout
        val operationDeadline = waitDeadline + 2_000
        val operationSession = session
        fun checkActive() {
            assertObservationActive(canContinue)
            if (session != operationSession) throw AgentError("SERVICE_UNAVAILABLE", "Accessibility service session changed while waiting", true)
        }
        val baseline = onMain(operationDeadline) {
            checkActive()
            if (since > revision) throw AgentError("INVALID_ARGUMENT", "sinceRevision is from another service session or is in the future")
            if (params.has("snapshotId")) snapshots[stringParam(params, "snapshotId", 128)]
                ?: throw staleSnapshot(SnapshotStaleReason.SNAPSHOT_MISSING) else null
        }
        fun scope(snapshot: Snapshot) = "$operationSession|${snapshot.packageName}|${snapshot.windowId}"
        val waiter = SemanticObservationWaiter(SystemClock::elapsedRealtime, { revision }, ::checkActive, ::waitForObservationSignal)
        val result = waiter.await(since, (waitDeadline - SystemClock.elapsedRealtime()).coerceAtLeast(0).toInt(), baseline?.let { ObservationContract.signature(snapshotJson(it)) },
            baseline?.let(::scope), selector != null, requireUsable) {
            val snapshot = readWindowSnapshot(baseline?.maxNodes ?: 300, baseline?.maxDepth ?: 20,
                { canContinue() && session == operationSession }, operationDeadline, waitDeadline, retain = false)
            val json = snapshotJson(snapshot)
            SemanticObservationWaiter.Sample(snapshot, snapshot.revision, ObservationContract.signature(json), scope(snapshot),
                selector != null && snapshot.nodes.values.any { it.value.opt("visible") == true && it.value.opt("password") != true && matches(it.value, selector) },
                ObservationContract.ready(json))
        }
        val published = onMain(operationDeadline) {
            checkActive()
            result.sample.value.copy(readiness = windowReadiness.validateReadiness(result.sample.value.windowEpoch,
                result.sample.value.readiness)).also(::remember)
        }
        val json = snapshotJson(published)
        val ready = ObservationContract.ready(json)
        val status = if (requireUsable && !ready) "timed_out" else result.status
        return json
            .put("changed", result.semanticChanged ?: result.eventChanged)
            .put("timedOut", status == "timed_out").put("matched", result.sample.matched)
            .put("wait", JSONObject().put("mode", if (baseline == null) "events" else "semantic")
                .put("status", status).put("semanticChanged", result.semanticChanged ?: JSONObject.NULL)
                .put("requireUsable", requireUsable).put("ready", ready && (selector == null || result.sample.matched)))
    }

    private fun assertObservationActive(canContinue: () -> Boolean) {
        if (!canContinue()) throw AgentError("CANCELLED", "任务已停止")
        if (!connected) throw AgentError("SERVICE_UNAVAILABLE", "Accessibility service is disconnected", true)
        if (stopped) throw AgentError("EMERGENCY_STOPPED", "Automation is stopped. Resume manually in the TapPilot phone app.")
        assertUnlocked()
    }

    private data class ScreenshotContext(
        val session: String, val packageName: String, val windowId: Int, val bounds: List<Int>,
        val topologyEpoch: Long, val windows: String, val displayWidth: Int, val displayHeight: Int, val rotation: Int,
    )

    private class CapturedScreenshot(val context: ScreenshotContext, val image: ScreenshotPixels.Image,
                                     val sourceWidth: Int, val sourceHeight: Int, val capturedAt: Long) : AutoCloseable {
        private var pixels = image.visualPixels
        fun detachPixels(): VisualTapPolicy.Pixels? = pixels.also { pixels = null }
        override fun close() { pixels?.close(); pixels = null; image.bytes.fill(0) }
        fun geometry(): VisualTapPolicy.Geometry? {
            val b = context.bounds
            val width = b[2] - b[0]; val height = b[3] - b[1]
            val sourceMatches = if (Build.VERSION.SDK_INT >= 34) sourceWidth == width && sourceHeight == height
                else sourceWidth == context.displayWidth && sourceHeight == context.displayHeight
            if (!sourceMatches || width <= 0 || height <= 0 || b[0] < 0 || b[1] < 0 ||
                b[2] > context.displayWidth || b[3] > context.displayHeight || pixels == null) return null
            return VisualTapPolicy.Geometry(image.width, image.height, b[0], b[1], width, height, context.displayWidth, context.displayHeight)
        }
    }

    private class VisualReference(val context: ScreenshotContext, val geometry: VisualTapPolicy.Geometry,
                                  val pixels: VisualTapPolicy.Pixels) : AutoCloseable {
        override fun close() { pixels.close() }
    }

    private class ScreenshotFrame(val result: ScreenshotResult) : AutoCloseable {
        val receivedAt = SystemClock.elapsedRealtime()
        override fun close() { result.hardwareBuffer.close() }
    }

    private fun screenshotSupported() = Build.VERSION.SDK_INT >= 30 &&
        (serviceInfo?.capabilities ?: 0) and AccessibilityServiceInfo.CAPABILITY_CAN_TAKE_SCREENSHOT != 0

    /** Only exact image-to-window geometry can receive a short-lived, one-use action reference. */
    private fun screenshot(params: JSONObject, canContinue: () -> Boolean): JSONObject {
        ToolCatalog.validateRpc("take_screenshot", params)
        visualCaptures.clear()
        val generation = visualCaptures.generation()
        val captured = captureScreenshot(canContinue)
        try {
            val context = captured.context
            val image = captured.image
            val id = UUID.randomUUID().toString()
            val result = JSONObject().put("kind", "screenshot").put("captureId", id)
                .put("packageName", context.packageName).put("windowId", context.windowId)
                .put("width", image.width).put("height", image.height).put("mimeType", "image/jpeg")
                .put("data", Base64.encodeToString(image.bytes, Base64.NO_WRAP))
                .put("source", if (Build.VERSION.SDK_INT >= 34) "window" else "display").put("observationOnly", true)
            val geometry = captured.geometry()
            if (geometry != null) {
                assertObservationActive(canContinue)
                val reference = VisualReference(context, geometry, captured.detachPixels()!!)
                if (visualCaptures.issue(id, reference, generation)) {
                    result.put("observationOnly", false).put("actionContract", VisualTapPolicy.CONTRACT)
                        .put("expiresInMs", VisualTapPolicy.TTL_MS)
                        .put("supportedActions", JSONArray(VisualTapPolicy.ACTIONS))
                    main.postDelayed({ visualCaptures.expire(id) }, VisualTapPolicy.TTL_MS)
                }
            }
            return result
        } finally { captured.close() }
    }

    private fun captureScreenshot(canContinue: () -> Boolean, operationDeadline: Long = Long.MAX_VALUE): CapturedScreenshot {
        if (Looper.myLooper() == Looper.getMainLooper()) throw AgentError("INVALID_THREAD", "Screenshot must run on a worker")
        assertObservationActive(canContinue)
        if (Build.VERSION.SDK_INT < 30) throw AgentError("SCREENSHOT_UNSUPPORTED", "截图观察需要 Android 11 或更新版本")
        if (!screenshotSupported()) throw AgentError("SCREENSHOT_UNSUPPORTED", "截图能力尚未生效，请在手机重新开启 TapPilot 无障碍服务")
        val operationSession = session
        fun active() {
            assertObservationActive(canContinue)
            if (operationSession != session) throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "截图期间服务会话已变化")
        }
        var encoded: CapturedScreenshot? = null
        try {
            return ScreenshotCapture<ScreenshotFrame>(SystemClock::elapsedRealtime, screenshotGate).capture(
                active = ::active,
                operationDeadline = operationDeadline,
                context = { deadline -> onMain(deadline) { active(); screenshotContext() } },
                start = { context, delivery, deadline -> onMain(deadline) {
                    active()
                    if (screenshotContext() != context) throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "截图前页面已切换")
                    // Callback only transfers the buffer. Encoding stays on the bounded RPC worker;
                    // a late callback closes its buffer even after timeout/disconnect/destruction.
                    val callback = object : TakeScreenshotCallback {
                        override fun onSuccess(screenshot: ScreenshotResult) { delivery.success(ScreenshotFrame(screenshot)) }
                        override fun onFailure(errorCode: Int) { delivery.failure(ScreenshotLimits.nativeError(errorCode)) }
                    }
                    val direct = Executor { it.run() }
                    if (Build.VERSION.SDK_INT >= 34) takeScreenshotOfWindow(context.windowId, direct, callback)
                    else takeScreenshot(Display.DEFAULT_DISPLAY, direct, callback)
                    // Never downgrade to a display screenshot after a protected window failure.
                } },
                encode = { frame, context, deadline ->
                    val bitmap = Bitmap.wrapHardwareBuffer(frame.result.hardwareBuffer, frame.result.colorSpace)
                        ?: throw AgentError("SCREENSHOT_FAILED", "截图未返回有效图像")
                    val image = try {
                        val crop = if (Build.VERSION.SDK_INT >= 34) null else context.bounds.let { Rect(it[0], it[1], it[2], it[3]) }
                        ScreenshotPixels.encode(bitmap, crop, includeVisualEvidence = true) {
                            active()
                            if (SystemClock.elapsedRealtime() >= deadline) throw AgentError("SCREENSHOT_TIMEOUT", "截图处理超时，图片已丢弃")
                        }
                    } finally { bitmap.recycle() }
                    CapturedScreenshot(context, image, frame.result.hardwareBuffer.width, frame.result.hardwareBuffer.height, frame.receivedAt).also { encoded = it }
                },
            )
        } catch (error: AgentError) {
            encoded?.close()
            if (error.code == "COMMAND_TIMEOUT") throw AgentError("SCREENSHOT_TIMEOUT", "截图超时，未自动重试")
            if (error.code == "NO_ACTIVE_WINDOW") throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "当前窗口无法确认，未读取截图")
            throw error
        } catch (_: SecurityException) {
            encoded?.close()
            throw AgentError("SCREENSHOT_PROTECTED", "系统不允许读取此页面的截图", reason = "SCREENSHOT_ACCESS_DENIED")
        } catch (_: Exception) {
            encoded?.close()
            throw AgentError("SCREENSHOT_FAILED", "截图未完成，未自动重试")
        }
    }

    /** One worker-owned validation capture, then one bounded main-thread dispatch. */
    private fun visualGesture(actionName: String, params: JSONObject, canContinue: () -> Boolean, deadline: Long, completion: GestureCompletion): JSONObject {
        ToolCatalog.validateAction(actionName, params)
        if (Looper.myLooper() == Looper.getMainLooper()) throw AgentError("INVALID_THREAD", "Visual validation must run on a worker")
        val lease = visualCaptures.consume(params.getString("captureId"))
        try {
            val reference = lease.value
            VisualTapPolicy.requireSafeTargetDescription(params.getString("targetDescription"))
            val swipe = actionName == "swipe_visual"
            val start = VisualTapPolicy.Point(params.getInt(if (swipe) "startX" else "x"), params.getInt(if (swipe) "startY" else "y"))
            val end = if (swipe) VisualTapPolicy.Point(params.getInt("endX"), params.getInt("endY")) else start
            val mapped = if (swipe) reference.geometry.mapSwipe(start, end)
                else VisualTapPolicy.Segment(reference.geometry.map(start.x, start.y), reference.geometry.map(end.x, end.y))
            val duration = if (swipe) intParam(params, "durationMs", 450, 200, 1000) else 80
            fun active() {
                assertObservationActive(canContinue)
                if (session != reference.context.session) throw AgentError("VISUAL_CONTEXT_CHANGED", "截图所属服务会话已变化")
                visualCaptures.requireCurrent(lease)
                if (SystemClock.elapsedRealtime() >= deadline) throw AgentError("COMMAND_TIMEOUT", "视觉动作验证超时，未发送手势")
            }
            // Respect Android's capture rate without retrying a capture or a mutation.
            while (true) {
                active()
                val delay = screenshotGate.remainingDelay(SystemClock.elapsedRealtime())
                if (delay == 0L) break
                waitForObservationSignal(revision, minOf(100, delay))
            }
            val fresh = captureScreenshot({ active(); true }, deadline)
            try {
                active()
                if (fresh.context != reference.context) throw AgentError("VISUAL_CONTEXT_CHANGED", "截图后窗口、方向或遮挡已变化，未发送点击")
                val freshPixels = fresh.image.visualPixels ?: throw AgentError("VISUAL_ACTION_UNSUPPORTED", "无法校验当前截图")
                try {
                    VisualTapPolicy.requireActionScene(reference.pixels, freshPixels, start.x, start.y,
                        reference.geometry.imageWidth, reference.geometry.imageHeight, swipe)
                } catch (error: AgentError) {
                    // This call is before the main-thread dispatch block. Do not
                    // attach not_sent to unrelated errors or later gesture failures.
                    if (error.code == "VISUAL_SCENE_CHANGED") error.visualComparison?.let { comparison ->
                        error.visualNotSentComparison = VisualTapPolicy.NotSentComparison(comparison,
                            maxOf(0L, SystemClock.elapsedRealtime() - lease.issuedAt))
                    }
                    throw error
                }
                return onMain(deadline) {
                    commandAllowed = canContinue
                    commandMutationSent = false
                    try {
                        active()
                        assertReady()
                        assertVisualTargetSafe(reference.context, mapped, swipe)
                        if (screenshotContext() != reference.context || SystemClock.elapsedRealtime() - fresh.capturedAt > 1_000)
                            throw AgentError("VISUAL_CONTEXT_CHANGED", "动作前页面上下文或图像时效已变化，未发送手势")
                        active()
                        dispatchTouch(mapped.start.x, mapped.start.y, mapped.end.x, mapped.end.y, duration, completion)
                        accepted(actionName).put("executor", VisualTapPolicy.CONTRACT)
                            .put("completion", "pending").put("durationMs", duration)
                    } finally { commandAllowed = { true } }
                }
            } finally { fresh.close() }
        } finally { lease.value.close() }
    }

    /** Screenshot isolation never authorizes touching through another window's pixels. */
    private fun assertVisualTargetSafe(context: ScreenshotContext, segment: VisualTapPolicy.Segment, swipe: Boolean) {
        val current = windows
        try {
            val active = current.singleOrNull { it.id == context.windowId && it.isActive }
                ?: throw AgentError("VISUAL_CONTEXT_CHANGED", "点击目标窗口已失效")
            val overlays = current.filter { window ->
                window.id != active.id && window.displayId == active.displayId && window.layer > active.layer
            }.map { window ->
                val box = Rect().also { window.getBoundsInScreen(it) }
                ScreenshotWindowPolicy.Box(box.left, box.top, box.right, box.bottom)
            }
            ScreenshotWindowPolicy.requireUnobscuredGesture(overlays, segment, swipe)
        } finally { current.forEach { it.recycle() } }
        val root = root()
        try {
            if (root.windowId != context.windowId || root.packageName?.toString() != context.packageName)
                throw AgentError("VISUAL_CONTEXT_CHANGED", "点击目标页面已切换")
            var count = 0
            val targetNodes = mutableListOf<VisualTapPolicy.TargetNode>()
            fun inspect(node: AccessibilityNodeInfo, path: List<Int>) {
                checkDeadline()
                if (++count > 2000 || path.size > 64) throw AgentError("VISUAL_TARGET_UNSAFE", "无法完整检查目标控件，未发送点击")
                if (node.isPassword || Build.VERSION.SDK_INT >= 34 && node.isAccessibilityDataSensitive)
                    throw AgentError("VISUAL_TARGET_UNSAFE", "目标涉及敏感控件或提交操作，未发送点击")
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                val text = node.text?.toString().orEmpty()
                val description = node.contentDescription?.toString().orEmpty()
                val resourceId = node.viewIdResourceName.orEmpty()
                targetNodes.add(VisualTapPolicy.TargetNode(path,
                    ScreenshotWindowPolicy.Box(bounds.left, bounds.top, bounds.right, bounds.bottom), node.isVisibleToUser,
                    node.isClickable || node.isCheckable, node.isEnabled, node.isEditable,
                    VisualTapPolicy.nativeLabelIsSensitive(text, description, resourceId), text.isNotBlank() || description.isNotBlank()))
                for (index in 0 until node.childCount) {
                    val child = node.getChild(index) ?: throw AgentError("VISUAL_TARGET_UNSAFE", "目标层级不完整，未发送点击")
                    try { inspect(child, path + index) } finally { child.recycle() }
                }
            }
            inspect(root, emptyList())
            val b = context.bounds
            val window = ScreenshotWindowPolicy.Box(b[0], b[1], b[2], b[3])
            if (swipe) VisualTapPolicy.requireSafeNativeSwipe(targetNodes, segment, window, ::checkDeadline)
            else VisualTapPolicy.requireSafeNativeTarget(targetNodes, segment.start, window)
        } finally { root.recycle() }
    }

    /** No live node/window escapes this main-thread check, and no UI strings are recorded. */
    private fun screenshotContext(): ScreenshotContext {
        if (Build.VERSION.SDK_INT >= 33) clearCache()
        val root = root()
        try {
            if (!root.refresh()) throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "当前窗口无法确认，未读取截图")
            val pkg = root.packageName?.toString().orEmpty()
            if (pkg == packageName) throw AgentError("PROTECTED_APP", "TapPilot 的安全与模型配置页面不可远程截图")
            if (pkg.isBlank() || pkg.length > 512) throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "当前应用无法确认，未读取截图")
            var visited = 0
            fun inspect(node: AccessibilityNodeInfo, depth: Int) {
                checkDeadline()
                if (++visited > 2000 || depth > 64) throw AgentError("SCREENSHOT_PROTECTED", "页面敏感内容无法完整检查，未读取截图", reason = "SENSITIVE_SCAN_LIMIT")
                if (Build.VERSION.SDK_INT < 33 && !node.refresh()) throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "当前页面无法确认，未读取截图")
                if (node.isPassword) throw AgentError("SENSITIVE_FIELD", "当前页面含密码控件，未读取截图", reason = "SENSITIVE_NODE")
                if (Build.VERSION.SDK_INT >= 34 && node.isAccessibilityDataSensitive)
                    throw AgentError("SCREENSHOT_PROTECTED", "当前页面包含受保护内容，未读取截图", reason = "SENSITIVE_NODE")
                for (index in 0 until node.childCount) {
                    val child = node.getChild(index) ?: continue
                    try { inspect(child, depth + 1) } finally { child.recycle() }
                }
            }
            inspect(root, 0)
            val current = windows
            try {
                val active = current.singleOrNull { it.id == root.windowId && it.isActive }
                    ?: throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "当前窗口无法确认，未读取截图")
                if (active.type != AccessibilityWindowInfo.TYPE_APPLICATION || active.displayId != Display.DEFAULT_DISPLAY)
                    throw AgentError("SCREENSHOT_PROTECTED", "此窗口不支持截图观察", reason = "UNSUPPORTED_WINDOW")
                val bounds = Rect().also { active.getBoundsInScreen(it) }
                if (bounds.isEmpty) throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "当前窗口没有有效区域")
                val nativeWindow = Build.VERSION.SDK_INT >= 34
                val obscuring = current.filter { window ->
                    // Display capture must also reject visible underlying apps (e.g. translucent
                    // activities), since cropping alone cannot separate their pixels.
                    window.id != active.id && window.displayId == active.displayId &&
                        ((nativeWindow && (window.isActive || window.isFocused)) ||
                            (window.layer > active.layer || !nativeWindow && window.type == AccessibilityWindowInfo.TYPE_APPLICATION) &&
                            Rect.intersects(bounds, Rect().also { window.getBoundsInScreen(it) }))
                }
                val display = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
                    ?: throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "当前显示区域无法确认")
                val displaySize = Point().also { display.getRealSize(it) }
                fun box(rect: Rect) = ScreenshotWindowPolicy.Box(rect.left, rect.top, rect.right, rect.bottom)
                val content = ScreenshotWindowPolicy.contentRegion(ScreenshotWindowPolicy.Box(0, 0, displaySize.x, displaySize.y), box(bounds),
                    obscuring.map { window ->
                        // Only display capture needs to verify decor ownership before cropping.
                        // Native capture isolates the app's pixels; inactive, unfocused
                        // overlays remain subject to separate physical gesture checks.
                        val trusted = if (nativeWindow) false else {
                            val windowRoot = window.root
                            val owner = try { windowRoot?.packageName?.toString() } finally { windowRoot?.recycle() }
                            owner == "com.android.systemui" && runCatching {
                                packageManager.getApplicationInfo(owner, 0).flags and ApplicationInfo.FLAG_SYSTEM != 0
                            }.getOrDefault(false)
                        }
                        ScreenshotWindowPolicy.Overlay(box(Rect().also { window.getBoundsInScreen(it) }), trusted,
                            window.type == AccessibilityWindowInfo.TYPE_SYSTEM, window.isActive, window.isFocused)
                    }, if (nativeWindow) ScreenshotWindowPolicy.Mode.NATIVE_WINDOW else ScreenshotWindowPolicy.Mode.LEGACY_DISPLAY)
                val topology = current.filter { it.displayId == active.displayId }.sortedBy { it.id }.map { window ->
                    val region = Rect().also { window.getBoundsInScreen(it) }
                    listOf(window.id, window.type, window.layer, window.isActive, window.isFocused, region.left, region.top, region.right, region.bottom)
                }
                // Window capture excludes other windows natively. Legacy display capture must
                // physically crop the verified system bars, so their pixels never leave Android.
                val captureBounds = if (Build.VERSION.SDK_INT >= 34) bounds else Rect(content.left, content.top, content.right, content.bottom)
                return ScreenshotContext(session, pkg, active.id, listOf(captureBounds.left, captureBounds.top, captureBounds.right, captureBounds.bottom), windowTopology,
                    JSONArray(topology).toString(), displaySize.x, displaySize.y, display.rotation)
            } finally { current.forEach { it.recycle() } }
        } finally { root.recycle() }
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
