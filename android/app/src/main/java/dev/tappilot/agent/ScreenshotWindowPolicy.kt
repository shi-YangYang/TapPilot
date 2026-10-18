package dev.tappilot.agent

/** Display captures require trusted cropping; native captures isolate the app window. */
internal object ScreenshotWindowPolicy {
    enum class Mode { LEGACY_DISPLAY, NATIVE_WINDOW }
    data class Box(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        val width get() = right - left
        val height get() = bottom - top
        fun overlaps(other: Box) = left < other.right && right > other.left && top < other.bottom && bottom > other.top
    }
    data class Overlay(val box: Box, val trustedSystemUi: Boolean, val isSystem: Boolean, val active: Boolean, val focused: Boolean)

    fun contentRegion(display: Box, app: Box, overlays: List<Overlay>, mode: Mode = Mode.LEGACY_DISPLAY): Box {
        if (display.width <= 0 || display.height <= 0 || app.width <= 0 || app.height <= 0)
            throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "截图窗口区域无效")
        var result = app
        val thickness = minOf(display.width, display.height) / 8
        for (overlay in overlays) {
            val bar = overlay.box
            fun reject(): Nothing = throw AgentError("SCREENSHOT_PROTECTED", "当前页面被其他窗口遮挡，未读取截图", reason = "WINDOW_OBSCURED")
            // A different active/focused window invalidates the target even outside its bounds.
            if (mode == Mode.NATIVE_WINDOW) {
                if (overlay.active || overlay.focused) reject()
                // Android 14+ captures only the selected application window.
                // Other inactive/unfocused windows do not contribute pixels,
                // regardless of their type, owner, size or position. This says
                // nothing about whether a physical gesture can cross them.
                continue
            }
            if (!app.overlaps(bar)) continue
            if (!overlay.isSystem || overlay.active || overlay.focused || bar.width <= 0 || bar.height <= 0) reject()
            if (!overlay.trustedSystemUi) reject()
            result = when {
                bar.left == display.left && bar.right == display.right && bar.height <= thickness && bar.top == display.top ->
                    result.copy(top = maxOf(result.top, bar.bottom))
                bar.left == display.left && bar.right == display.right && bar.height <= thickness && bar.bottom == display.bottom ->
                    result.copy(bottom = minOf(result.bottom, bar.top))
                bar.top == display.top && bar.bottom == display.bottom && bar.width <= thickness && bar.left == display.left ->
                    result.copy(left = maxOf(result.left, bar.right))
                bar.top == display.top && bar.bottom == display.bottom && bar.width <= thickness && bar.right == display.right ->
                    result.copy(right = minOf(result.right, bar.left))
                else -> reject()
            }
            if (result.width <= 0 || result.height <= 0) reject()
        }
        return result
    }

    /** Capture isolation never authorizes a touch through a covering window.
     * The service supplies only windows above the target on the same display.
     * Keep exact point containment and continuous swipe-path intersection.
     */
    fun requireUnobscuredGesture(overlays: List<Box>, segment: VisualTapPolicy.Segment, swipe: Boolean) {
        if (overlays.any { box ->
            if (swipe) segment.intersects(box) else segment.start.x >= box.left && segment.start.x < box.right &&
                segment.start.y >= box.top && segment.start.y < box.bottom
        }) throw AgentError("VISUAL_CONTEXT_CHANGED", "其他窗口覆盖手势路径，未发送手势")
    }

}
