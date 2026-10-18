package dev.tappilot.agent

import org.junit.Assert.*
import org.junit.Test

class ScreenshotWindowPolicyTest {
    private val display = ScreenshotWindowPolicy.Box(0, 0, 1080, 2400)
    private fun bar(box: ScreenshotWindowPolicy.Box) = ScreenshotWindowPolicy.Overlay(box, true, true, false, false)
    private fun rejected(overlay: ScreenshotWindowPolicy.Overlay, mode: ScreenshotWindowPolicy.Mode = ScreenshotWindowPolicy.Mode.LEGACY_DISPLAY) {
        try { ScreenshotWindowPolicy.contentRegion(display, display, listOf(overlay), mode); fail("unverified overlay accepted") }
        catch (error: AgentError) {
            assertEquals("SCREENSHOT_PROTECTED", error.code)
            assertEquals("WINDOW_OBSCURED", error.reason)
        }
    }

    @Test fun verifiedTopAndBottomBarsAreRemovedFromLegacyDisplayCapture() {
        val top = bar(ScreenshotWindowPolicy.Box(0, 0, 1080, 63))
        val bottom = bar(ScreenshotWindowPolicy.Box(0, 2274, 1080, 2400))
        assertEquals(ScreenshotWindowPolicy.Box(0, 63, 1080, 2274), ScreenshotWindowPolicy.contentRegion(display, display, listOf(top, bottom)))
        val alreadyInset = ScreenshotWindowPolicy.Box(0, 80, 1080, 2200)
        assertEquals(alreadyInset, ScreenshotWindowPolicy.contentRegion(display, alreadyInset, listOf(top, bottom)))
    }

    @Test fun landscapeSideBarRequiresExactFullDisplayEdge() {
        val landscape = ScreenshotWindowPolicy.Box(0, 0, 2400, 1080)
        val left = bar(ScreenshotWindowPolicy.Box(0, 0, 126, 1080))
        assertEquals(ScreenshotWindowPolicy.Box(126, 0, 2400, 1080), ScreenshotWindowPolicy.contentRegion(landscape, landscape, listOf(left)))
        val right = bar(ScreenshotWindowPolicy.Box(2274, 0, 2400, 1080))
        assertEquals(ScreenshotWindowPolicy.Box(0, 0, 2274, 1080), ScreenshotWindowPolicy.contentRegion(landscape, landscape, listOf(right)))
    }

    @Test fun systemUiNameOrSystemTypeAloneNeverBypassProtection() {
        val top = bar(ScreenshotWindowPolicy.Box(0, 0, 1080, 63))
        rejected(top.copy(trustedSystemUi = false))
        rejected(top.copy(isSystem = false))
        rejected(top.copy(active = true))
        rejected(top.copy(focused = true))
    }

    @Test fun notificationShadeDialogsBubblesAndUncertainDecorStayProtected() {
        for (bounds in listOf(
            ScreenshotWindowPolicy.Box(0, 0, 1080, 1200), // Notification shade.
            ScreenshotWindowPolicy.Box(0, 0, 1080, 136), // Beyond the narrow bar budget.
            ScreenshotWindowPolicy.Box(100, 0, 900, 63), // Partial-width floating window.
            ScreenshotWindowPolicy.Box(0, 100, 1080, 163), // Full-width overlay away from edge.
            ScreenshotWindowPolicy.Box(100, 100, 200, 200),
            ScreenshotWindowPolicy.Box(-1, 0, 1080, 63),
        )) rejected(bar(bounds))
    }

    @Test fun nativeWindowIsolatesThinEdgeDecorWithoutOwnerOrFullWidthRequirements() {
        val overlays = listOf(
            bar(ScreenshotWindowPolicy.Box(0, 0, 1080, 63)),
            bar(ScreenshotWindowPolicy.Box(0, 2274, 1080, 2400)),
            bar(ScreenshotWindowPolicy.Box(180, 2270, 900, 2400)),
        ).map { it.copy(trustedSystemUi = false) }
        assertEquals(display, ScreenshotWindowPolicy.contentRegion(display, display, overlays, ScreenshotWindowPolicy.Mode.NATIVE_WINDOW))
        overlays.forEach { rejected(it) } // Legacy capture cannot isolate these pixels.
    }

