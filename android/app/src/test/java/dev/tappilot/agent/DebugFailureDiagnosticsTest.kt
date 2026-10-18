package dev.tappilot.agent

import org.junit.Assert.*
import org.junit.Test

class DebugFailureDiagnosticsTest {
    @Test fun emitsOnlyBoundedCodeLocationsWithoutExceptionOrCauseMessages() {
        val error = IllegalStateException("private UI value 123456", RuntimeException("private cause value"))
        error.stackTrace = Array(20) { StackTraceElement("dev.tappilot.agent.Fixture", "operation", "Fixture.kt", 42) }
        val result = DebugFailureDiagnostics.codeLocations(error)
        assertTrue(result.startsWith("ANDROID_ERROR class=java.lang.IllegalStateException\n"))
        assertTrue(result.contains("dev.tappilot.agent.Fixture.operation(Fixture.kt:42)"))
        assertEquals(17, result.lines().size)
        assertFalse(result.contains("private"))
        assertFalse(result.contains("123456"))
        assertFalse(result.contains("RuntimeException"))
    }
}
