package dev.tappilot.agent

import android.os.Build
import android.os.SystemClock
import android.view.MotionEvent
import android.view.Window
import android.widget.Toast

/** Keep the protected controls usable without accepting touches delivered through another app. */
internal class ProtectedTouchGuard(
    private val onBlocked: () -> Unit,
    private val now: () -> Long = SystemClock::elapsedRealtime
) {
    private var blockedGesture = false
    private var dispatchedDown = false
    private var lastNoticeAt: Long? = null

    fun dispatch(event: MotionEvent, dispatchToContent: (MotionEvent) -> Boolean): Boolean {
        val action = event.actionMasked
        if (action == MotionEvent.ACTION_DOWN) {
            blockedGesture = false
            dispatchedDown = false
        }
        val obscured = event.flags and (
            MotionEvent.FLAG_WINDOW_IS_OBSCURED or MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED
        ) != 0
        if (obscured && !blockedGesture) {
            blockedGesture = true
            if (dispatchedDown) {
                val cancel = cancellation(event)
                try { dispatchToContent(cancel) } finally { cancel.recycle() }
                dispatchedDown = false
            }
            if (action == MotionEvent.ACTION_DOWN) {
                val current = now()
                val previous = lastNoticeAt
                if (previous == null || current - previous >= NOTICE_INTERVAL_MS) {
                    lastNoticeAt = current
                    onBlocked()
                }
            }
        }
        if (blockedGesture) {
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                blockedGesture = false
                dispatchedDown = false
            }
            return true
        }
        if (action == MotionEvent.ACTION_DOWN) dispatchedDown = true
        val handled = dispatchToContent(event)
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) dispatchedDown = false
        return handled
    }

    private fun cancellation(event: MotionEvent): MotionEvent {
        val properties = Array(event.pointerCount) { index ->
            MotionEvent.PointerProperties().also { event.getPointerProperties(index, it) }
        }
        val coordinates = Array(event.pointerCount) { index ->
            MotionEvent.PointerCoords().also { event.getPointerCoords(index, it) }
        }
        // Only a cancellation loses the flags: View's own obscured-touch filter must not
        // swallow it and leave a previously pressed control active. No click is dispatched.
        return MotionEvent.obtain(
            event.downTime, event.eventTime, MotionEvent.ACTION_CANCEL, event.pointerCount,
            properties, coordinates, event.metaState, event.buttonState, event.xPrecision,
            event.yPrecision, event.deviceId, event.edgeFlags, event.source, 0
        )
    }

    companion object {
        private const val NOTICE_INTERVAL_MS = 3_000L

        fun forWindow(window: Window): ProtectedTouchGuard {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) window.setHideOverlayWindows(true)
            return ProtectedTouchGuard({
                Toast.makeText(window.context, "请先关闭悬浮窗，再操作 TapPilot", Toast.LENGTH_SHORT).show()
            })
        }
    }
}
