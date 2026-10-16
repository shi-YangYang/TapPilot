package dev.tappilot.agent

import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.widget.EditText
import android.widget.TextView
import android.view.View
import android.view.ViewGroup
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ClientInstrumentedTest {
    @Test fun clientLaunchesWithTaskEntryAndStartControl() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                val input = activity.findViewById<EditText>(R.id.task_input)
                assertNotNull(input)
                assertNotNull(activity.findViewById(R.id.task_start))
                assertFalse(input.isSaveEnabled)
                assertTrue(input.width > 0)
            }
            fun findLabel(view: View, label: String): View? {
                if (view is TextView && view.text.toString() == label) return view
                if (view is ViewGroup) for (i in 0 until view.childCount) findLabel(view.getChildAt(i), label)?.let { return it }
                return null
            }
            val pages = listOf(
                "任务" to listOf(R.id.task_input, R.id.task_start, R.id.task_status),
                "模型" to listOf(R.id.model_url, R.id.model_name, R.id.model_key, R.id.model_save, R.id.model_test),
                "设备" to listOf(R.id.wireless_scan, R.id.wireless_pairing, R.id.wireless_connect, R.id.wireless_status)
            )
            for ((page, controls) in pages) {
                instrumentation.runOnMainSync { findLabel(activity.window.decorView, page)!!.performClick() }
                instrumentation.waitForIdleSync()
                instrumentation.runOnMainSync {
                    val viewport = Rect()
                    assertTrue(activity.window.decorView.getGlobalVisibleRect(viewport))
                    fun checkHorizontalBounds(view: View) {
                        if (view.visibility != View.VISIBLE) return
                        val position = IntArray(2)
                        view.getLocationOnScreen(position)
                        assertTrue("$page: control extends beyond left edge", position[0] >= viewport.left)
                        assertTrue("$page: control extends beyond right edge", position[0] + view.width <= viewport.right)
                        if (view is ViewGroup) for (i in 0 until view.childCount) checkHorizontalBounds(view.getChildAt(i))
                    }
                    checkHorizontalBounds(activity.findViewById(android.R.id.content))
                }
                for (id in controls) {
                    instrumentation.runOnMainSync {
                        val control = activity.findViewById<View>(id)
                        assertNotNull(control)
                        control.requestRectangleOnScreen(Rect(0, 0, control.width, control.height), true)
                    }
                    instrumentation.waitForIdleSync()
                    instrumentation.runOnMainSync {
                        val control = activity.findViewById<View>(id)
                        val visible = Rect()
                        assertTrue("$page: control $id is not visible after scrolling", control.getGlobalVisibleRect(visible))
                        assertTrue(control.width > 0 && visible.height() > 0)
                        assertEquals("$page: control $id is clipped horizontally", control.width, visible.width())
                    }
                }
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }
    @Test fun wirelessPageOffersScanPasteAndExplicitConnectWithoutSavingToken() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                fun findLabel(view: View, label: String): View? {
                    if (view is TextView && view.text.toString() == label) return view
                    if (view is ViewGroup) for (i in 0 until view.childCount) findLabel(view.getChildAt(i), label)?.let { return it }
                    return null
                }
                findLabel(activity.window.decorView, "设备")!!.performClick()
                val input = activity.findViewById<EditText>(R.id.wireless_pairing)
                assertNotNull(input); assertFalse(input.isSaveEnabled)
                assertNotNull(activity.findViewById(R.id.wireless_scan))
                assertNotNull(activity.findViewById(R.id.wireless_connect))
                assertNotNull(activity.findViewById(R.id.wireless_status))
                // UI navigation does not start a connection or persist a credential.
                assertFalse(WirelessState.value.connected)
                assertFalse(WirelessState.value.connecting)
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }
    @Test fun keystoreRoundTripStoresOnlyCiphertextAndCanClear() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val namespace = "fixture_model_settings"
        val store = SettingsStore(context, namespace)
        try {
            val fixture = ModelSettings("https://fixture.invalid/v1", "synthetic-fixture-token", "fixture-model")
            store.save(fixture)
            assertEquals(fixture, store.load())
            val stored = context.getSharedPreferences(namespace, Context.MODE_PRIVATE).getString("sealed", "")!!
            assertFalse(stored.contains("synthetic-fixture-token"))
            assertFalse(stored.contains("fixture.invalid"))
            store.clear()
            assertNull(store.load())
        } finally { store.clear() }
    }
    @Test fun nativeCombinedDispatchRejectsUnknownActionBeforeServiceAccess() {
        val service = AgentAccessibilityService()
        try {
            service.dispatch("act_and_observe", JSONObject().put("action", "approve").put("arguments", JSONObject()))
            fail("invalid native action accepted")
        } catch (error: AgentError) { assertEquals("INVALID_ARGUMENT", error.code) }
    }
}
