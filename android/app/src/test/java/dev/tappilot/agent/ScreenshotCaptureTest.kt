package dev.tappilot.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ScreenshotCaptureTest {
    private class Frame : AutoCloseable {
        var closed = 0
        override fun close() { closed++ }
    }
    private fun error(code: String, block: () -> Unit) {
        try { block(); fail("expected $code") } catch (error: AgentError) { assertEquals(code, error.code) }
    }
    private class Harness {
        var now = 1000L
        var context = "session:window:package:bounds"
        var activeFailure: String? = null
        val gate = ScreenshotGate()
        var callback: ScreenshotCapture.Callback<Frame>? = null
        var sent = 0
        var encoded = 0
        var wait: () -> Unit = { now += 100 }
        var started: () -> Unit = {}
        var encoding: () -> Unit = {}
        var operationDeadline = Long.MAX_VALUE
        val frames = mutableListOf<Frame>()
        fun deliver(): Frame = Frame().also { frames.add(it); callback!!.success(it) }
        fun run(): String = ScreenshotCapture<Frame>({ now }, gate, { wait() }).capture(
            active = { activeFailure?.let { throw AgentError(it, "synthetic refusal") } },
            context = { context },
            start = { _, delivery, _ -> callback = delivery; sent++; started() },
            encode = { _, _, _ -> encoded++; encoding(); "encoded" },
            operationDeadline = operationDeadline,
        )
    }

    @Test fun successfulObservationEncodesOnceAndReleasesFrameWithoutReplay() {
        val h = Harness().apply { started = { deliver() } }
        assertEquals("encoded", h.run())
        assertEquals(1, h.sent); assertEquals(1, h.encoded); assertEquals(1, h.frames.single().closed)
        val duplicate = h.deliver()
        assertEquals("late duplicate callback must release its native buffer", 1, duplicate.closed)
    }

    @Test fun timeoutDoesNotRetryAndLateNativeResultIsReleased() {
        val h = Harness()
        error("SCREENSHOT_TIMEOUT") { h.run() }
        assertEquals(1, h.sent); assertEquals(0, h.encoded)
        assertEquals(1, h.deliver().closed)
        h.now += 1000; h.started = { h.deliver() }
        assertEquals("encoded", h.run()) // Timed-out operation released the concurrency slot.
    }

    @Test fun cancellationWhileWaitingClosesLateFrame() {
        val h = Harness().apply { wait = { activeFailure = "CANCELLED" } }
        error("CANCELLED") { h.run() }
        assertEquals(1, h.deliver().closed); assertEquals(0, h.encoded)
    }

    @Test fun serviceStopLockAndCancellationRefuseBeforeNativeCall() {
        for (code in listOf("SERVICE_UNAVAILABLE", "EMERGENCY_STOPPED", "DEVICE_LOCKED", "CANCELLED")) {
            val h = Harness().apply { activeFailure = code }
            error(code) { h.run() }
            assertEquals(0, h.sent)
        }
    }

    @Test fun stopLockDisconnectAndCancellationAfterCallbackNeverReturnImage() {
        for (code in listOf("SERVICE_UNAVAILABLE", "EMERGENCY_STOPPED", "DEVICE_LOCKED", "CANCELLED")) {
            val h = Harness().apply { started = { deliver(); activeFailure = code } }
            error(code) { h.run() }
            assertEquals(0, h.encoded); assertEquals(1, h.frames.single().closed)
        }
    }

    @Test fun protectionDiscoveredAfterEncodingDiscardsResultAndClosesBuffer() {
        for (code in listOf("PROTECTED_APP", "SENSITIVE_FIELD", "SCREENSHOT_PROTECTED", "EMERGENCY_STOPPED")) {
            val h = Harness().apply { started = { deliver() }; encoding = { activeFailure = code } }
            error(code) { h.run() }
            assertEquals(1, h.encoded); assertEquals(1, h.frames.single().closed)
        }
    }

    @Test fun windowSessionOrBoundsChangeBeforeEncodingRejectsFrame() {
        for (changed in listOf("new-session", "new-window", "new-package", "new-bounds")) {
            val h = Harness().apply { started = { deliver(); context = changed } }
            error("SCREENSHOT_CONTEXT_CHANGED") { h.run() }
            assertEquals(0, h.encoded); assertEquals(1, h.frames.single().closed)
        }
    }

    @Test fun contextChangeDuringCompressionRejectsAlreadyEncodedData() {
        val h = Harness().apply { started = { deliver() }; encoding = { context = "new-window" } }
        error("SCREENSHOT_CONTEXT_CHANGED") { h.run() }
        assertEquals(1, h.encoded); assertEquals(1, h.frames.single().closed)
    }

    @Test fun compressionDeadlineIsIncludedInTotalBudget() {
        val h = Harness().apply { started = { deliver() }; encoding = { now += ScreenshotCapture.TIMEOUT_MS } }
        error("SCREENSHOT_TIMEOUT") { h.run() }
        assertEquals(1, h.frames.single().closed)
    }

    @Test fun enclosingActionDeadlineCanShortenButNeverExtendTheCaptureBudget() {
        val short = Harness().apply { operationDeadline = now + 300 }
        error("SCREENSHOT_TIMEOUT") { short.run() }
        assertEquals(1300L, short.now)
        assertEquals(1, short.sent)
        assertEquals(1, short.deliver().closed)
        val longer = Harness().apply { operationDeadline = now + 9000 }
        error("SCREENSHOT_TIMEOUT") { longer.run() }
        assertEquals(1000L + ScreenshotCapture.TIMEOUT_MS, longer.now)
    }

    @Test fun nativeSecureFailureDoesNotFallbackOrRetry() {
        val h = Harness().apply { started = { callback!!.failure(ScreenshotLimits.nativeError(6)) } }
        error("SCREENSHOT_PROTECTED") { h.run() }
        assertEquals(1, h.sent); assertEquals(0, h.encoded)
        assertEquals(1, h.deliver().closed)
    }

    @Test fun nativeAccessFailureIsUnavailableWithoutFallbackOrRetry() {
        val h = Harness().apply { started = { callback!!.failure(ScreenshotLimits.nativeError(2)) } }
        error("SCREENSHOT_UNAVAILABLE") { h.run() }
        assertEquals(1, h.sent); assertEquals(0, h.encoded)
        assertEquals(1, h.deliver().closed)
    }

    @Test fun concurrencyAndRateAreBounded() {
        val gate = ScreenshotGate()
        gate.enter(1000)
        error("SCREENSHOT_RATE_LIMITED") { gate.enter(3000) }
        gate.leave()
        error("SCREENSHOT_RATE_LIMITED") { gate.enter(1999) }
        gate.enter(2000); gate.leave()
    }

    @Test fun dimensionsRemainBoundedWithoutUpscaling() {
        assertEquals(1280 to 720, ScreenshotLimits.dimensions(3840, 2160))
        assertEquals(720 to 1280, ScreenshotLimits.dimensions(2160, 3840))
        assertEquals(320 to 240, ScreenshotLimits.dimensions(320, 240))
        assertEquals(1 to 1280, ScreenshotLimits.dimensions(1, 10000))
        error("SCREENSHOT_FAILED") { ScreenshotLimits.dimensions(0, 10) }
        error("SCREENSHOT_FAILED") { ScreenshotLimits.dimensions(10, -1) }
    }

    @Test fun nativeErrorsHaveExplicitNonRetryingCodes() {
        val expected = listOf("SCREENSHOT_FAILED", "SCREENSHOT_UNAVAILABLE", "SCREENSHOT_RATE_LIMITED", "SCREENSHOT_CONTEXT_CHANGED", "SCREENSHOT_CONTEXT_CHANGED", "SCREENSHOT_PROTECTED")
        expected.forEachIndexed { index, code -> assertEquals(code, ScreenshotLimits.nativeError(index + 1).code) }
        assertEquals("SCREENSHOT_FAILED", ScreenshotLimits.nativeError(999).code)
        for (value in 1..6) assertFalse(ScreenshotLimits.nativeError(value).retryable)
    }

    @Test fun screenshotAcceptsOnlyEmptyReadOnlyArgumentsInBothCatalogPaths() {
        ToolCatalog.validate("take_screenshot", JSONObject())
        ToolCatalog.validateRpc("take_screenshot", JSONObject())
        for (key in listOf("x", "y", "snapshotId", "nodeId", "path", "displayId", "windowId"))
            error("INVALID_ARGUMENT") { ToolCatalog.validateRpc("take_screenshot", JSONObject().put(key, 1)) }
        assertFalse(ToolCatalog.actions.containsKey("take_screenshot"))
    }

    @Test fun screenshotFailureReasonsExposeOnlyFixedCodeReasonPairs() {
        val reasons = mapOf(
            "SCREENSHOT_PROTECTED" to listOf("WINDOW_OBSCURED", "SYSTEM_SECURE_WINDOW", "SCREENSHOT_ACCESS_DENIED", "SENSITIVE_NODE", "SENSITIVE_SCAN_LIMIT", "UNSUPPORTED_WINDOW"),
            "SCREENSHOT_UNAVAILABLE" to listOf("SCREENSHOT_ACCESS_DENIED"),
            "SENSITIVE_FIELD" to listOf("SENSITIVE_NODE"),
        )
        for ((code, allowed) in reasons) for (reason in allowed) {
            val error = AgentError(code, "Fixed synthetic failure", reason = reason)
            error.nativeObservation = JSONObject().put("private", "never serialized")
            val details = error.toJson().getJSONObject("details")
            assertEquals(setOf("reason"), details.keys().asSequence().toSet())
            assertEquals(reason, details.getString("reason"))
            assertFalse(error.toJson().toString().contains("never serialized"))
        }
        for ((code, reason) in listOf("SCREENSHOT_PROTECTED" to "private native text", "SCREENSHOT_UNAVAILABLE" to "SYSTEM_SECURE_WINDOW",
            "SENSITIVE_FIELD" to "WINDOW_OBSCURED", "SCREENSHOT_FAILED" to "WINDOW_OBSCURED", "INVALID_ARGUMENT" to "SENSITIVE_NODE")) {
            assertFalse(AgentError(code, "Fixed synthetic failure", reason = reason).toJson().has("details"))
        }
        assertEquals("SYSTEM_SECURE_WINDOW", ScreenshotLimits.nativeError(6).toJson().getJSONObject("details").getString("reason"))
        assertEquals("SCREENSHOT_ACCESS_DENIED", ScreenshotLimits.nativeError(2).toJson().getJSONObject("details").getString("reason"))
    }

}
