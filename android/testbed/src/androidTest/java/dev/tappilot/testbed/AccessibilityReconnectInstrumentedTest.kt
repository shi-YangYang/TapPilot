package dev.tappilot.testbed

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.content.Context
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.accessibility.AccessibilityManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Explicit lifecycle fault injection for disposable emulators; never grants or changes permissions. */
@RunWith(AndroidJUnit4::class)
class AccessibilityReconnectInstrumentedTest {
    private fun until(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 10_000
        do {
            if (condition()) return
            SystemClock.sleep(100)
        } while (SystemClock.uptimeMillis() < deadline)
        fail(message)
    }

    private fun isBound(ui: UiAutomation): Boolean {
        // Read only, bounded by dumpsys itself. Never print or persist the system dump.
        val dump = ParcelFileDescriptor.AutoCloseInputStream(ui.executeShellCommand("dumpsys -t 3 accessibility"))
            .bufferedReader().use { it.readText() }
        val boundLines = Regex("(?m)^\\s*Bound services:\\s*(.*)$").findAll(dump).map { it.groupValues[1] }.toList()
        assertTrue("accessibility dump has no recognizable bound-service state", boundLines.isNotEmpty())
        // Android 34 prints Service[label=..., feedbackType...], while other versions
        // include the component. Require the complete label field, not a fuzzy title match.
        val labeledService = Regex("""(?:^|[{},\s])Service\[label=TapPilot 手机自动化,""")
        return boundLines.any { "dev.tappilot.agent/" in it || labeledService.containsMatchIn(it) }
    }

    @Test fun temporarySuppressionRebindsExistingEnabledService() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("reconnect") == "true")
        assertTrue("reconnect test is emulator-only", Build.HARDWARE in setOf("ranchu", "goldfish"))
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val manager = instrumentation.targetContext.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        fun enabled() = manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).any {
            it.resolveInfo.serviceInfo.packageName == "dev.tappilot.agent" &&
                it.resolveInfo.serviceInfo.name == "dev.tappilot.agent.AgentAccessibilityService"
        }
        var wasEnabled = false
        var suppressionAttempted = false
        var originalFailure: Throwable? = null
        try {
            val observing = requireNotNull(instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES))
            wasEnabled = enabled()
            assertTrue("TapPilot must already be enabled; this test never enables it", wasEnabled)
            until("TapPilot was not bound before suppression") { isBound(observing) }

            // Changing UiAutomation flags performs a real framework unbind/rebind, without
            // altering enabled_accessibility_services or force-stopping the application.
            suppressionAttempted = true
            val suppressing = requireNotNull(instrumentation.getUiAutomation(0))
            until("UiAutomation did not temporarily unbind TapPilot") { !isBound(suppressing) }
        } catch (failure: Throwable) {
            originalFailure = failure
            throw failure
        } finally {
            // Restoration is mandatory even if suppression verification failed.
            try {
                val restored = requireNotNull(instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES))
                if (wasEnabled && suppressionAttempted) until("TapPilot did not rebind after restoring UiAutomation flags") {
                    enabled() && isBound(restored)
                }
            } catch (restoreFailure: Throwable) {
                val preceding = originalFailure
                if (preceding != null) preceding.addSuppressed(restoreFailure) else throw restoreFailure
            }
        }
        // Host must additionally compare get_device_info.sessionId before/after this test and
        // require a valid RPC response; system binding by itself is not RPC-health evidence.
        assertTrue("the existing enabled-service configuration was lost", enabled())
    }
}
