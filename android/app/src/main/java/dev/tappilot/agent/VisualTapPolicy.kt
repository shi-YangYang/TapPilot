package dev.tappilot.agent

import java.text.Normalizer
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Image evidence is private, bounded and never logged or written to disk. */
internal object VisualTapPolicy {
    const val CONTRACT = "visual-tap-v1"
    const val TTL_MS = 60_000L
    const val EVIDENCE_EDGE = 640
    val ACTIONS = listOf("tap_visual", "swipe_visual")
    data class Point(val x: Int, val y: Int)
    data class Segment(val start: Point, val end: Point) {
        /** Continuous segment/rectangle clipping, including boundary contact.
         * Thin overlays or fields cannot fall between sampled path points. */
        fun intersects(box: ScreenshotWindowPolicy.Box): Boolean {
            if (box.width <= 0 || box.height <= 0) return false
            var enter = 0.0; var exit = 1.0
            fun clip(origin: Int, delta: Int, low: Int, high: Int): Boolean {
                if (delta == 0) return origin in low..high
                val a = (low.toDouble() - origin) / delta
                val b = (high.toDouble() - origin) / delta
                enter = max(enter, min(a, b)); exit = min(exit, max(a, b))
                return enter <= exit
            }
            return clip(start.x, end.x - start.x, box.left, box.right) &&
                clip(start.y, end.y - start.y, box.top, box.bottom)
        }
    }
    data class Geometry(val imageWidth: Int, val imageHeight: Int, val left: Int, val top: Int,
                        val width: Int, val height: Int, val displayWidth: Int, val displayHeight: Int) {
        fun map(x: Int, y: Int): Point {
            if (imageWidth <= 0 || imageHeight <= 0 || width <= 0 || height <= 0 || left < 0 || top < 0 ||
                left.toLong() + width > displayWidth || top.toLong() + height > displayHeight)
                throw AgentError("VISUAL_ACTION_UNSUPPORTED", "截图与屏幕区域无法可靠对应")
            if (x !in 0 until imageWidth || y !in 0 until imageHeight)
                throw AgentError("INVALID_ARGUMENT", "视觉点击坐标必须位于返回图片内")
            return Point(left + ((x + 0.5) * width / imageWidth).toInt().coerceAtMost(width - 1),
                top + ((y + 0.5) * height / imageHeight).toInt().coerceAtMost(height - 1))
        }
        fun mapSwipe(start: Point, end: Point): Segment {
            val mapped = Segment(map(start.x, start.y), map(end.x, end.y))
            val shortEdge = min(imageWidth, imageHeight)
            val margin = ceil(shortEdge * 0.04).toInt()
            if (listOf(start, end).any { it.x < margin || it.x >= imageWidth - margin || it.y < margin || it.y >= imageHeight - margin })
                throw AgentError("VISUAL_TARGET_UNSAFE", "视觉滑动必须避开图片四周的系统手势边缘，未发送手势")
            if (hypot((end.x - start.x).toDouble(), (end.y - start.y).toDouble()) < shortEdge * 0.1)
                throw AgentError("VISUAL_TARGET_UNSAFE", "视觉滑动距离过短，请使用明确的点击目标，未发送手势")
            return mapped
        }
    }
    class Pixels(val width: Int, val height: Int, val values: IntArray) : AutoCloseable {
        init { require(width > 0 && height > 0 && max(width, height) <= EVIDENCE_EDGE && values.size == width * height) }
        override fun close() { values.fill(0) }
    }

    enum class ComparisonTrigger(val wireValue: String) {
        DIMENSIONS("dimensions"), GLOBAL_FRACTION("global_fraction"), GLOBAL_MEAN("global_mean"),
        LOCAL_PIXELS("local_pixels"), LOCAL_MEAN("local_mean")
    }
    /** Aggregate differences only: no pixels, coordinates, identifiers or UI strings. */
    data class SceneComparison(val triggers: List<ComparisonTrigger>, val globalPixelCount: Int,
                               val globalChangedPixels: Int?, val globalMeanRgbMilli: Int?,
                               val localPixelCount: Int?, val localChangedPixels: Int?, val localMeanRgbMilli: Int?)

