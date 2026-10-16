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
    @Test fun clientLaunchesAsControlledEndpointWithOnlyConnectionChoices() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                fun labels(view: View): List<String> = buildList {
                    if (view is TextView) add(view.text.toString())
                    if (view is ViewGroup) for (i in 0 until view.childCount) addAll(labels(view.getChildAt(i)))
                }
                val visibleLabels = labels(activity.window.decorView)
                assertFalse(visibleLabels.contains("任务"))
                assertFalse(visibleLabels.contains("模型"))
                assertFalse(visibleLabels.contains("开始任务"))
                assertNotNull(activity.findViewById(R.id.connection_wireless))
                assertNotNull(activity.findViewById(R.id.connection_usb))
                assertTrue(activity.findViewById<View>(R.id.wireless_scan).isShown)
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
            }
            val modes = listOf(
                R.id.connection_wireless to listOf(R.id.wireless_scan, R.id.wireless_connect, R.id.wireless_status),
                R.id.connection_usb to listOf(R.id.usb_settings, R.id.usb_status, R.id.accessibility_settings, R.id.automation_resume, R.id.notification_settings)
            )
            for ((mode, controls) in modes) {
                instrumentation.runOnMainSync { activity.findViewById<View>(mode).performClick() }
                instrumentation.waitForIdleSync()
                instrumentation.runOnMainSync {
                    val viewport = Rect()
                    assertTrue(activity.window.decorView.getGlobalVisibleRect(viewport))
                    fun checkHorizontalBounds(view: View) {
                        if (view.visibility != View.VISIBLE) return
                        val position = IntArray(2)
                        view.getLocationOnScreen(position)
                        assertTrue("control extends beyond left edge", position[0] >= viewport.left)
                        assertTrue("control extends beyond right edge", position[0] + view.width <= viewport.right)
                        if (view is ViewGroup) for (i in 0 until view.childCount) checkHorizontalBounds(view.getChildAt(i))
                    }
                    checkHorizontalBounds(activity.findViewById(android.R.id.content))
                    if (mode == R.id.connection_usb) assertEquals("连接状态请在电脑端查看。", activity.findViewById<TextView>(R.id.usb_status).text.toString())
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
                        assertTrue("control $id is not visible after scrolling", control.getGlobalVisibleRect(visible))
                        assertTrue(control.width > 0 && visible.height() > 0)
                        assertEquals("control $id is clipped horizontally", control.width, visible.width())
                        val emergency = activity.findViewById<View>(R.id.emergency_stop)
                        assertTrue("emergency stop must remain visible", emergency.getGlobalVisibleRect(visible))
                        assertEquals(emergency.height, visible.height())
                    }
                }
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun wirelessPanelOffersScanPasteAndExplicitConnectWithoutSavingToken() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                val input = activity.findViewById<EditText>(R.id.wireless_pairing)
                assertNotNull(input); assertFalse(input.isSaveEnabled)
                assertFalse(input.isShown)
                activity.findViewById<View>(R.id.wireless_manual).performClick()
                assertTrue(input.isShown)
                assertNotNull(activity.findViewById(R.id.wireless_scan))
                assertNotNull(activity.findViewById(R.id.wireless_connect))
                assertNotNull(activity.findViewById(R.id.wireless_status))
                assertFalse(activity.findViewById<View>(R.id.wireless_disconnect).isEnabled)
                // Opening either setup option does not start a connection or persist credentials.
                activity.findViewById<View>(R.id.connection_usb).performClick()
                activity.findViewById<View>(R.id.connection_wireless).performClick()
                assertFalse(WirelessState.value.connected)
                assertFalse(WirelessState.value.connecting)
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun themeSwitchPreservesConnectionDraftAndLiveStateAndOnlyPersistsAppearance() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val appearance = context.getSharedPreferences("appearance", Context.MODE_PRIVATE)
        val previousTheme = if (appearance.contains("dark_theme")) appearance.getBoolean("dark_theme", true) else null
        val previousWireless = WirelessState.value
        appearance.edit().remove("dark_theme").commit()
        fun launch() = instrumentation.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        var activity = launch()
        fun field() = activity.findViewById<EditText>(R.id.wireless_pairing)
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
        val syntheticWireless = WirelessViewState(status = "合成配对等待连接")
        val draft = "synthetic-pairing-draft"
        try {
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                assertTheme(light = false)
                WirelessState.publish(syntheticWireless)
                activity.findViewById<View>(R.id.wireless_manual).performClick()
                field().setText(draft)
            }
            instrumentation.waitForIdleSync()
            var scrollBefore = 0
            instrumentation.runOnMainSync {
                val pairing = field()
                pairing.requestFocus(); pairing.setSelection(3, 9)
                pairing.requestRectangleOnScreen(Rect(0, 0, pairing.width, pairing.height), true)
                scrollBefore = scroller(pairing).scrollY
            }
            toggle()
            instrumentation.runOnMainSync {
                assertTheme(light = true)
                assertFalse(activity.isDestroyed)
                val pairing = field()
                assertTrue(pairing.isShown)
                assertEquals(draft, pairing.text.toString())
                assertEquals(3, pairing.selectionStart); assertEquals(9, pairing.selectionEnd)
                assertEquals(R.id.wireless_pairing, activity.currentFocus?.id)
                assertEquals(scrollBefore, scroller(pairing).scrollY)
                assertFalse(pairing.isSaveEnabled)
                assertSame(syntheticWireless, WirelessState.value)
                assertFalse(appearance.getBoolean("dark_theme", true))
                assertEquals(mapOf("dark_theme" to false), appearance.all)
                WirelessState.publish(WirelessViewState(connected = true, status = "合成电脑已连接"))
                assertEquals("合成电脑已连接", activity.findViewById<TextView>(R.id.wireless_status).text.toString())
                assertFalse(activity.findViewById<View>(R.id.wireless_scan).isEnabled)
                assertFalse(activity.findViewById<View>(R.id.wireless_connect).isEnabled)
                assertTrue(activity.findViewById<View>(R.id.wireless_disconnect).isEnabled)
                activity.findViewById<View>(R.id.connection_usb).performClick()
                assertTrue(activity.findViewById<View>(R.id.connection_wireless).isSelected)
            }
            toggle()
            instrumentation.runOnMainSync {
                assertTheme(light = false)
                assertTrue(activity.findViewById<View>(R.id.connection_wireless).isSelected)
                assertEquals(draft, field().text.toString())
                assertTrue(WirelessState.value.connected)
                WirelessState.publish(WirelessViewState())
                activity.findViewById<View>(R.id.connection_usb).performClick()
            }
            toggle() // USB selection survives the appearance change, without starting a session.
            instrumentation.runOnMainSync {
                assertTheme(light = true)
                assertTrue(activity.findViewById<View>(R.id.connection_usb).isSelected)
                assertTrue(activity.findViewById<View>(R.id.usb_status).isShown)
                assertFalse(WirelessState.value.connected)
            }
            instrumentation.runOnMainSync { activity.finish() }
            instrumentation.waitForIdleSync()
            activity = launch()
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                assertTheme(light = true)
                assertEquals("", field().text.toString())
                assertFalse(field().isSaveEnabled)
            }
        } finally {
            instrumentation.runOnMainSync {
                activity.finish()
                WirelessState.publish(previousWireless)
            }
            appearance.edit().apply { if (previousTheme == null) remove("dark_theme") else putBoolean("dark_theme", previousTheme) }.commit()
        }
    }

    @Test fun nativeCombinedDispatchRejectsUnknownActionBeforeServiceAccess() {
        val service = AgentAccessibilityService()
        try {
            service.dispatch("act_and_observe", JSONObject().put("action", "approve").put("arguments", JSONObject()))
            fail("invalid native action accepted")
        } catch (error: AgentError) { assertEquals("INVALID_ARGUMENT", error.code) }
    }
}
