package dev.tappilot.testbed

import android.app.UiAutomation
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Explicit opt-in bootstrap for disposable emulators; never modifies permission databases. */
@RunWith(AndroidJUnit4::class)
class EmulatorSetupInstrumentedTest {
    @Test fun enableThroughNormalSettingsUiAndLocalAllowButton() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("bootstrap") == "true")
        assertTrue("bootstrap is emulator-only", Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val ui = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        fun nodes(): List<AccessibilityNodeInfo> {
            val result = mutableListOf<AccessibilityNodeInfo>()
            fun walk(node: AccessibilityNodeInfo) {
                result.add(node)
                for (index in 0 until node.childCount) node.getChild(index)?.let(::walk)
            }
            ui.rootInActiveWindow?.let(::walk)
            return result
        }
        fun until(message: String, action: () -> Boolean) {
            val deadline = SystemClock.uptimeMillis() + 10_000
            do {
                if (action()) return
                SystemClock.sleep(100)
            } while (SystemClock.uptimeMillis() < deadline)
            fail(message)
        }
        fun click(node: AccessibilityNodeInfo): Boolean {
            var target: AccessibilityNodeInfo? = node
            repeat(8) {
                if (target?.isVisibleToUser == false) {
                    target?.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
                    return false
                }
                if (target?.isClickable == true && target?.isEnabled == true) return target!!.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                target = target?.parent
            }
            return false
        }
        fun serviceEnabled(): Boolean {
            val manager = instrumentation.targetContext.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
            return manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).any {
                it.resolveInfo.serviceInfo.packageName == "dev.tappilot.agent"
            }
        }
        if (!serviceEnabled()) {
            instrumentation.targetContext.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            until("TapPilot service entry unavailable") {
                val current = nodes()
                val entry = current.singleOrNull { it.text?.toString() == "TapPilot 手机自动化" }
                if (entry != null) click(entry) else {
                    current.firstOrNull { it.isScrollable }?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
                    false
                }
            }
            until("service switch unavailable") {
                val current = nodes()
                val mainSwitch = current.firstOrNull { it.viewIdResourceName == "com.android.settings:id/switch_widget" }
                    ?: current.firstOrNull { it.isCheckable && it.className?.toString()?.endsWith("Switch") == true }
                if (mainSwitch == null) false else mainSwitch.isChecked || click(mainSwitch)
            }
            until("service permission not enabled through UI") {
                if (serviceEnabled()) return@until true
                val current = nodes()
                val allow = current.firstOrNull { it.text?.toString() in setOf("Allow", "ALLOW", "允许") && it.isClickable }
                if (allow != null) { click(allow); false }
                else false
            }
        }
        instrumentation.targetContext.startActivity(Intent().setComponent(ComponentName("dev.tappilot.agent", "dev.tappilot.agent.MainActivity")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        until("TapPilot local Allow button unavailable") {
            val current = nodes()
            val allow = current.firstOrNull { it.viewIdResourceName == "dev.tappilot.agent:id/automation_resume" }
            if (allow != null) click(allow) else {
                current.firstOrNull { it.isScrollable }?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
                false
            }
        }
        until("TapPilot local Allow did not take effect") {
            nodes().any { it.viewIdResourceName == "dev.tappilot.agent:id/automation_status" && it.text?.toString() == "已允许" }
        }
    }
}
