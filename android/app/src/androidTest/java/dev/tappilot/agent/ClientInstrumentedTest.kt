package dev.tappilot.agent

import android.content.Context
import android.content.Intent
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
