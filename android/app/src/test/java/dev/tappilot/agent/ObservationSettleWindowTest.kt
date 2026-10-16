package dev.tappilot.agent

import org.junit.Assert.assertEquals
import org.junit.Test

class ObservationSettleWindowTest {
    @Test fun animationStartDoesNotEndObservationWaitAndLaterContentExtendsQuietPeriod() {
        val window = ObservationSettleWindow(startMs = 1000, timeoutMs = 350, initialRevision = 10)
        assertEquals(350L, window.nextWaitMs(1000, 10))
        assertEquals(120L, window.nextWaitMs(1030, 11)) // Animation-start event.
        assertEquals(90L, window.nextWaitMs(1060, 11)) // Spurious wake must not reset quiet time.
        assertEquals(120L, window.nextWaitMs(1110, 12)) // New accessible content arrives.
        assertEquals(30L, window.nextWaitMs(1200, 12))
        assertEquals(0L, window.nextWaitMs(1230, 12))
    }

    @Test fun continuouslyRefreshingAppCannotExtendTheOriginalDeadline() {
        val window = ObservationSettleWindow(startMs = 1000, timeoutMs = 350, initialRevision = 10)
        assertEquals(120L, window.nextWaitMs(1100, 11))
        assertEquals(120L, window.nextWaitMs(1200, 12))
        assertEquals(50L, window.nextWaitMs(1300, 13))
        assertEquals(0L, window.nextWaitMs(1350, 14))
    }

    @Test fun absenceOfEventsUsesTheBudgetAndZeroBudgetNeverWaits() {
        val window = ObservationSettleWindow(startMs = 1000, timeoutMs = 350, initialRevision = 10)
        assertEquals(250L, window.nextWaitMs(1100, 10))
        assertEquals(50L, window.nextWaitMs(1300, 10))
        assertEquals(0L, window.nextWaitMs(1350, 10))
        assertEquals(0L, ObservationSettleWindow(1000, 0, 10).nextWaitMs(1000, 11))
    }
}
