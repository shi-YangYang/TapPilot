package dev.tappilot.agent

import android.content.Context
import android.content.Intent
import android.widget.EditText
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
