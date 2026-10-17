package dev.tappilot.testbed

import android.app.UiAutomation
import android.content.Intent
import android.database.DataSetObserver
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Tests fixture generation itself. Executor and real-model runs use the same pages separately. */
@RunWith(AndroidJUnit4::class)
class VariantsInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun state() = OracleState.snapshot(context)
    private fun config(scene: String) = JSONObject().put("schemaVersion", 1).put("id", "v1-$scene-17-regression")
        .put("scene", scene).put("seed", 17)
        .put("labels", JSONObject().put("target", "合成目标27").put("decoy", "合成目标270")
            .put("open", "打开目录27").put("search", "查找27").put("save", "保存草稿27")
            .put("dismiss", "关闭浮层27").put("input", "合成输入27").put("recipient", "合成会话甲27"))
        .put("layout", "plain").put("targetIndex", 2).put("itemCount", 3).put("delayMs", 0)
        .put("refreshMs", 80).put("refreshCount", 0).put("refreshMode", "none").put("reverse", false)

    private fun withVariant(scene: String, configuration: JSONObject = config(scene), block: (MainActivity) -> Unit) {
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra("scene", scene).putExtra("seed", 17).putExtra("runId", "22ede683-0e88-4620-a172-20fa57888444")
            .putExtra("variant", configuration.toString())
        val activity = instrumentation.startActivitySync(intent) as MainActivity
        try { instrumentation.waitForIdleSync(); block(activity) }
        finally {
            instrumentation.runOnMainSync { activity.finish() }
            // finish() schedules lifecycle work through the system; an idle main queue alone
            // does not prove onDestroy has removed this fixture's timers.
            awaitCondition("fixture Activity was not destroyed") {
                var destroyed = false
                instrumentation.runOnMainSync { destroyed = activity.isDestroyed }
                destroyed
            }
        }
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
        while (!condition() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(25)
        assertTrue(message, condition())
    }
    private fun viewExists(activity: MainActivity, id: Int): Boolean {
        var exists = false
        instrumentation.runOnMainSync { exists = activity.findViewById<View>(id) != null }
        return exists
    }
    private fun allText(view: View): List<String> = buildList {
        if (view is TextView) add(view.text.toString())
        if (view is ViewGroup) for (index in 0 until view.childCount) addAll(allText(view.getChildAt(index)))
    }
    private fun assertCompleted(target: String, page: String) {
        val result = state()
        assertTrue(result.toString(), result.getBoolean("completed"))
        assertEquals(target, result.getString("lastTarget"))
        assertEquals(page, result.getString("page"))
        assertEquals(0, result.getInt("wrongClicks"))
    }

    @Test fun strictConfigurationRejectsInvalidIdentityBoundsAndUnknownFields() {
        val invalid = listOf(
            config("navigation").put("schemaVersion", 2),
            config("navigation").put("seed", 18),
            config("navigation").put("id", "not an id"),
            config("navigation").put("itemCount", 81),
            config("navigation").put("targetIndex", 4),
            config("navigation").put("delayMs", 1201),
            config("navigation").put("refreshMs", 79),
            config("navigation").put("refreshCount", 601),
            config("navigation").put("layout", "unknown"),
            config("navigation").put("reverse", "true"),
            config("navigation").put("extra", true),
            config("navigation").apply { getJSONObject("labels").put("input", "合成\n换行") },
        )
        invalid.forEach { value ->
            try { ScenarioVariant.parse(value.toString(), "navigation", 17); fail("accepted invalid configuration") }
            catch (_: IllegalArgumentException) { /* bounded parser rejects it */ }
        }
        assertEquals("v1-navigation-17-regression", ScenarioVariant.parse(config("navigation").toString(), "navigation", 17).id)
    }

    @Test fun invalidConfigurationFailsExplicitlyInsteadOfRunningLegacyScene() =
        withVariant("navigation", config("navigation").put("targetIndex", 99)) { activity ->
            assertEquals("configuration_error", state().getString("page"))
            assertTrue(state().getBoolean("configurationError"))
            assertFalse(viewExists(activity, R.id.navigation_open))
            assertFalse(state().getBoolean("completed"))
        }

    @Test fun navigationUsesChangedLabelsParentClickAndReversedOrder() =
        withVariant("navigation", config("navigation").put("layout", "parent_label").put("reverse", true).put("targetIndex", 1).put("delayMs", 200)) { activity ->
            assertEquals("v1-navigation-17-regression", state().getString("variantId"))
            instrumentation.runOnMainSync {
                val open = activity.findViewById<View>(R.id.navigation_open)
                assertTrue(open.performClick())
                assertFalse(open.isEnabled)
            }
            awaitCondition("delayed directory target missing") { viewExists(activity, R.id.navigation_target) }
            instrumentation.runOnMainSync {
                val target = activity.findViewById<ViewGroup>(R.id.navigation_target)
                assertTrue(target.isClickable)
                assertFalse(target.getChildAt(0).isClickable)
                assertEquals(listOf("合成目标27"), allText(target))
                val siblings = target.parent as ViewGroup
                assertEquals(siblings.childCount - 1, siblings.indexOfChild(target))
            }
            click(activity, R.id.navigation_target)
            assertCompleted("battery", "battery")
            instrumentation.runOnMainSync { assertTrue(allText(activity.window.decorView).contains("合成任务已完成")) }
        }

    @Test fun searchUsesVariableInputAndDelayedResultsWithoutSavingRawText() =
        withVariant("search", config("search").put("delayMs", 300)) { activity ->
            type(activity, R.id.search_input, "合成输入27")
            assertEquals("expected", state().getString("receivedInput"))
            assertFalse(state().toString().contains("合成输入27"))
            click(activity, R.id.search_go)
            assertEquals("results", state().getString("page"))
            awaitCondition("delayed result missing") { viewExists(activity, R.id.search_result) }
            instrumentation.runOnMainSync { assertEquals(listOf("查看合成目标27"), allText(activity.findViewById(R.id.search_result))) }
            click(activity, R.id.search_result)
            assertCompleted("search_result", "battery")
        }

    @Test fun peerRefreshChangesRealListLeavesWithoutReplacingTheTargetView() =
        withVariant("async_list", config("async_list").put("refreshMode", "peer_text").put("refreshCount", 8).put("refreshMs", 200)) { activity ->
            awaitCondition("target not laid out") { viewExists(activity, R.id.async_target) }
            lateinit var target: View
            instrumentation.runOnMainSync { target = activity.findViewById(R.id.async_target) }
            awaitCondition("peer refresh did not run") { state().getInt("refreshCount") >= 2 }
            instrumentation.runOnMainSync {
                assertSame(target, activity.findViewById(R.id.async_target))
                assertTrue(activity.findViewById<View>(R.id.variant_list) is ListView)
                assertTrue(allText(activity.window.decorView).any { it.startsWith("合成变化 ") && it != "合成变化 0" })
            }
            assertFalse(state().getBoolean("completed"))
            click(activity, R.id.async_target)
            assertCompleted("async_B", "detail_b")
        }

    @Test fun replacingListRowsRecordsRealAttachmentAndStopsAfterCompletion() =
        withVariant("async_list", config("async_list").put("refreshMode", "replace").put("refreshCount", 300).put("refreshMs", 400)) { activity ->
            awaitCondition("initial target missing") { viewExists(activity, R.id.async_target) }
            lateinit var before: View
            var initialReplacements = 0
            instrumentation.runOnMainSync {
                before = activity.findViewById(R.id.async_target)
                initialReplacements = state().getInt("replacementCount")
            }
            awaitCondition("replacement was not attached") { state().getInt("replacementCount") > initialReplacements && viewExists(activity, R.id.async_target) }
            instrumentation.runOnMainSync { assertNotSame(before, activity.findViewById(R.id.async_target)) }
            click(activity, R.id.async_target)
            assertCompleted("async_B", "detail_b")
            val completedState = state()
            SystemClock.sleep(500)
            assertEquals(completedState.getInt("refreshCount"), state().getInt("refreshCount"))
            assertEquals(completedState.getInt("replacementCount"), state().getInt("replacementCount"))
        }

    @Test fun reorderingChangesActualAdapterOrderAndStopsOnActivityDestruction() {
        withVariant("async_list", config("async_list").put("refreshMode", "reorder").put("refreshCount", 300).put("refreshMs", 200)) { activity ->
            val orders = mutableListOf<List<Any>>()
            var initialChanges = 0
            instrumentation.runOnMainSync {
                val adapter = activity.findViewById<ListView>(R.id.variant_list).adapter
                fun capture() = (0 until adapter.count).map { adapter.getItem(it) }
                initialChanges = state().getInt("orderChangeCount")
                orders.add(capture())
                adapter.registerDataSetObserver(object : DataSetObserver() {
                    override fun onChanged() { orders.add(capture()) }
                })
            }
            awaitCondition("real list order never changed") { state().getInt("orderChangeCount") >= initialChanges + 2 }
            instrumentation.runOnMainSync {
                assertTrue(orders.size >= 3)
                assertTrue(orders.zipWithNext().all { (before, after) -> before != after })
                assertEquals(orders.size - 1, state().getInt("orderChangeCount") - initialChanges)
            }
            assertFalse(state().getBoolean("completed"))
        }
        val destroyedState = state()
        SystemClock.sleep(500)
        assertEquals(destroyedState.getInt("refreshCount"), state().getInt("refreshCount"))
        assertEquals(destroyedState.getInt("orderChangeCount"), state().getInt("orderChangeCount"))
    }

    @Test fun imeUsesVariableRecipientAndRefusesSavingAfterRecipientChanges() = withVariant("ime") { activity ->
        instrumentation.runOnMainSync { assertTrue(allText(activity.window.decorView).contains("合成会话甲27")) }
        type(activity, R.id.ime_input, "不应保存的合成原文")
        assertEquals("other", state().getString("receivedInput"))
        assertFalse(state().toString().contains("不应保存"))
        type(activity, R.id.ime_input, "合成输入27")
        click(activity, R.id.ime_switch)
        click(activity, R.id.ime_save)
        assertEquals("synthetic_b", state().getString("recipient"))
        assertFalse(state().getBoolean("completed"))
        assertEquals(2, state().getInt("wrongClicks"))
    }

    @Test fun overlayRequiresTheVariableDismissButtonBeforeCompleting() = withVariant("overlay") { activity ->
        var close: AccessibilityNodeInfo? = null
        awaitCondition("variant dialog button missing") {
            close = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
                .rootInActiveWindow?.findAccessibilityNodeInfosByText("关闭浮层27")?.firstOrNull()
            close != null
        }
        assertTrue(close!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        instrumentation.waitForIdleSync()
        assertTrue(state().getBoolean("overlayDismissed"))
        click(activity, R.id.overlay_target)
        assertCompleted("overlay_target", "target")
    }

    @Test fun longListMovesTheTargetAwayFromTheLegacyIndexWhileKeepingSemanticOracle() =
        withVariant("long_list", config("long_list").put("itemCount", 70).put("targetIndex", 63).put("layout", "compact")) { activity ->
            assertFalse(viewExists(activity, R.id.long_target))
            instrumentation.runOnMainSync {
                val list = activity.findViewById<ListView>(R.id.variant_list)
                assertEquals(70, list.adapter.count)
                list.setSelection(62)
            }
            awaitCondition("target did not become visible") { viewExists(activity, R.id.long_target) }
            instrumentation.runOnMainSync { assertEquals(listOf("合成目标27"), allText(activity.findViewById(R.id.long_target))) }
            click(activity, R.id.long_target)
            assertCompleted("item_42", "item_42")
        }

    @Test fun webViewUsesParameterizedLocalFormAndIndependentInputResult() = withVariant("webview") { activity ->
        val ready = CountDownLatch(1)
        awaitCondition("local variant WebView did not load") {
            instrumentation.runOnMainSync {
                activity.findViewById<WebView>(R.id.web_content).evaluateJavascript("Boolean(document.getElementById('synthetic'))") {
                    if (it == "true") ready.countDown()
                }
            }
            ready.await(30, TimeUnit.MILLISECONDS)
        }
        instrumentation.runOnMainSync {
            activity.findViewById<WebView>(R.id.web_content).evaluateJavascript(
                "document.getElementById('synthetic').value='合成输入27';document.getElementById('save').click()", null)
        }
        awaitCondition("variant web save did not reach oracle") { state().optBoolean("completed") }
        assertCompleted("web_save", "web_saved")
        assertEquals("expected", state().getString("receivedInput"))
        assertFalse(state().toString().contains("合成输入27"))
    }

    @Test fun canvasPositionChangesWithoutAddingAnAccessibleTarget() =
        withVariant("canvas", config("canvas").put("reverse", true).put("targetIndex", 3)) { activity ->
            instrumentation.runOnMainSync {
                val canvas = activity.findViewById<View>(R.id.canvas_content)
                assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO, canvas.importantForAccessibility)
                assertNull(canvas.contentDescription)
                val time = SystemClock.uptimeMillis()
                for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                    val event = MotionEvent.obtain(time, time + action, action, canvas.width * 0.68f, canvas.height * 0.7f, 0)
                    try { assertTrue(canvas.dispatchTouchEvent(event)) } finally { event.recycle() }
                }
            }
            assertCompleted("canvas_circle", "canvas_selected")
        }
}
