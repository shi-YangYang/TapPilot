package dev.tappilot.agent

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Rect
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Random

/** Synthetic pixels only; never screenshots the test runner or a user's data. */
@RunWith(AndroidJUnit4::class)
class ScreenshotPixelsInstrumentedTest {
    private fun emulatorOnly() { assumeTrue("isolated emulator only", Build.HARDWARE in setOf("ranchu", "goldfish")) }
    private fun error(code: String, block: () -> Unit) {
        try { block(); fail("expected $code") } catch (error: AgentError) { assertEquals(code, error.code) }
    }

    @Test fun noisyImageFitsByteAndDimensionBudgetsAndIsValidJpeg() {
        emulatorOnly()
        val source = Bitmap.createBitmap(1800, 2400, Bitmap.Config.ARGB_8888)
        val random = Random(719)
        val row = IntArray(source.width)
        try {
            repeat(source.height) { y ->
                for (x in row.indices) row[x] = random.nextInt() or Color.BLACK
                source.setPixels(row, 0, row.size, 0, y, row.size, 1)
            }
            val image = ScreenshotPixels.encode(source, null) {}
            assertTrue(image.width in 1..1280); assertTrue(image.height in 1..1280)
            assertTrue(image.bytes.size in 1..ScreenshotLimits.MAX_BYTES)
            assertEquals(0xff, image.bytes[0].toInt() and 0xff); assertEquals(0xd8, image.bytes[1].toInt() and 0xff)
            val decoded = BitmapFactory.decodeByteArray(image.bytes, 0, image.bytes.size)
            assertNotNull(decoded)
            try { assertEquals(image.width, decoded.width); assertEquals(image.height, decoded.height) }
            finally { decoded.recycle() }
            assertFalse("caller retains source ownership", source.isRecycled)
        } finally { source.recycle() }
    }

    @Test fun displayCropExcludesPixelsOutsideTheObservedApp() {
        emulatorOnly()
        val source = Bitmap.createBitmap(400, 600, Bitmap.Config.ARGB_8888)
        source.eraseColor(Color.RED)
        try {
            val canvas = android.graphics.Canvas(source)
            canvas.drawRect(Rect(40, 80, 300, 480), android.graphics.Paint().apply { color = Color.BLUE })
            val image = ScreenshotPixels.encode(source, Rect(40, 80, 300, 480)) {}
            assertEquals(260, image.width); assertEquals(400, image.height)
            val decoded = BitmapFactory.decodeByteArray(image.bytes, 0, image.bytes.size)
            try {
                for ((x, y) in listOf(0 to 0, 259 to 399, 130 to 200)) {
                    val color = decoded.getPixel(x, y)
                    assertTrue(Color.blue(color) > 240); assertTrue(Color.red(color) < 15)
                }
            } finally { decoded.recycle() }
        } finally { source.recycle() }
    }

    @Test fun invalidCropAndCancellationNeverReturnPixelsOrRecycleCallerBitmap() {
        emulatorOnly()
        val source = Bitmap.createBitmap(20, 20, Bitmap.Config.ARGB_8888)
        try {
            error("SCREENSHOT_CONTEXT_CHANGED") { ScreenshotPixels.encode(source, Rect(-1, 0, 20, 20)) {} }
            error("SCREENSHOT_CONTEXT_CHANGED") { ScreenshotPixels.encode(source, Rect(0, 0, 21, 20)) {} }
            var checks = 0
            error("CANCELLED") { ScreenshotPixels.encode(source, null) { if (++checks > 1) throw AgentError("CANCELLED", "synthetic stop") } }
            assertFalse(source.isRecycled)
        } finally { source.recycle() }
    }
}
