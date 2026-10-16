package dev.tappilot.agent

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EmergencyStopInstrumentedTest {
    @Test fun failedCommitDoesNotClaimDurableStop() {
        assumeTrue(AgentAccessibilityService.instance == null)
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val backing = base.getSharedPreferences("fixture_emergency_commit_failure", Context.MODE_PRIVATE)
        val failing = object : SharedPreferences by backing {
            override fun edit(): SharedPreferences.Editor {
                val editor = backing.edit()
                return object : SharedPreferences.Editor by editor {
                    override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor {
                        editor.putBoolean(key, value)
                        return this
                    }
                    override fun commit(): Boolean { editor.commit(); return false }
                }
            }
        }
        val fixture = object : ContextWrapper(base) {
            override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences = failing
        }
        try {
            AgentAccessibilityService.latchEmergencyStop(fixture)
            fail("failed commit was acknowledged as durable")
        } catch (error: AgentError) { assertEquals("STOP_PERSISTENCE_FAILED", error.code) }
        finally { backing.edit().clear().commit() }
    }
    @Test fun emergencyLatchPersistsWithoutAccessibilityConnection() {
        // Never alter a real user's active service or production safety preference in this fixture.
        assumeTrue(AgentAccessibilityService.instance == null)
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val fixture = object : ContextWrapper(base) {
            override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences = base.getSharedPreferences("fixture_emergency_latch", Context.MODE_PRIVATE)
        }
        val prefs = fixture.getSharedPreferences("safety", Context.MODE_PRIVATE)
        try {
            assertTrue(prefs.edit().putBoolean("stopped", false).commit())
            AgentAccessibilityService.latchEmergencyStop(fixture)
            assertTrue(prefs.getBoolean("stopped", false))
            assertTrue(base.getSharedPreferences("fixture_emergency_latch", Context.MODE_PRIVATE).getBoolean("stopped", false))
        } finally { prefs.edit().clear().commit() }
    }
}
