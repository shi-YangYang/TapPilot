package dev.tappilot.agent

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** One native capture, no replay. The mailbox owns late callbacks after cancellation. */
internal class ScreenshotCapture<T : AutoCloseable>(
    private val now: () -> Long,
    private val gate: ScreenshotGate,
    private val wait: (CountDownLatch) -> Unit = { it.await(40, TimeUnit.MILLISECONDS); Unit },
) {
    internal interface Callback<T> {
        fun success(frame: T)
        fun failure(error: AgentError)
    }

    fun <C, R> capture(
        active: () -> Unit,
        context: (Long) -> C,
        start: (C, Callback<T>, Long) -> Unit,
        encode: (T, C, Long) -> R,
        operationDeadline: Long = Long.MAX_VALUE,
    ): R {
        active()
        gate.enter(now())
        val deadline = minOf(now() + TIMEOUT_MS, operationDeadline)
        val mailbox = Mailbox<T>()
        var frame: T? = null
        fun check() {
            active()
            if (now() >= deadline) throw AgentError("SCREENSHOT_TIMEOUT", "截图超时，未自动重试")
        }
        try {
            check()
            val before = context(deadline)
            check()
            start(before, mailbox, deadline)
            while (mailbox.ready.count != 0L) { check(); wait(mailbox.ready) }
            check()
            frame = mailbox.take()
            if (context(deadline) != before) throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "截图期间页面已切换，图片已丢弃")
            check()
            val result = encode(frame, before, deadline)
            check()
            if (context(deadline) != before) throw AgentError("SCREENSHOT_CONTEXT_CHANGED", "截图期间页面已切换，图片已丢弃")
            check()
            return result
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            throw AgentError("CANCELLED", "截图已取消")
        } finally {
            mailbox.close()
            frame?.close()
            gate.leave()
        }
    }

    private class Mailbox<T : AutoCloseable> : Callback<T>, AutoCloseable {
        val ready = CountDownLatch(1)
        private var finished = false
        private var value: T? = null
        private var error: AgentError? = null
        override fun success(frame: T) = synchronized(this) {
            if (finished) frame.close() else {
                finished = true; value = frame; ready.countDown()
            }
        }
        override fun failure(error: AgentError) = synchronized(this) {
            if (!finished) { finished = true; this.error = error; ready.countDown() }
        }
        fun take(): T = synchronized(this) {
            error?.let { throw it }
            val frame = value ?: throw AgentError("SCREENSHOT_FAILED", "截图未返回有效图像")
            value = null
            frame
        }
        override fun close() = synchronized(this) {
            finished = true; value?.close(); value = null; ready.countDown()
        }
    }

    companion object { const val TIMEOUT_MS = 4_000L }
}

internal class ScreenshotGate {
    private var busy = false
    private var previousStart: Long? = null
    @Synchronized fun enter(now: Long) {
        if (busy || previousStart?.let { now - it < 1_000 } == true)
            throw AgentError("SCREENSHOT_RATE_LIMITED", "截图请求过于频繁，请稍后再观察")
        busy = true
        previousStart = now
    }
    @Synchronized fun leave() { busy = false }
    @Synchronized fun remainingDelay(now: Long): Long {
        if (busy) throw AgentError("SCREENSHOT_RATE_LIMITED", "已有截图正在处理，未发送点击")
        return previousStart?.let { maxOf(0, 1_000 - (now - it)) } ?: 0
    }
}

internal object ScreenshotLimits {
    const val MAX_EDGE = 1280
    const val MAX_BYTES = 384 * 1024
    fun dimensions(width: Int, height: Int): Pair<Int, Int> {
        if (width <= 0 || height <= 0) throw AgentError("SCREENSHOT_FAILED", "截图尺寸无效")
        val scale = minOf(1.0, MAX_EDGE.toDouble() / maxOf(width, height))
        return maxOf(1, (width * scale).toInt()) to maxOf(1, (height * scale).toInt())
    }

    // Android AccessibilityService error constants are stable API values (30/34).
    fun nativeError(code: Int): AgentError = when (code) {
        2 -> AgentError("SCREENSHOT_UNAVAILABLE", "无障碍截图访问不可用，请在手机检查 TapPilot 无障碍服务", reason = "SCREENSHOT_ACCESS_DENIED")
        6 -> AgentError("SCREENSHOT_PROTECTED", "系统不允许读取此页面的截图", reason = "SYSTEM_SECURE_WINDOW")
        3 -> AgentError("SCREENSHOT_RATE_LIMITED", "系统限制了截图频率，请稍后再观察")
        4, 5 -> AgentError("SCREENSHOT_CONTEXT_CHANGED", "截图窗口已失效，图片不可用")
        else -> AgentError("SCREENSHOT_FAILED", "系统未能完成截图")
    }
}

/** Fixed reason/code pairs only. Native IDs, labels, bounds and system messages
 * must never be promoted into screenshot error details.
 */
internal object ScreenshotErrorReason {
    private val byCode = mapOf(
        "SCREENSHOT_PROTECTED" to setOf("WINDOW_OBSCURED", "SYSTEM_SECURE_WINDOW", "SCREENSHOT_ACCESS_DENIED", "SENSITIVE_NODE", "SENSITIVE_SCAN_LIMIT", "UNSUPPORTED_WINDOW"),
        "SCREENSHOT_UNAVAILABLE" to setOf("SCREENSHOT_ACCESS_DENIED"),
        "SENSITIVE_FIELD" to setOf("SENSITIVE_NODE"),
    )
    fun allowed(code: String, reason: String?): String? = reason?.takeIf { it in byCode[code].orEmpty() }
}
