package dev.tappilot.agent

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.util.TypedValue
import android.view.WindowManager
import android.widget.ScrollView
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
    @Test fun themeSwitchPreservesDraftsAndLiveStateAndOnlyPersistsAppearance() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val appearance = context.getSharedPreferences("appearance", Context.MODE_PRIVATE)
        val previousTheme = if (appearance.contains("dark_theme")) appearance.getBoolean("dark_theme", true) else null
        val settings = context.getSharedPreferences("model_settings", Context.MODE_PRIVATE)
        val previousSettings = settings.all
        val previousTask = TaskState.value
        val previousWireless = WirelessState.value
        appearance.edit().remove("dark_theme").commit()
        fun launch() = instrumentation.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        var activity = launch()
        fun findLabel(view: View, label: String): View? {
            if (view is TextView && view.text.toString() == label) return view
            if (view is ViewGroup) for (i in 0 until view.childCount) findLabel(view.getChildAt(i), label)?.let { return it }
            return null
        }
        fun page(name: String) {
            instrumentation.runOnMainSync { findLabel(activity.window.decorView, name)!!.performClick() }
            instrumentation.waitForIdleSync()
        }
        fun field(id: Int) = activity.findViewById<EditText>(id)
        fun toggle() {
            instrumentation.runOnMainSync { activity.findViewById<View>(R.id.theme_toggle).performClick() }
            instrumentation.waitForIdleSync()
        }
        fun scroller(view: View): ScrollView {
            var parent = view.parent
            while (parent !is ScrollView) parent = parent.parent
            return parent
        }
        fun assertTheme(light: Boolean) {
            val root = activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0)
            assertEquals(if (light) Color.WHITE else Color.rgb(16, 16, 16), (root.background as ColorDrawable).color)
            assertEquals(if (light) "切换为深色主题" else "切换为浅色主题", activity.findViewById<View>(R.id.theme_toggle).contentDescription)
            val dialog = TypedValue()
            assertTrue(activity.theme.resolveAttribute(android.R.attr.alertDialogTheme, dialog, true))
            assertEquals(if (light) R.style.Theme_TapPilot_Light_Dialog else R.style.Theme_TapPilot_Dialog, dialog.resourceId)
            assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
            assertEquals(light, activity.window.decorView.systemUiVisibility and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR != 0)
        }
        val syntheticTask = TaskViewState(true, "合成任务执行中", "合成结果")
        val syntheticWireless = WirelessViewState(connected = true, status = "合成电脑已连接")
        val drafts = mapOf(
            R.id.task_input to "synthetic task draft",
            R.id.model_url to "https://synthetic.invalid/v1",
            R.id.model_name to "synthetic-model-draft",
            R.id.model_key to "synthetic-key-draft",
            R.id.wireless_pairing to "synthetic-pairing-draft"
        )
        try {
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                assertTheme(light = false)
                field(R.id.task_input).setText(drafts.getValue(R.id.task_input))
                TaskState.publish(syntheticTask)
                WirelessState.publish(syntheticWireless)
            }
            page("模型")
            instrumentation.runOnMainSync { listOf(R.id.model_url, R.id.model_name, R.id.model_key).forEach { field(it).setText(drafts.getValue(it)) } }
            page("设备")
            var scrollBefore = 0
            instrumentation.runOnMainSync {
                val pairing = field(R.id.wireless_pairing)
                pairing.setText(drafts.getValue(R.id.wireless_pairing))
                pairing.requestFocus(); pairing.setSelection(3, 9)
                pairing.requestRectangleOnScreen(Rect(0, 0, pairing.width, pairing.height), true)
                scrollBefore = scroller(pairing).scrollY
            }
            toggle()
            instrumentation.runOnMainSync {
                assertTheme(light = true)
                assertFalse(activity.isDestroyed)
                val pairing = field(R.id.wireless_pairing)
                assertNotNull(pairing) // The device tab remains selected.
                assertEquals(drafts.getValue(R.id.wireless_pairing), pairing.text.toString())
                assertEquals(3, pairing.selectionStart); assertEquals(9, pairing.selectionEnd)
                assertEquals(R.id.wireless_pairing, activity.currentFocus?.id)
                assertEquals(scrollBefore, scroller(pairing).scrollY)
                assertFalse(pairing.isSaveEnabled)
                assertSame(syntheticTask, TaskState.value)
                assertSame(syntheticWireless, WirelessState.value)
                assertFalse(appearance.getBoolean("dark_theme", true))
                assertEquals(previousSettings, settings.all)
                assertEquals(mapOf("dark_theme" to false), appearance.all)
                WirelessState.publish(syntheticWireless.copy(status = "切换后的合成连接状态"))
                assertEquals("切换后的合成连接状态", activity.findViewById<TextView>(R.id.wireless_status).text.toString())
            }
            page("任务")
            instrumentation.runOnMainSync {
                assertEquals(drafts.getValue(R.id.task_input), field(R.id.task_input).text.toString())
                assertEquals(View.GONE, activity.findViewById<View>(R.id.task_start).visibility)
                TaskState.publish(syntheticTask.copy(status = "切换后的合成任务状态"))
                assertEquals("切换后的合成任务状态", activity.findViewById<TextView>(R.id.task_status).text.toString())
            }
            page("模型")
            instrumentation.runOnMainSync {
                listOf(R.id.model_url, R.id.model_name, R.id.model_key).forEach {
                    assertEquals(drafts.getValue(it), field(it).text.toString())
                    assertFalse(field(it).isSaveEnabled)
                }
                field(R.id.model_key).requestFocus(); field(R.id.model_key).setSelection(2, 7)
            }
            toggle()
            instrumentation.runOnMainSync {
                assertTheme(light = false)
                assertNotNull(field(R.id.model_key)) // The model tab remains selected.
                assertEquals(drafts.getValue(R.id.model_key), field(R.id.model_key).text.toString())
                assertEquals(2, field(R.id.model_key).selectionStart); assertEquals(7, field(R.id.model_key).selectionEnd)
                assertEquals(R.id.model_key, activity.currentFocus?.id)
                assertTrue(TaskState.value.running)
                assertEquals(previousSettings, settings.all)
            }
            toggle() // Leave light mode selected before a fresh Activity launch.
            instrumentation.runOnMainSync { activity.finish() }
            instrumentation.waitForIdleSync()
            activity = launch()
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                assertTheme(light = true)
                assertEquals("", field(R.id.task_input).text.toString())
                assertEquals(previousSettings, settings.all)
            }
            page("设备")
            instrumentation.runOnMainSync { assertEquals("", field(R.id.wireless_pairing).text.toString()) }
        } finally {
            instrumentation.runOnMainSync {
                activity.finish()
                TaskState.publish(previousTask)
                WirelessState.publish(previousWireless)
            }
            appearance.edit().apply { if (previousTheme == null) remove("dark_theme") else putBoolean("dark_theme", previousTheme) }.commit()
        }
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
