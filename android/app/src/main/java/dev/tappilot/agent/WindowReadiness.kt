package dev.tappilot.agent

import org.json.JSONArray
import org.json.JSONObject

/** Read readiness is deliberately separate from node identity and authorization.
 * Only the current observed window is remembered; leaving and returning starts a
 * new epoch. An attempted mutation also starts a new generation in the same
 * window: a fragment/list transition need not allocate another Android window.
 * Native captures bind its interaction surface in main-looper order. Events alone
 * do not reset it, and collection-row refreshes retain the same surface signature.
 */
internal class WindowReadinessTracker {
    data class Scope(val session: String, val packageName: String, val windowId: Int)
    data class Epoch(val scope: Scope, val generation: Long, val authorizationGeneration: Long) {
        fun sameSurface(other: Epoch?): Boolean = other != null && scope == other.scope && generation == other.generation
    }
    private var current: Epoch? = null
    private var generation = 0L
    private var authorizationGeneration = 0L
    private var ready = false
    private var observedSignature: String? = null
    private var observedEligible = false
    private var observedAuthorizationSignature: String? = null
    @Synchronized fun enter(scope: Scope): Epoch {
        if (current?.scope != scope) {
            current = Epoch(scope, ++generation, ++authorizationGeneration); ready = false
            observedSignature = null; observedEligible = false; observedAuthorizationSignature = null
        }
        return current!!
    }
    /** Main-looper only: bind before handing a sample to a worker. Changing even
     * an unconfirmed surface revokes older workers' authority, so a delayed old
     * sample cannot confirm after a newer native capture observed a transition.
     */
    @Synchronized fun observe(scope: Scope, signature: String, eligible: Boolean, authorizationSignature: String): Epoch {
        enter(scope)
        val surfaceChanged = observedSignature != signature || observedEligible != eligible
        val authorizationChanged = observedAuthorizationSignature != authorizationSignature || observedEligible != eligible
        if (surfaceChanged || authorizationChanged) {
            if (authorizationChanged) authorizationGeneration++
            if (surfaceChanged) generation++
            current = Epoch(scope, generation, authorizationGeneration)
            if (surfaceChanged) ready = false
            observedSignature = signature; observedEligible = eligible
            observedAuthorizationSignature = authorizationSignature
        }
        return current!!
    }
    @Synchronized fun known(epoch: Epoch): Boolean = epoch.sameSurface(current) && ready && observedEligible
    @Synchronized fun known(epoch: Epoch, signature: String): Boolean = known(epoch) && observedSignature == signature
    @Synchronized fun confirm(epoch: Epoch, signature: String): Boolean {
        if (!epoch.sameSurface(current) || !observedEligible || observedSignature != signature) return false
        ready = true
        return true
    }
    /** Called on the service main looper immediately before a native dispatch.
     * A rejected native attempt may still affect UI; a preflight refusal cannot.
     */
    @Synchronized fun invalidateAfterAction() {
        authorizationGeneration++
        current = current?.let { Epoch(it.scope, ++generation, authorizationGeneration) }
        ready = false
    }
    /** Window events end action-specific inheritance even when no reader sampled
     * the intervening window. They do not claim the current surface is unstable.
     */
    @Synchronized fun invalidateActionInheritance() {
        authorizationGeneration++
        current = current?.copy(authorizationGeneration = authorizationGeneration)
    }
    /** Called only after a unique target and a complete label context passed
     * native validation (explicit declarations or a native tab navigation proof).
     * This never confirms global window readiness.
     */
    @Synchronized fun canInheritForDeclaredLabels(baseline: Epoch, fresh: Epoch, baselineReady: Boolean): Boolean =
        baselineReady && current == fresh && observedEligible && baseline.scope == fresh.scope &&
            baseline.authorizationGeneration == fresh.authorizationGeneration && baseline.generation <= fresh.generation
    /** A worker may finish sampling just before another main-thread mutation.
     * Publishing that old epoch must not restore its former ready authority.
     */
    @Synchronized fun validateReadiness(epoch: Epoch, observation: WindowReadiness): WindowReadiness =
        if (observation.ready && !known(epoch)) observation.copy(status = "settling", reason = "deadline") else observation
    @Synchronized fun reset() {
        current = null; ready = false; observedSignature = null; observedEligible = false
        observedAuthorizationSignature = null; generation++; authorizationGeneration++
    }
}

internal data class WindowReadiness(val status: String, val reason: String, val samples: Int, val waitedMs: Long) {
    val ready: Boolean get() = status == "ready"
    fun json(): JSONObject = JSONObject().put("status", status).put("reason", reason)
        .put("samples", samples).put("waitedMs", waitedMs.coerceIn(0, 60_000))
    companion object {
        fun captured(known: Boolean) = WindowReadiness(if (known) "ready" else "settling", if (known) "known_window" else "deadline", 1, 0)
    }
}

/** Bounded observation only. No action callback, no global idle requirement, and
 * no sleeping on the Android main looper. Stability spans completed samples, so
 * one expensive native read cannot count as multiple observations.
 */
