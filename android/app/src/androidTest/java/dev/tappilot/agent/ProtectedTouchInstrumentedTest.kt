package dev.tappilot.agent

import android.content.Intent
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeFalse
import org.junit.Test
import org.junit.runner.RunWith

/** Exercise the window's touch path: performClick() bypasses the protected-touch guard. */
@RunWith(AndroidJUnit4::class)
class ProtectedTouchInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val obscuredFlags = listOf(
        MotionEvent.FLAG_WINDOW_IS_OBSCURED,
        MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED
    )

    @Test fun ordinaryTouchesSwitchConnectionTabs() = withActivity { activity ->
        tap(activity, R.id.connection_usb)
        assertSelected(activity, R.id.connection_usb)
        tap(activity, R.id.connection_wireless)
        assertSelected(activity, R.id.connection_wireless)
    }

    @Test fun fullAndPartialObscurationBlockTouchesWithoutBlockingTheNextCleanGesture() = withActivity { activity ->
        for (flags in obscuredFlags) {
            tap(activity, R.id.connection_usb, flags)
            assertSelected(activity, R.id.connection_wireless)
            assertNotPressed(activity, R.id.connection_usb)
            tap(activity, R.id.connection_usb)
            assertSelected(activity, R.id.connection_usb)
            tap(activity, R.id.connection_wireless)
            assertSelected(activity, R.id.connection_wireless)
        }
    }

    @Test fun obscurationDuringAnExistingGestureCancelsItEvenWhenTheReleaseIsClean() = withActivity { activity ->
        for (flags in obscuredFlags) {
            gesture(activity, R.id.connection_usb, listOf(
                MotionEvent.ACTION_DOWN to 0,
                MotionEvent.ACTION_MOVE to flags,
                MotionEvent.ACTION_UP to 0
            ))
            assertSelected(activity, R.id.connection_wireless)
            assertNotPressed(activity, R.id.connection_usb)
            tap(activity, R.id.connection_usb)
            assertSelected(activity, R.id.connection_usb)
            tap(activity, R.id.connection_wireless)
            assertSelected(activity, R.id.connection_wireless)
        }
    }

    @Test fun obscurationOnReleaseDoesNotClickThePressedTab() = withActivity { activity ->
        for (flags in obscuredFlags) {
            gesture(activity, R.id.connection_usb, listOf(
                MotionEvent.ACTION_DOWN to 0,
                MotionEvent.ACTION_UP to flags
            ))
            assertSelected(activity, R.id.connection_wireless)
            assertNotPressed(activity, R.id.connection_usb)
        }
        tap(activity, R.id.connection_usb)
        assertSelected(activity, R.id.connection_usb)
    }

    @Test fun repeatedBlockedGesturesExplainTheBlockWithoutFloodingNotices() {
        var now = 0L
        var notices = 0
        var contentEvents = 0
        val guard = ProtectedTouchGuard({ notices++ }, { now })
        fun blockedGesture() {
            for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                val event = touch(now, action, MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED, 10f, 10f)
                try { assertTrue(guard.dispatch(event) { contentEvents++; true }) }
                finally { event.recycle() }
            }
        }
        blockedGesture()
        assertEquals(1, notices)
        now = 2_999L
        blockedGesture()
        assertEquals(1, notices)
        now = 3_000L
        blockedGesture()
        assertEquals(2, notices)
        assertEquals(0, contentEvents)
    }

    private fun withActivity(check: (MainActivity) -> Unit) {
        // Never disconnect or substitute an actual wireless session to run a UI regression.
        assumeFalse("Run this test without an active wireless connection", WirelessState.value.connecting || WirelessState.value.connected)
        val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        try {
            instrumentation.waitForIdleSync()
            assertSelected(activity, R.id.connection_wireless)
            check(activity)
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            instrumentation.waitForIdleSync()
        }
    }

    private fun tap(activity: MainActivity, id: Int, flags: Int = 0) = gesture(activity, id, listOf(
        MotionEvent.ACTION_DOWN to flags,
        MotionEvent.ACTION_UP to flags
    ))

    private fun gesture(activity: MainActivity, id: Int, events: List<Pair<Int, Int>>) {
        instrumentation.runOnMainSync {
            val target = activity.findViewById<View>(id)
            assertTrue("Tab must be visible and enabled before dispatch", target.isShown && target.isEnabled)
            assertTrue("Tab must be laid out before dispatch", target.width > 0 && target.height > 0)
            val location = IntArray(2)
            target.getLocationInWindow(location)
            val x = location[0] + target.width / 2f
            val y = location[1] + target.height / 2f
            val downTime = SystemClock.uptimeMillis()
            for ((action, flags) in events) {
                val event = touch(downTime, action, flags, x, y)
                try { activity.dispatchTouchEvent(event) }
                finally { event.recycle() }
            }
        }
        // View may post its click callback after ACTION_UP.
        instrumentation.waitForIdleSync()
    }

    private fun assertSelected(activity: MainActivity, selectedId: Int) {
        instrumentation.runOnMainSync {
            for (id in listOf(R.id.connection_wireless, R.id.connection_usb)) {
                assertEquals("Unexpected selected connection tab", id == selectedId, activity.findViewById<View>(id).isSelected)
            }
        }
    }

    private fun assertNotPressed(activity: MainActivity, id: Int) {
        instrumentation.runOnMainSync { assertFalse("Cancelled tab retained pressed state", activity.findViewById<View>(id).isPressed) }
    }

    private fun touch(downTime: Long, action: Int, flags: Int, x: Float, y: Float): MotionEvent {
        val pointer = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
        val coordinates = MotionEvent.PointerCoords().apply { this.x = x; this.y = y; pressure = 1f; size = 1f }
        return MotionEvent.obtain(downTime, maxOf(downTime, SystemClock.uptimeMillis()), action, 1,
            arrayOf(pointer), arrayOf(coordinates), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, flags)
    }
}
