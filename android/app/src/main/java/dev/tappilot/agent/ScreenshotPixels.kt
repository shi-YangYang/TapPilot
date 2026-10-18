package dev.tappilot.agent

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import java.io.ByteArrayOutputStream

/** In-memory only. The caller retains ownership of the source; every temporary bitmap is recycled. */
internal object ScreenshotPixels {
    data class Image(val width: Int, val height: Int, val bytes: ByteArray, val visualPixels: VisualTapPolicy.Pixels? = null)

    fun encode(source: Bitmap, crop: Rect?, includeVisualEvidence: Boolean = false, check: () -> Unit): Image {
        check()
        if (source.width.toLong() * source.height > 32_000_000L)
            throw AgentError("SCREENSHOT_FAILED", "截图尺寸超过处理范围")
        val area = crop ?: Rect(0, 0, source.width, source.height)
        if (area.isEmpty || area.left < 0 || area.top < 0 || area.right > source.width || area.bottom > source.height)
            throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "截图区域已变化，图片已丢弃")
        val software = if (source.config == Bitmap.Config.HARDWARE) source.copy(Bitmap.Config.ARGB_8888, false)
            ?: throw AgentError("SCREENSHOT_FAILED", "无法读取截图图像") else source
        var scaled: Bitmap? = null
        try {
            val (width, height) = ScreenshotLimits.dimensions(area.width(), area.height())
            scaled = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            Canvas(scaled).drawBitmap(software, area, Rect(0, 0, width, height), Paint(Paint.FILTER_BITMAP_FLAG))
            // JPEG quality first, then resolution. Every result has a strict transport budget.
            repeat(4) {
                for (quality in listOf(80, 65, 50, 35)) {
                    check()
                    val bytes = ByteArrayOutputStream().use { output ->
                        if (!scaled!!.compress(Bitmap.CompressFormat.JPEG, quality, output))
                            throw AgentError("SCREENSHOT_FAILED", "截图压缩失败")
                        output.toByteArray()
                    }
                    if (bytes.size <= ScreenshotLimits.MAX_BYTES) {
                        check()
                        val evidence = if (!includeVisualEvidence) null else {
                            val ratio = minOf(1.0, VisualTapPolicy.EVIDENCE_EDGE.toDouble() / maxOf(area.width(), area.height()))
                            val ew = maxOf(1, (area.width() * ratio).toInt())
                            val eh = maxOf(1, (area.height() * ratio).toInt())
                            val sample = Bitmap.createBitmap(ew, eh, Bitmap.Config.ARGB_8888)
                            try {
                                Canvas(sample).drawBitmap(software, area, Rect(0, 0, ew, eh), Paint(Paint.FILTER_BITMAP_FLAG))
                                val pixels = IntArray(ew * eh)
                                sample.getPixels(pixels, 0, ew, 0, 0, ew, eh)
                                VisualTapPolicy.Pixels(ew, eh, pixels)
                            } finally { sample.recycle() }
                        }
                        return Image(scaled!!.width, scaled!!.height, bytes, evidence)
                    }
                }
                check()
                val previous = scaled!!
                val smaller = Bitmap.createScaledBitmap(previous, maxOf(1, previous.width * 3 / 4), maxOf(1, previous.height * 3 / 4), true)
                scaled = smaller
                if (previous !== smaller) previous.recycle()
            }
            throw AgentError("SCREENSHOT_FAILED", "截图超过传输大小限制")
        } finally {
            scaled?.recycle()
            if (software !== source) software.recycle()
        }
    }
}