internal class WindowReadinessWaiter(
    private val now: () -> Long,
    private val revision: () -> Long,
    private val checkActive: () -> Unit,
    private val waitForSignal: (Long, Long) -> Unit,
    private val tracker: WindowReadinessTracker,
) {
    data class Sample<T>(val value: T, val epoch: WindowReadinessTracker.Epoch, val signature: String, val eligible: Boolean)
    data class Result<T>(val sample: Sample<T>, val readiness: WindowReadiness)

    fun <T> await(started: Long, deadline: Long, readyNotBefore: Long = Long.MIN_VALUE, read: () -> Sample<T>): Result<T> {
        var latest: Sample<T>? = null
        var candidate: Sample<T>? = null
        var stableSince = 0L
        var samples = 0
        var lastMissing: AgentError? = null
        fun finish(sample: Sample<T>, reason: String) = Result(sample, WindowReadiness(
            if (reason == "deadline") "settling" else "ready", reason, samples, now() - started))
        while (true) {
            checkActive()
            if (latest != null && now() >= deadline) return finish(latest!!, "deadline")
            val readStarted = now()
            try {
                val sample = read()
                latest = sample; samples++
                checkActive()
                val completed = now()
                // Input readback can precede debounced form/search updates. Keep
                // sampling through that action's fixed observation window; an
                // already-known sample cannot bypass that window or its hard
                // deadline. Calls without a minimum retain their one-read path.
                if (completed >= readyNotBefore && (readyNotBefore == Long.MIN_VALUE || completed <= deadline) && sample.eligible &&
                    tracker.known(sample.epoch, sample.signature)) return finish(sample, "known_window")
                if (completed <= deadline && sample.eligible) {
                    if (!sample.epoch.sameSurface(candidate?.epoch) || candidate?.signature != sample.signature) {
                        candidate = sample; stableSince = completed
                    } else if (completed >= readyNotBefore && completed - stableSince >= 240 && tracker.confirm(sample.epoch, sample.signature)) {
                        return finish(sample, "interaction_stable")
                    }
                } else candidate = null
            } catch (error: AgentError) {
                if (error.code == "COMMAND_TIMEOUT" && latest != null && now() >= deadline) return finish(latest!!, "deadline")
                if (error.code != "NO_ACTIVE_WINDOW") throw error
                lastMissing = error; candidate = null
            }
            if (now() >= deadline) return latest?.let { finish(it, "deadline") }
                ?: throw (lastMissing ?: AgentError("NO_ACTIVE_WINDOW", "No native window became available before the observation deadline", true))
            // Slow reads already consume the cadence; do not add an unconditional
            // sleep after each capture. Event storms cannot move this deadline.
            val nextReadAt = minOf(deadline, readStarted + 120)
            while (true) {
                checkActive()
                val remaining = nextReadAt - now()
                // Object.wait(0) is unbounded, and a negative wait throws. Read
                // the clock once so crossing the deadline cannot produce either.
                if (remaining <= 0) break
                waitForSignal(revision(), minOf(100, remaining))
            }
        }
    }
}

/** Waiting may ignore changing rows inside a native collection. Returned trees,
 * node fingerprints and NodeActionGuard still retain and validate every row.
 * Generic ScrollViews are NOT collections: their form labels remain significant.
 */
internal object WindowInteractionSurface {
    private val collections = setOf("androidx.recyclerview.widget.RecyclerView", "android.support.v7.widget.RecyclerView",
        "android.widget.ListView", "android.widget.GridView")
    /** Reject contradictory native root/window coordinates during transitions.
     * Only a full-window, unscaled root establishes this mapping. Partial roots,
     * magnification and unavailable bounds retain ordinary stability sampling;
     * their positions cannot be inferred from these rectangles alone.
     */
    fun rootFrameConsistent(screen: RawSwipeWindowPolicy.Rect, local: RawSwipeWindowPolicy.Rect?, window: RawSwipeWindowPolicy.Rect?,
                            displayWidth: Int? = null, displayHeight: Int? = null): Boolean {
        if (!screen.valid || local?.valid == false || window?.valid == false) return false
        if (local == null || window == null) return true
        fun width(rect: RawSwipeWindowPolicy.Rect) = rect.right.toLong() - rect.left.toLong()
        fun height(rect: RawSwipeWindowPolicy.Rect) = rect.bottom.toLong() - rect.top.toLong()
        val fullWindow = local.left == 0 && local.top == 0 && width(local) == width(window) && height(local) == height(window)
        val unscaled = width(screen) == width(window) && height(screen) == height(window)
        if (!fullWindow || !unscaled) return true
        if (screen != window) return false
        // During launch WindowManager and the root may translate together. Only
        // an exactly display-sized, unscaled window proves its final origin;
        // smaller dialogs and missing display metrics provide no such evidence.
        val fillsDisplay = displayWidth != null && displayHeight != null && displayWidth > 0 && displayHeight > 0 &&
            width(window) == displayWidth.toLong() && height(window) == displayHeight.toLong()
        return !fillsDisplay || window.left == 0 && window.top == 0
    }

