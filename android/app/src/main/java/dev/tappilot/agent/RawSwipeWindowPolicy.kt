package dev.tappilot.agent

/** Private window facts for a raw coordinate reference. No UI content or native
 * window object is retained, and none of this evidence is sent to the model. */
internal object RawSwipeWindowPolicy {
    data class Rect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        val valid get() = left < right && top < bottom
        fun overlaps(other: Rect) = valid && other.valid && left < other.right && right > other.left && top < other.bottom && bottom > other.top
    }
    data class Window(val id: Int, val type: Int, val displayId: Int, val layer: Int,
                      val active: Boolean, val focused: Boolean, val bounds: Rect)
    data class Identity(val id: Int, val type: Int)
    data class Activation(val session: String, val displayId: Int, val active: List<Identity>, val focused: List<Identity>)
    data class Context(val activation: Activation, val packageName: String, val windowId: Int,
                       val bounds: Rect, val displayWidth: Int, val displayHeight: Int, val rotation: Int)
    data class Stamp(val context: Context, val activationEpoch: Long)

    fun activation(session: String, displayId: Int, windows: List<Window>): Activation? {
        val current = windows.filter { it.displayId == displayId }
        if (current.count { it.active } != 1 || current.map { it.id }.toSet().size != current.size) return null
        fun identities(predicate: (Window) -> Boolean) = current.filter(predicate).sortedBy { it.id }.map { Identity(it.id, it.type) }
        return Activation(session, displayId, identities { it.active }, identities { it.focused })
    }

    fun context(session: String, packageName: String, windowId: Int, displayId: Int,
                displayWidth: Int, displayHeight: Int, rotation: Int, windows: List<Window>): Context? {
        val activation = activation(session, displayId, windows) ?: return null
        val target = windows.singleOrNull { it.id == windowId && it.displayId == displayId && it.active } ?: return null
        if (packageName.isBlank() || !target.bounds.valid || displayWidth <= 0 || displayHeight <= 0) return null
        return Context(activation, packageName, windowId, target.bounds, displayWidth, displayHeight, rotation)
    }

    fun requireSame(reference: Stamp?, current: Stamp?) {
        if (reference == null || current == null || reference != current) throw staleSnapshot(SnapshotStaleReason.WINDOW_CHANGED)
    }

    /** Debug-only callers may log comparison facts, never either window's identity or geometry. */
    fun comparisonDiagnostic(reference: Stamp?, current: Stamp?, rootBounds: Rect? = null): String {
        val difference = when {
            reference == null -> "reference_missing"
            current == null -> "current_missing"
            reference.context.activation != current.context.activation -> "activation"
            reference.context != current.context -> "context"
            reference.activationEpoch != current.activationEpoch -> "epoch"
            else -> "none"
        }
        val comparable = reference != null && current != null
        return "difference=$difference referencePresent=${reference != null} currentPresent=${current != null}" +
            " activationEqual=${comparable && reference!!.context.activation == current!!.context.activation}" +
            " contextEqual=${comparable && reference!!.context == current!!.context}" +
            " epochEqual=${comparable && reference!!.activationEpoch == current!!.activationEpoch}" +
            " packageEqual=${comparable && reference!!.context.packageName == current!!.context.packageName}" +
            " windowIdEqual=${comparable && reference!!.context.windowId == current!!.context.windowId}" +
            " boundsEqual=${comparable && reference!!.context.bounds == current!!.context.bounds}" +
            " displaySizeEqual=${comparable && reference!!.context.displayWidth == current!!.context.displayWidth && reference!!.context.displayHeight == current!!.context.displayHeight}" +
            " rotationEqual=${comparable && reference!!.context.rotation == current!!.context.rotation}" +
            " rootBoundsKnown=${rootBounds != null} referenceContainsRoot=${containsVisibleRoot(reference?.context, rootBounds)}" +
            " currentContainsRoot=${containsVisibleRoot(current?.context, rootBounds)}"
    }

    private fun containsVisibleRoot(context: Context?, rootBounds: Rect?): Boolean {
        if (context == null || rootBounds == null) return false
        val visible = Rect(maxOf(0, rootBounds.left), maxOf(0, rootBounds.top),
            minOf(context.displayWidth, rootBounds.right), minOf(context.displayHeight, rootBounds.bottom))
        return visible.valid && context.bounds.left <= visible.left && context.bounds.top <= visible.top &&
            context.bounds.right >= visible.right && context.bounds.bottom >= visible.bottom
    }

    /** An inactive overlay need not change the activation epoch, but it can
     * still intercept a touch. Re-evaluate the current stack at dispatch. */
    fun requireUnobscured(context: Context, windows: List<Window>, region: Rect) {
        val target = windows.singleOrNull { it.id == context.windowId && it.displayId == context.activation.displayId && it.active }
            ?: throw staleSnapshot(SnapshotStaleReason.WINDOW_CHANGED)
        val allowed = Rect(maxOf(0, context.bounds.left), maxOf(0, context.bounds.top),
            minOf(context.displayWidth, context.bounds.right), minOf(context.displayHeight, context.bounds.bottom))
        if (!region.valid || !allowed.valid || region.left < allowed.left || region.top < allowed.top ||
            region.right > allowed.right || region.bottom > allowed.bottom)
            throw AgentError("NODE_NOT_ACTIONABLE", "The gesture leaves the observed window or display. No action was sent.", false, "TARGET_CLIPPED")
        if (windows.any { it.id != target.id && it.displayId == target.displayId &&
                it.layer > target.layer && region.overlaps(it.bounds) })
            throw AgentError("NODE_NOT_ACTIONABLE", "Another window covers the selected target. No action was sent.", false, "WINDOW_OBSCURED")
    }
}

/** Main-looper ordered observations. A→B→A changes the epoch even when the
 * eventual window facts match; explicit activation/focus events also revoke
 * references when callback delivery has coalesced the intermediate sample. */
internal class RawSwipeWindowTracker {
    private var last: RawSwipeWindowPolicy.Activation? = null
    private var epoch = 0L
    val currentEpoch: Long get() = epoch
    fun observe(activation: RawSwipeWindowPolicy.Activation?, explicitTransition: Boolean = false): Long {
        if (explicitTransition || activation == null || last != null && activation != last) epoch++
        last = activation
        return epoch
    }
    fun capture(context: RawSwipeWindowPolicy.Context?): RawSwipeWindowPolicy.Stamp? {
        val capturedEpoch = observe(context?.activation)
        return context?.let { RawSwipeWindowPolicy.Stamp(it, capturedEpoch) }
    }
    fun reset() { last = null; epoch++ }
}