    /** Created at the service's comparison call site, before dispatch is reachable. */
    data class NotSentComparison(val comparison: SceneComparison, val referenceAgeMs: Long) {
        init { require(referenceAgeMs >= 0) }
        fun toJson(): JSONObject = JSONObject().put("triggers", JSONArray(comparison.triggers.map { it.wireValue }))
            .put("referenceAgeMs", referenceAgeMs)
            .put("globalPixelCount", comparison.globalPixelCount)
            .put("globalChangedPixels", comparison.globalChangedPixels ?: JSONObject.NULL)
            .put("globalMeanRgbMilli", comparison.globalMeanRgbMilli ?: JSONObject.NULL)
            .put("localPixelCount", comparison.localPixelCount ?: JSONObject.NULL)
            .put("localChangedPixels", comparison.localChangedPixels ?: JSONObject.NULL)
            .put("localMeanRgbMilli", comparison.localMeanRgbMilli ?: JSONObject.NULL)
    }

    private fun sceneChanged(message: String, comparison: SceneComparison): Nothing =
        throw AgentError("VISUAL_SCENE_CHANGED", message).also { it.visualComparison = comparison }

    private val unsafeChinese = Regex("支付|付款|转账|转帐|汇款|红包|发送|发消息|发短信|提交|下单|购买|确认|删除|清空|移除|卸载|授权|允许|登录|登陆|密码|验证码|解锁|生物识别|指纹|人脸")
    private val unsafeEnglish = Regex("\\b(pay\\w*|purchase\\w*|buy|transfer\\w*|send\\w*|submit\\w*|confirm\\w*|delet\\w*|remov\\w*|clear|eras\\w*|uninstall\\w*|authoriz\\w*|allow\\w*|login|log in|password\\w*|passcode\\w*|otp|unlock\\w*|biometric\\w*)\\b")
    private fun normalized(value: String) = Normalizer.normalize(value, Normalizer.Form.NFKC).lowercase(Locale.ROOT)
        .replace(Regex("[\\p{C}\\s]+"), " ")
    fun sensitivePurpose(value: String): Boolean {
        val text = normalized(value)
        return unsafeChinese.containsMatchIn(text.replace(" ", "")) || unsafeEnglish.containsMatchIn(text)
    }
    fun requireSafeTargetDescription(value: String) {
        if (value.isBlank() || value.length > 256)
            throw AgentError("INVALID_ARGUMENT", "目标描述必须是 1 至 256 个字符的非空简短描述")
        if (sensitivePurpose(value))
            throw AgentError("VISUAL_TARGET_UNSAFE", "目标描述涉及敏感操作或敏感输入，未发送点击")
    }

    data class TargetNode(val path: List<Int>, val bounds: ScreenshotWindowPolicy.Box, val visible: Boolean,
                          val clickable: Boolean, val enabled: Boolean = true, val editable: Boolean = false,
                          val sensitiveLabel: Boolean = false, val hasLabel: Boolean = false)

    fun nativeLabelIsSensitive(text: String, description: String, resourceId: String): Boolean =
        NodeActionGuard.nativeStringEvidence(text, description, resourceId, "").getBoolean("nativeSensitive") ||
            sensitivePurpose("$text $description ${resourceId.replace('_', ' ')}")