    fun eligible(observation: JSONObject): Boolean {
        if (!ObservationContract.usable(observation)) return false
        val all = nodes(observation)
        val nodes = all.filter { it.opt("visible") == true }
        val byId = all.associateBy { it.optString("nodeId") }
        val loading = nodes.any { it.optString("className") == "android.widget.ProgressBar" }
        val interactive = nodes.any { it.optString("className") !in collections && !inCollection(it, byId) &&
            it.opt("enabled") == true && it.opt("password") != true &&
            listOf("clickable", "editable", "checkable").any { key -> it.opt(key) == true } }
        return !loading || interactive
    }
    fun signature(observation: JSONObject, windowContext: RawSwipeWindowPolicy.Context? = null, nativeTabSurface: String? = null): String {
        // Produced only by the private native guard. This controls observation
        // sampling, not authorization: ordinary buttons retain full context
        // checks and only qualified tabs can tolerate the normalized labels.
        if (nativeTabSurface != null) return snapshotFingerprintDigest(listOf("native_tab_surface",
            observation.optString("packageName"), observation.optInt("windowId"), nativeTabSurface, windowGeometry(windowContext)))
        val all = nodes(observation)
        val excluded = mutableSetOf<String>()
        val byId = all.associateBy { it.optString("nodeId") }
        all.filter { inCollection(it, byId) }.forEach { excluded.add(it.optString("nodeId")) }
        val surface = JSONArray(all.filterNot { it.optString("nodeId") in excluded })
        // Empty-to-populated collections count as initialization. Subsequent row
        // refreshes/reorders do not postpone a stable external interaction surface.
        val population = JSONArray(all.filter { it.optString("className") in collections }.map { container ->
            all.any { it.optString("parentId") == container.optString("nodeId") && it.opt("visible") == true }
        })
        val copy = JSONObject().put("packageName", observation.opt("packageName")).put("windowId", observation.opt("windowId"))
            .put("truncated", observation.opt("truncated")).put("nodes", surface)
        return snapshotFingerprintDigest(listOf(ObservationContract.signature(copy), population.toString(), windowGeometry(windowContext)))
    }
    /** Complete private shape/state evidence for a single explicit-label action.
     * Unlike interaction readiness, it retains every collection row. Only label
     * content is normalized; label presence, protected context, native ancestry,
     * drawing order and unclipped resource/class identity remain significant.
     */
    fun authorizationSignature(observation: JSONObject, windowContext: RawSwipeWindowPolicy.Context? = null): String {
        val all = nodes(observation)
        val normalized = JSONArray(all.map { node -> JSONObject().also { copy ->
            node.keys().forEach { key -> copy.put(key, if (key == "text" || key == "contentDescription") {
                if (node.optString(key).isEmpty()) "" else "label"
            } else node.get(key)) }
        } })
        val privateEvidence = JSONArray(all.map { node -> JSONArray(listOf(
            node.opt("contextProtected"), node.opt("contextSignature"), node.opt("nativePath"), node.opt("nativeDrawingOrder"),
            node.opt("nativeCollection"), node.opt("nativeCollectionItem"), node.opt("nativeTabRole"),
            node.optJSONObject("nativeFieldSignatures")?.opt("resourceId"), node.optJSONObject("nativeFieldSignatures")?.opt("className"))) })
        val shape = JSONObject().put("packageName", observation.opt("packageName")).put("windowId", observation.opt("windowId"))
            .put("truncated", observation.opt("truncated")).put("nodes", normalized)
        return snapshotFingerprintDigest(listOf(ObservationContract.signature(shape), privateEvidence.toString(), windowGeometry(windowContext)))
    }
    /** Native node coordinates may settle before WindowManager's launch bounds.
     * Observe both in the same existing bounded wait. Missing window metadata
     * remains usable for native node actions, but its appearance/disappearance
     * starts fresh evidence. Event epochs do not claim geometry changed.
     * This private digest is never serialized into the UI or diagnostic logs.
     */
    private fun windowGeometry(context: RawSwipeWindowPolicy.Context?): String = context?.let {
        listOf(it.bounds.left, it.bounds.top, it.bounds.right, it.bounds.bottom,
            it.displayWidth, it.displayHeight, it.rotation).joinToString(",")
    } ?: "window_geometry_unavailable"
    private fun inCollection(node: JSONObject, byId: Map<String, JSONObject>): Boolean {
        var parent = node.opt("parentId") as? String
        val seen = mutableSetOf<String>()
        while (parent != null && seen.add(parent)) {
            val value = byId[parent] ?: return false
            if (value.optString("className") in collections) return true
            parent = value.opt("parentId") as? String
        }
        return false
    }
    private fun nodes(value: JSONObject) = value.optJSONArray("nodes")?.let { array ->
        (0 until array.length()).mapNotNull(array::optJSONObject)
    } ?: emptyList()
}