    @Test fun nativeWindowDoesNotCropEvenVerifiedSystemBars() {
        val overlays = listOf(bar(ScreenshotWindowPolicy.Box(0, 0, 1080, 63)), bar(ScreenshotWindowPolicy.Box(0, 2274, 1080, 2400)))
        assertEquals(display, ScreenshotWindowPolicy.contentRegion(display, display, overlays, ScreenshotWindowPolicy.Mode.NATIVE_WINDOW))
    }

    @Test fun nativeWindowStillRefusesAnyOtherActiveOrFocusedWindow() {
        val overlay = bar(ScreenshotWindowPolicy.Box(180, 2270, 900, 2400)).copy(trustedSystemUi = false)
        for (blocked in listOf(overlay.copy(active = true), overlay.copy(focused = true), overlay.copy(isSystem = false, active = true))) {
            rejected(blocked, ScreenshotWindowPolicy.Mode.NATIVE_WINDOW)
        }
        // Type and package trust cannot override another focused window.
        rejected(overlay.copy(isSystem = false, trustedSystemUi = true, focused = true), ScreenshotWindowPolicy.Mode.NATIVE_WINDOW)
        val outside = overlay.copy(box = ScreenshotWindowPolicy.Box(1080, 0, 1200, 2400))
        rejected(outside.copy(active = true), ScreenshotWindowPolicy.Mode.NATIVE_WINDOW)
        rejected(outside.copy(focused = true), ScreenshotWindowPolicy.Mode.NATIVE_WINDOW)
    }

    @Test fun nativeWindowIsolatesInactiveInteriorBubblesAndOtherWindowTypes() {
        for (bounds in listOf(
            display,
            ScreenshotWindowPolicy.Box(0, 0, 1080, 1200),
            ScreenshotWindowPolicy.Box(180, 2264, 900, 2400),
            ScreenshotWindowPolicy.Box(100, 100, 900, 163),
            ScreenshotWindowPolicy.Box(-1, 0, 1080, 63),
            ScreenshotWindowPolicy.Box(400, 500, 638, 738), // Real interior floating-ball shape.
        )) for (system in listOf(true, false)) {
            val overlay = bar(bounds).copy(isSystem = system, trustedSystemUi = false)
            assertEquals(display, ScreenshotWindowPolicy.contentRegion(display, display, listOf(overlay), ScreenshotWindowPolicy.Mode.NATIVE_WINDOW))
            rejected(overlay) // Display-wide capture still cannot isolate these pixels.
        }
    }

    @Test fun isolatedScreenshotDoesNotPermitTapsOrSwipesThroughAFloatingWindow() {
        val bubble = ScreenshotWindowPolicy.Box(400, 500, 638, 738)
        val overlay = bar(bubble).copy(isSystem = false, trustedSystemUi = false)
        assertEquals(display, ScreenshotWindowPolicy.contentRegion(display, display, listOf(overlay), ScreenshotWindowPolicy.Mode.NATIVE_WINDOW))
        fun segment(x1: Int, y1: Int, x2: Int = x1, y2: Int = y1) =
            VisualTapPolicy.Segment(VisualTapPolicy.Point(x1, y1), VisualTapPolicy.Point(x2, y2))
        for ((path, swipe) in listOf(segment(500, 600) to false, segment(400, 500) to false,
            segment(300, 600, 800, 600) to true, segment(500, 400, 500, 900) to true)) {
            try { ScreenshotWindowPolicy.requireUnobscuredGesture(listOf(bubble), path, swipe); fail("covered gesture accepted") }
            catch (error: AgentError) { assertEquals("VISUAL_CONTEXT_CHANGED", error.code) }
        }
        ScreenshotWindowPolicy.requireUnobscuredGesture(listOf(bubble), segment(300, 600), false)
        ScreenshotWindowPolicy.requireUnobscuredGesture(listOf(bubble), segment(638, 738), false)
        ScreenshotWindowPolicy.requireUnobscuredGesture(listOf(bubble), segment(300, 800, 800, 800), true)
        // Even a one-pixel interception between endpoints cannot be skipped.
        try {
            ScreenshotWindowPolicy.requireUnobscuredGesture(listOf(ScreenshotWindowPolicy.Box(500, 800, 501, 801)), segment(300, 800, 800, 800), true)
            fail("thin covered swipe accepted")
        } catch (error: AgentError) { assertEquals("VISUAL_CONTEXT_CHANGED", error.code) }
    }

}
