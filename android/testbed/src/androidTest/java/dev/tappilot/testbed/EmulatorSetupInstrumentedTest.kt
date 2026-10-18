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
        val serviceLabel = "TapPilot 手机自动化"
        var lastDiagnostic: String? = null
        fun diagnostic(state: String) {
            if (state != lastDiagnostic) println("TAPPILOT_BOOTSTRAP_$state")
            lastDiagnostic = state
        }
        fun nodes(): List<AccessibilityNodeInfo> {
            // UIAutomation has its own node cache. A previously open Settings detail page
            // can otherwise survive both the intent and a service process restart.
            if (Build.VERSION.SDK_INT >= 34) ui.clearCache()
            val result = mutableListOf<AccessibilityNodeInfo>()
            fun walk(node: AccessibilityNodeInfo) {
                result.add(node)
                for (index in 0 until node.childCount) node.getChild(index)?.let(::walk)
            }
            ui.rootInActiveWindow?.let { root -> if (root.refresh()) walk(root) }
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
        fun serviceSwitch(current: List<AccessibilityNodeInfo>): AccessibilityNodeInfo? {
            // Do not mistake an unrelated Settings switch for TapPilot's permission.
            val settings = current.filter { it.packageName?.toString() == "com.android.settings" && it.isVisibleToUser }
            if (settings.none { it.text?.toString()?.contains(serviceLabel) == true }) return null
            // Return the actual checkable control. The row's non-checkable title always
            // reports isChecked=false, including when an already-enabled service crashed.
            val useLabels = setOf("Use $serviceLabel", "使用$serviceLabel", "使用 $serviceLabel")
            fun containsUseLabel(node: AccessibilityNodeInfo, depth: Int = 0): Boolean {
                if (node.text?.toString() in useLabels) return true
                if (depth >= 4) return false
                for (index in 0 until node.childCount) {
                    val child = node.getChild(index) ?: continue
                    try { if (containsUseLabel(child, depth + 1)) return true } finally { child.recycle() }
                }
                return false
            }
            val main = settings.filter { it.viewIdResourceName in setOf("android:id/switch_widget", "com.android.settings:id/switch_widget") && it.isCheckable }
            fun labelDistance(control: AccessibilityNodeInfo): Int {
                var ancestor = control.parent
                try {
                    for (distance in 1..4) {
                        val row = ancestor ?: return Int.MAX_VALUE
                        if (containsUseLabel(row)) return distance
                        ancestor = row.parent
                        row.recycle()
                    }
                    return Int.MAX_VALUE
                } finally { ancestor?.recycle() }
            }
            val distances = main.associateWith(::labelDistance)
            val closest = distances.values.minOrNull()
            if (closest != null && closest < Int.MAX_VALUE) distances.entries.singleOrNull { it.value == closest }?.let { return it.key }
            if (main.size == 1) return main.single()
            if (main.isNotEmpty()) return null
            val useLabel = settings.any { it.text?.toString() in setOf("Use $serviceLabel", "使用$serviceLabel", "使用 $serviceLabel") }
            return if (useLabel) settings.singleOrNull { it.isCheckable && it.className?.toString()?.endsWith("Switch") == true } else null
        }
        fun permissionAllow(current: List<AccessibilityNodeInfo>): AccessibilityNodeInfo? {
            val dialog = current.filter {
                it.packageName?.toString() in setOf("com.android.settings", "android", "com.android.permissioncontroller") && it.isVisibleToUser
            }
            if (dialog.none { it.text?.toString()?.contains(serviceLabel) == true }) return null
            return dialog.singleOrNull { it.text?.toString() in setOf("Allow", "ALLOW", "允许") && it.isClickable && it.isEnabled }
        }
        fun permissionStop(current: List<AccessibilityNodeInfo>): AccessibilityNodeInfo? {
            val dialog = current.filter { it.packageName?.toString() == "com.android.settings" && it.isVisibleToUser }
            if (dialog.none { node ->
                val text = node.text?.toString().orEmpty()
                serviceLabel in text && (text.startsWith("Stop ") || text.startsWith("停止") || text.startsWith("停用"))
            }) return null
            return dialog.singleOrNull { it.text?.toString() in setOf("Stop", "STOP", "停止", "停用") && it.isClickable && it.isEnabled }
        }
        fun serviceEnabled(): Boolean {
            val manager = instrumentation.targetContext.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
            return manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).any {
                it.resolveInfo.serviceInfo.packageName == "dev.tappilot.agent"
            }
        }
        if (!serviceEnabled()) {
            var enableRequested = false
            var recoveryAttempted = false
            instrumentation.targetContext.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            until("TapPilot service entry unavailable") {
                if (serviceEnabled()) return@until true
                val current = nodes()
                // Settings may reuse the existing service-detail Activity or permission dialog.
                // Its non-clickable title is not a service-list entry and must not block progress.
                if (serviceSwitch(current) != null) {
                    diagnostic("SERVICE_DETAIL_READY")
                    return@until true
                }
                if (permissionAllow(current) != null || permissionStop(current) != null) {
                    diagnostic("PERMISSION_DIALOG_READY")
                    return@until true
                }
                val entries = current.filter { it.packageName?.toString() == "com.android.settings" && it.text?.toString() == serviceLabel }
                if (entries.any { click(it) }) {
                    diagnostic("SERVICE_ENTRY_OPENED")
                    true
                } else {
                    diagnostic(if (current.isEmpty()) "NO_ACTIVE_ROOT" else "WAITING_SERVICE_ENTRY")
                    current.firstOrNull { it.isScrollable }?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
                    false
                }
            }
            until("service switch unavailable") {
                if (serviceEnabled()) return@until true
                val current = nodes()
                if (permissionAllow(current) != null || permissionStop(current) != null) return@until true
                val mainSwitch = serviceSwitch(current)
                if (mainSwitch == null) {
                    diagnostic("WAITING_SERVICE_SWITCH")
                    false
                } else {
                    diagnostic(if (mainSwitch.isChecked) "SERVICE_SWITCH_CHECKED" else "SERVICE_SWITCH_UNCHECKED")
                    mainSwitch.isChecked || click(mainSwitch).also { if (it) enableRequested = true }
                }
            }
            until("service permission not enabled through UI") {
                if (serviceEnabled()) {
                    diagnostic("SERVICE_ENABLED")
                    return@until true
                }
                val current = nodes()
                val stop = permissionStop(current)
                if (stop != null) {
                    diagnostic("RECOVER_CRASHED_SERVICE")
                    recoveryAttempted = true
                    click(stop)
                    return@until false
                }
                val allow = permissionAllow(current)
                if (allow != null) {
                    diagnostic("ALLOW_PERMISSION"); enableRequested = true; click(allow)
                } else serviceSwitch(current)?.let { mainSwitch ->
                    if (!mainSwitch.isChecked) {
                        if (click(mainSwitch)) enableRequested = true
                    } else if (!enableRequested && !recoveryAttempted) {
                        // Instrumentation may kill an enabled service process. Recover only
                        // this named emulator service through its normal off/on Settings UI.
                        if (click(mainSwitch)) recoveryAttempted = true
                    }
                }
                false
            }
        }
        instrumentation.targetContext.startActivity(Intent().setComponent(ComponentName("dev.tappilot.agent", "dev.tappilot.agent.MainActivity")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        until("TapPilot local Allow button unavailable") {
            val current = nodes()
            if (current.any { it.viewIdResourceName == "dev.tappilot.agent:id/automation_status" && it.text?.toString() == "已允许" }) return@until true
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
