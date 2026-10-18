package dev.tappilot.testbed

import android.app.UiAutomation
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** A genuine AndroidX UI Automator baseline, run separately from TapPilot RPC actions. */
@RunWith(AndroidJUnit4::class)
class ReliabilityBaselineInstrumentedTest {
    @Test fun compareOneIsolatedFixture() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("reliabilityBaseline") == "true")
        assertTrue("baseline is emulator-only", Build.HARDWARE in setOf("ranchu", "goldfish"))
        val scene = requireNotNull(args.getString("scene"))
        require(scene in NativeExecutorScenes.names || scene in ReliabilityScenes.names)
        val seed = args.getString("seed")?.toInt() ?: 17
        val runId = UUID.fromString(requireNotNull(args.getString("runId"))).toString()
        val context = instrumentation.targetContext
        val config = Configurator.getInstance()
        val oldIdle = config.waitForIdleTimeout
        val oldFlags = config.uiAutomationFlags
        // The comparison intentionally uses target-condition waiting, not whole-page idle.
        config.waitForIdleTimeout = 0
        config.uiAutomationFlags = UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
        val device = UiDevice.getInstance(instrumentation)
        fun selector(id: String) = By.res("dev.tappilot.testbed", id)
        fun find(id: String, timeoutMs: Long = 4_000): UiObject2 = requireNotNull(device.wait(Until.findObject(selector(id)), timeoutMs)) { "TARGET_TIMEOUT" }
        fun state() = OracleState.snapshot(context)
        fun awaitSetup(predicate: (JSONObject) -> Boolean) {
            val deadline = SystemClock.uptimeMillis() + 5_000
            while (!predicate(state()) && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(30)
            check(predicate(state())) { "SETUP_TIMEOUT" }
        }
        fun unique(query: BySelector): UiObject2? = device.findObjects(query).singleOrNull()
        val checks = mutableListOf<String>()
        var actionCalls = 0
        var actionMs = 0L
        var readinessMs = 0L
        var textVerified = false
        var checkedVerified = false
        var refusal: String? = null
        var error: String? = null
        var ticksBefore = 0
        var activity: MainActivity? = null
        val started = SystemClock.uptimeMillis()
        try {
            activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                .putExtra("scene", scene).putExtra("seed", seed).putExtra("runId", runId)) as MainActivity
            if (scene.startsWith("native_")) {
                val originalRecipient = find("native_recipient").text
                find("native_target")
                ticksBefore = state().optInt("refreshCount")
                if (scene != "native_refresh") {
                    find("native_arm").click()
                    awaitSetup { it.optBoolean("changed") }
                } else {
                    val ticks = state().optInt("refreshCount")
                    awaitSetup { it.optInt("refreshCount") >= ticks + 4 }
                }
                val actionStart = SystemClock.uptimeMillis()
                // Identity and ambiguity checks are explicit fixture policy, not claims that
                // UI Automator itself detects recipient changes or prevents duplicate matches.
                val query = selector("native_target").desc("合成稳定目标")
                val matches = device.findObjects(query)
                refusal = when {
                    find("native_recipient").text != originalRecipient -> "CONTEXT_ASSERTION"
                    matches.isEmpty() -> "ORIGINAL_SELECTOR_MISSING"
                    matches.size > 1 -> "UNIQUE_SELECTOR_REQUIRED"
                    else -> null
                }
                if (refusal == null) { actionCalls++; matches.single().click() }
                actionMs = SystemClock.uptimeMillis() - actionStart
            } else if (scene == "reliability_input_transform") {
                val editor = find("reliability_input")
                val actionStart = SystemClock.uptimeMillis()
                actionCalls++; editor.text = "中文输入验证"
                textVerified = unique(selector("reliability_input"))?.text == "中文输入验证"
                actionMs = SystemClock.uptimeMillis() - actionStart
            } else {
                val button = find("reliability_target")
                val actionStart = SystemClock.uptimeMillis()
                actionCalls++; button.click()
                if (scene.endsWith("_input")) {
                    val readyStart = SystemClock.uptimeMillis()
                    val editor = find("reliability_input", 1_500)
                    readinessMs = SystemClock.uptimeMillis() - readyStart
                    actionCalls++; editor.text = "中文输入验证"
                    textVerified = unique(selector("reliability_input"))?.text == "中文输入验证"
                } else if (scene == "reliability_toggle") {
                    checkedVerified = unique(selector("reliability_target"))?.isChecked == true
                }
                actionMs = SystemClock.uptimeMillis() - actionStart
            }
            val actual = state()
            val safeRefusal = scene in setOf("native_context", "native_replaced", "native_ambiguous")
            val unverified = scene in setOf("reliability_noop", "reliability_input_transform")
            if (actual.optBoolean("completed") != (!safeRefusal && !unverified)) checks.add("ORACLE_COMPLETION_MISMATCH")
            if (actual.optInt("wrongClicks") != 0) checks.add("WRONG_TARGET")
            val expectedClicks = if (safeRefusal || scene == "reliability_input_transform") 0 else 1
            if (actual.optInt("clickCount") != expectedClicks) checks.add("DUPLICATE_OR_MISSING_CLICK")
            if (safeRefusal && (refusal == null || actionCalls != 0)) checks.add("REFUSAL_NOT_ENFORCED")
            if (scene.endsWith("_input") && (!textVerified || actual.optString("receivedInput") != "expected" || actual.optInt("inputEvents") != 1)) checks.add("INPUT_NOT_VERIFIED")
            if (scene == "reliability_input_transform" && (textVerified || actual.optString("receivedInput") != "other" || actual.optInt("inputEvents") != 1)) checks.add("TRANSFORM_NOT_DETECTED")
            if (scene == "reliability_toggle" && !checkedVerified) checks.add("TOGGLE_NOT_VERIFIED")
            if (scene == "reliability_silent_input" && actual.optInt("suppressedContentEvents") == 0) checks.add("MISSING_EVENT_FIXTURE_NOT_EXERCISED")
            if (scene in setOf("native_refresh", "native_reorder_refresh") && actual.optInt("refreshCount") < ticksBefore + 4) checks.add("CONTINUOUS_REFRESH_NOT_EXERCISED")
            if (scene in setOf("native_reorder", "native_reorder_refresh") && actual.optInt("orderChangeCount") != 1) checks.add("REORDER_NOT_EXERCISED")
        } catch (_: Exception) {
            error = "BASELINE_EXECUTION_FAILED"
        } finally {
            val actual = state()
            val report = JSONObject().put("schemaVersion", 1).put("entry", "uiautomator").put("scene", scene)
                .put("seed", seed).put("runId", runId).put("status", if (error == null && checks.isEmpty()) "passed" else "failed")
                .put("modelCalls", 0).put("actionCalls", actionCalls).put("actionMs", actionMs).put("readinessMs", readinessMs)
                .put("durationMs", SystemClock.uptimeMillis() - started).put("textVerified", textVerified)
                .put("checkedVerified", checkedVerified).put("checks", JSONArray(checks))
                .put("oracleCompleted", actual.optBoolean("completed")).put("clickCount", actual.optInt("clickCount"))
                .put("wrongClicks", actual.optInt("wrongClicks")).put("inputEvents", actual.optInt("inputEvents"))
                .put("receivedInput", actual.optString("receivedInput")).put("refreshCount", actual.optInt("refreshCount"))
                .put("orderChangeCount", actual.optInt("orderChangeCount")).put("replacementCount", actual.optInt("replacementCount"))
                .put("suppressedContentEvents", actual.optInt("suppressedContentEvents"))
            refusal?.let { report.put("refusal", it) }
            error?.let { report.put("fixtureError", it) }
            File(context.filesDir, "uiautomator-result.json").writeText(report.toString())
            activity?.let { instrumentation.runOnMainSync { it.finish() } }
            config.waitForIdleTimeout = oldIdle
            config.uiAutomationFlags = oldFlags
        }
        assertTrue("baseline failed: ${checks.joinToString()} ${error.orEmpty()}", error == null && checks.isEmpty())
    }
}