    /** Bounds select a native button branch, never a sensitive word in an unrelated peer.
     * Non-clickable descendants belong to their clickable container even at its blank edges. */
    fun requireSafeNativeTarget(nodes: List<TargetNode>, point: Point, window: ScreenshotWindowPolicy.Box) {
        fun reject(): Nothing = throw AgentError("VISUAL_TARGET_UNSAFE", "目标涉及敏感控件或无法确定单一按钮范围，未发送点击")
        fun inside(node: TargetNode) = node.visible && point.x >= node.bounds.left && point.x < node.bounds.right &&
            point.y >= node.bounds.top && point.y < node.bounds.bottom
        fun descendant(node: TargetNode, ancestor: TargetNode) = node.path.size >= ancestor.path.size &&
            node.path.take(ancestor.path.size) == ancestor.path
        val hit = nodes.filter(::inside)
        if (hit.any { it.editable }) reject()
        val candidates = hit.filter { it.clickable }
        val target = candidates.maxByOrNull { it.path.size }
        // With no native button, retain the image-only fallback but never ignore
        // an exposed sensitive leaf at the requested point.
        if (target == null) {
            if (hit.any { node -> node.sensitiveLabel && nodes.none { it !== node && descendant(it, node) } }) reject()
            return
        }
        if (!target.enabled || candidates.any { !descendant(target, it) }) reject()
        if (nodes.any { descendant(target, it) && !it.visible }) reject()
        val branch = nodes.filter { descendant(it, target) }
        // A screen-wide clickable wrapper containing remote labels is not a
        // localized button. Refuse ambiguity instead of attributing its whole
        // page to a target. A canvas with no native labels retains visual fallback.
        val screenWide = target.bounds.width.toLong() * 5 >= window.width.toLong() * 4 &&
            target.bounds.height.toLong() * 5 >= window.height.toLong() * 4
        if (screenWide && branch.any { it !== target && it.visible && it.hasLabel && !inside(it) }) reject()
        if (branch.any { it.sensitiveLabel }) reject()
        // An overlapping sensitive leaf in a different branch also prevents
        // establishing a safe native target; drawing order is not guessed.
        if (hit.any { node -> !descendant(node, target) && node.sensitiveLabel &&
                nodes.none { it !== node && descendant(it, node) } }) reject()
    }

    /** The full stroke must avoid native editable/sensitive regions. Native
     * button semantics include their non-clickable children, even when the
     * stroke crosses only the blank part of a compound button. */
    fun requireSafeNativeSwipe(nodes: List<TargetNode>, segment: Segment, window: ScreenshotWindowPolicy.Box,
                               checkActive: () -> Unit = {}) {
        fun reject(): Nothing = throw AgentError("VISUAL_TARGET_UNSAFE", "滑动路径涉及敏感、可编辑或无法确定的控件，未发送手势")
        fun descendant(node: TargetNode, ancestor: TargetNode) = node.path.size >= ancestor.path.size &&
            node.path.take(ancestor.path.size) == ancestor.path
        fun inside(point: Point) = point.x >= window.left && point.x < window.right && point.y >= window.top && point.y < window.bottom
        if (!inside(segment.start) || !inside(segment.end)) reject()
        val hit = nodes.filter { it.visible && segment.intersects(it.bounds) }
        if (hit.any { it.editable || it.sensitiveLabel && nodes.none { child -> child !== it && descendant(child, it) } }) reject()
        val buttons = hit.filter { it.clickable }
        for (button in buttons) {
            checkActive()
            if (!button.enabled || nodes.any { descendant(button, it) && !it.visible }) reject()
            if (nodes.any { descendant(it, button) && it.sensitiveLabel }) reject()
            for (other in buttons) {
                if (descendant(button, other) || descendant(other, button)) continue
                val overlap = ScreenshotWindowPolicy.Box(max(button.bounds.left, other.bounds.left), max(button.bounds.top, other.bounds.top),
                    min(button.bounds.right, other.bounds.right), min(button.bounds.bottom, other.bounds.bottom))
                if (segment.intersects(overlap)) reject()
            }
        }
    }

