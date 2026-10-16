package dev.tappilot.testbed

import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import android.widget.EditText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Fixture contract tests; production TapPilot end-to-end runs are separate. */
@RunWith(AndroidJUnit4::class)
class ScenesInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun state() = OracleState.snapshot(context)
    private fun withScene(scene: String, block: (MainActivity) -> Unit) {
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra("scene", scene).putExtra("seed", 17).putExtra("runId", "9fa4e6a0-8458-4c65-a65c-9c1df871c111")
        val activity = instrumentation.startActivitySync(intent) as MainActivity
        try { instrumentation.waitForIdleSync(); block(activity) }
        finally { instrumentation.runOnMainSync { activity.finish() }; instrumentation.waitForIdleSync() }
    }
    private fun click(activity: MainActivity, id: Int) {
        instrumentation.runOnMainSync { assertTrue(activity.findViewById<View>(id).performClick()) }
        instrumentation.waitForIdleSync()
    }
    private fun type(activity: MainActivity, id: Int, value: String) {
        instrumentation.runOnMainSync { activity.findViewById<EditText>(id).setText(value) }
    }
    private fun awaitCondition(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (!condition() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(30)
        assertTrue(message, condition())
    }
    private fun assertCompleted(target: String, page: String) {
        val value = state()
        assertTrue(value.toString(), value.getBoolean("completed"))
        assertEquals(target, value.getString("lastTarget"))
        assertEquals(page, value.getString("page"))
        assertEquals(0, value.getInt("wrongClicks"))
    }

    @Test fun navigationRequiresBothPageTransitions() = withScene("navigation") { activity ->
        assertFalse(state().getBoolean("completed"))
        click(activity, R.id.navigation_open)
        assertEquals("directory", state().getString("page"))
        assertFalse(state().getBoolean("completed"))
        click(activity, R.id.navigation_target)
        assertCompleted("battery", "battery")
    }

    @Test fun searchUsesActualChineseInputAndResultSelection() = withScene("search") { activity ->
        type(activity, R.id.search_input, "合成电池")
        assertEquals("expected", state().getString("receivedInput"))
        click(activity, R.id.search_go)
        assertEquals("results", state().getString("page"))
        click(activity, R.id.search_result)
        assertCompleted("search_result", "battery")
    }

    @Test fun asyncRefreshDoesNotAwardSuccessBeforeTargetHandlerRuns() = withScene("async_list") { activity ->
        awaitCondition("asynchronous list never refreshed") { state().getInt("refreshCount") > 0 }
        assertFalse(state().getBoolean("completed"))
        click(activity, R.id.async_target)
        assertCompleted("async_B", "detail_b")
    }

    @Test fun imeRecordsRealFocusAndDraftWithoutPersistingInputText() = withScene("ime") { activity ->
        click(activity, R.id.ime_focus)
        assertEquals("draft", state().getString("focus"))
        type(activity, R.id.ime_input, "不应被持久化的合成测试文字")
        assertEquals("other", state().getString("receivedInput"))
        assertFalse(state().toString().contains("不应被持久化"))
        type(activity, R.id.ime_input, "合成输入")
        click(activity, R.id.ime_save)
        assertCompleted("save_draft", "draft_saved")
    }

    @Test fun changedConversationCannotPassTheDraftOracle() = withScene("ime") { activity ->
        type(activity, R.id.ime_input, "合成输入")
        click(activity, R.id.ime_switch)
        click(activity, R.id.ime_save)
        assertFalse(state().getBoolean("completed"))
        assertEquals("synthetic_b", state().getString("recipient"))
        assertEquals(1, state().getInt("wrongClicks"))
    }

    @Test fun overlayMustBeDismissedBeforeTheUnderlyingTarget() = withScene("overlay") { activity ->
        assertFalse(state().getBoolean("overlayDismissed"))
        // Dialog lives in a separate window; this is a real accessibility action on the fixture.
        var closeButton: AccessibilityNodeInfo? = null
        awaitCondition("dialog close button missing") {
            closeButton = instrumentation.uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText("关闭浮层")?.firstOrNull()
            closeButton != null
        }
        assertTrue(closeButton!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        instrumentation.waitForIdleSync()
        assertTrue(state().getBoolean("overlayDismissed"))
        click(activity, R.id.overlay_target)
        assertCompleted("overlay_target", "target")
    }

    @Test fun longListHasAnInitiallyOffscreenTargetAndIndependentSelection() = withScene("long_list") { activity ->
        instrumentation.runOnMainSync {
            val target = activity.findViewById<View>(R.id.long_target)
            assertFalse(target.getGlobalVisibleRect(android.graphics.Rect()))
            target.requestRectangleOnScreen(android.graphics.Rect(0, 0, target.width, target.height), true)
        }
        instrumentation.waitForIdleSync()
        instrumentation.runOnMainSync {
            assertTrue(activity.findViewById<View>(R.id.long_target).getGlobalVisibleRect(android.graphics.Rect()))
        }
        click(activity, R.id.long_target)
        assertCompleted("item_42", "item_42")
    }

    @Test fun webViewAcceptsOnlySyntheticFormContent() = withScene("webview") { activity ->
        val pageReady = CountDownLatch(1)
        fun checkReady() {
            instrumentation.runOnMainSync {
                activity.findViewById<WebView>(R.id.web_content).evaluateJavascript("Boolean(document.getElementById('synthetic'))") {
                    if (it == "true") pageReady.countDown()
                }
            }
        }
        awaitCondition("local WebView did not load") { checkReady(); pageReady.await(40, TimeUnit.MILLISECONDS) }
        instrumentation.runOnMainSync {
            activity.findViewById<WebView>(R.id.web_content).evaluateJavascript(
                "document.getElementById('synthetic').value='合成网页';document.querySelector('button').click()", null)
        }
        awaitCondition("WebView event did not reach business state") { state().optBoolean("completed") }
        assertCompleted("web_save", "web_saved")
        assertEquals("expected", state().getString("receivedInput"))
    }

    @Test fun canvasHasNoAccessibleTargetAndRecordsRealTouchHit() = withScene("canvas") { activity ->
        instrumentation.runOnMainSync {
            val canvas = activity.findViewById<View>(R.id.canvas_content)
            assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO, canvas.importantForAccessibility)
            assertNull(canvas.contentDescription)
            val now = SystemClock.uptimeMillis()
            for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                val event = MotionEvent.obtain(now, now + action, action, canvas.width / 2f, canvas.height / 2f, 0)
                try { assertTrue(canvas.dispatchTouchEvent(event)) } finally { event.recycle() }
            }
        }
        assertCompleted("canvas_circle", "canvas_selected")
    }

    @Test fun oracleProviderIsReadOnlyAndResetClearsPreviousSuccess() {
        withScene("navigation") { activity -> click(activity, R.id.navigation_open); click(activity, R.id.navigation_target) }
        withScene("search") {
            val uri = Uri.parse("content://dev.tappilot.testbed.oracle/state")
            context.contentResolver.query(uri, null, null, null, null)!!.use { cursor ->
                assertTrue(cursor.moveToFirst())
                val value = org.json.JSONObject(cursor.getString(0))
                assertEquals("search", value.getString("scene"))
                assertEquals("9fa4e6a0-8458-4c65-a65c-9c1df871c111", value.getString("runId"))
                assertFalse(value.getBoolean("completed"))
                assertEquals(0, value.getInt("wrongClicks"))
            }
            try { context.contentResolver.delete(uri, null, null); fail("oracle accepted mutation") }
            catch (_: UnsupportedOperationException) { /* expected */ }
            val provider = context.packageManager.resolveContentProvider("dev.tappilot.testbed.oracle", 0)!!
            assertFalse(provider.exported)
            assertFalse(provider.grantUriPermissions)
        }
    }
}