    /** A tap binds to stable pixels around its target, not to unrelated video or animation.
     * A browsing swipe moves content and therefore cannot require matching content pixels.
     * The caller must still validate the original window/session/geometry/lease, and inspect
     * current native sensitive controls and overlays along the whole stroke before dispatch.
     * Pixel agreement alone never proves that an action is safe or had its intended effect. */
    fun requireActionScene(before: Pixels, after: Pixels, x: Int, y: Int, imageWidth: Int, imageHeight: Int,
                           swipe: Boolean = false) {
        if (before.width != after.width || before.height != after.height)
            sceneChanged("截图画面尺寸已变化，请重新观察", SceneComparison(listOf(ComparisonTrigger.DIMENSIONS),
                before.values.size, null, null, null, null, null))
        if (swipe) return
        val cx = ((x + 0.5) * before.width / imageWidth).toInt().coerceIn(0, before.width - 1)
        val cy = ((y + 0.5) * before.height / imageHeight).toInt().coerceIn(0, before.height - 1)
        val radius = max(12, (40.0 * before.width / imageWidth).toInt())
        val left = max(0, cx - radius); val right = min(before.width, cx + radius + 1)
        val top = max(0, cy - radius); val bottom = min(before.height, cy + radius + 1)
        var changed = 0; var total = 0L; var localChanged = 0; var localTotal = 0L; var localCount = 0
        for (index in before.values.indices) {
            val a = before.values[index]; val b = after.values[index]
            val r = abs((a shr 16 and 255) - (b shr 16 and 255))
            val g = abs((a shr 8 and 255) - (b shr 8 and 255))
            val blue = abs((a and 255) - (b and 255))
            val difference = r + g + blue
            val notable = max(r, max(g, blue)) > 12
            total += difference
            if (notable) changed++
            val px = index % before.width; val py = index / before.width
            val local = px in left until right && py in top until bottom
            if (local) {
                localCount++
                localTotal += difference
                if (notable) localChanged++
            }
        }
        val count = before.values.size
        val globalMean = total.toDouble() / (count * 3)
        val localMean = localTotal.toDouble() / (localCount * 3)
        val triggers = buildList {
            if (localChanged != 0) add(ComparisonTrigger.LOCAL_PIXELS)
            if (localMean > 0.75) add(ComparisonTrigger.LOCAL_MEAN)
        }
        if (triggers.isNotEmpty()) sceneChanged("点击目标附近已变化，未发送点击", SceneComparison(triggers, count,
            changed, (globalMean * 1000).roundToInt(), localCount, localChanged, (localMean * 1000).roundToInt()))
    }
}

/** One issued reference. Consumption removes it before any validation or dispatch. */
internal class VisualCaptureStore<T : AutoCloseable>(private val now: () -> Long) {
    data class Lease<T>(val id: String, val generation: Long, val issuedAt: Long, val value: T)
    private var generation = 0L
    private var latest: Lease<T>? = null
    @Synchronized fun clear() { generation++; latest?.value?.close(); latest = null }
    @Synchronized fun generation() = generation
    @Synchronized fun issue(id: String, value: T, expectedGeneration: Long): Boolean {
        if (generation != expectedGeneration) { value.close(); return false }
        latest?.value?.close()
        generation++
        latest = Lease(id, generation, now(), value)
        return true
    }
    @Synchronized fun consume(id: String): Lease<T> {
        val reference = latest?.takeIf { it.id == id }
            ?: throw AgentError("VISUAL_REFERENCE_INVALID", "截图点击凭证已失效或已使用，请重新观察")
        latest = null
        if (now() - reference.issuedAt >= VisualTapPolicy.TTL_MS) {
            reference.value.close()
            throw AgentError("VISUAL_REFERENCE_EXPIRED", "截图点击凭证已过期，请重新观察")
        }
        return reference
    }
    @Synchronized fun requireCurrent(reference: Lease<T>) {
        if (generation != reference.generation) throw AgentError("VISUAL_CONTEXT_CHANGED", "截图后已有其他操作或新的截图，未发送点击")
        if (now() - reference.issuedAt >= VisualTapPolicy.TTL_MS) throw AgentError("VISUAL_REFERENCE_EXPIRED", "截图点击凭证已过期，请重新观察")
    }
    @Synchronized fun expire(id: String) {
        if (latest?.id == id && now() - latest!!.issuedAt >= VisualTapPolicy.TTL_MS) clear()
    }
}
