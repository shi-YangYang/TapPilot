package dev.tappilot.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class VisualTapPolicyTest {
    private fun error(code: String, block: () -> Unit): AgentError {
        try { block() } catch (error: AgentError) { assertEquals(code, error.code); return error }
        throw AssertionError("Expected $code")
    }
    private fun pixels(width: Int = 100, height: Int = 100) = VisualTapPolicy.Pixels(width, height, IntArray(width * height) { 0xff606060.toInt() })
    private class Owned : AutoCloseable {
        var closed = 0
        override fun close() { closed++ }
    }

    @Test fun coordinatesUseReturnedImagePixelsAndExactWindowOriginInBothOrientations() {
        val portrait = VisualTapPolicy.Geometry(500, 1000, 20, 100, 1000, 2000, 1080, 2400)
        assertEquals(VisualTapPolicy.Point(21, 101), portrait.map(0, 0))
        assertEquals(VisualTapPolicy.Point(1019, 2099), portrait.map(499, 999))
        val landscape = VisualTapPolicy.Geometry(1000, 450, 100, 40, 2000, 900, 2400, 1080)
        assertEquals(VisualTapPolicy.Point(1101, 491), landscape.map(500, 225))
        for ((x, y) in listOf(-1 to 0, 500 to 0, 0 to 1000)) error("INVALID_ARGUMENT") { portrait.map(x, y) }
        error("VISUAL_ACTION_UNSUPPORTED") { portrait.copy(left = 200).map(20, 20) }
    }

    @Test fun swipeCoordinatesStayInsideTheImageAvoidSystemEdgesAndCannotDisguiseATap() {
        val geometry = VisualTapPolicy.Geometry(500, 1000, 20, 100, 1000, 2000, 1080, 2400)
        val mapped = geometry.mapSwipe(VisualTapPolicy.Point(250, 750), VisualTapPolicy.Point(250, 250))
        assertEquals(VisualTapPolicy.Segment(VisualTapPolicy.Point(521, 1601), VisualTapPolicy.Point(521, 601)), mapped)
        val safe = VisualTapPolicy.Point(200, 200)
        for (edge in listOf(VisualTapPolicy.Point(19, 200), VisualTapPolicy.Point(200, 19),
            VisualTapPolicy.Point(480, 200), VisualTapPolicy.Point(200, 980))) {
            error("VISUAL_TARGET_UNSAFE") { geometry.mapSwipe(edge, safe) }
            error("VISUAL_TARGET_UNSAFE") { geometry.mapSwipe(safe, edge) }
        }
        geometry.mapSwipe(VisualTapPolicy.Point(20, 200), VisualTapPolicy.Point(20, 250))
        geometry.mapSwipe(safe, VisualTapPolicy.Point(250, 200))
        error("VISUAL_TARGET_UNSAFE") { geometry.mapSwipe(safe, VisualTapPolicy.Point(249, 200)) }
        error("VISUAL_TARGET_UNSAFE") { geometry.mapSwipe(safe, safe) }
        error("INVALID_ARGUMENT") { geometry.mapSwipe(safe, VisualTapPolicy.Point(500, 200)) }
    }

    @Test fun continuousStrokeIntersectionFindsThinMidPathObstaclesWithoutBoundingBoxFalseHits() {
        val vertical = VisualTapPolicy.Segment(VisualTapPolicy.Point(40, 80), VisualTapPolicy.Point(40, 300))
        assertTrue(vertical.intersects(ScreenshotWindowPolicy.Box(39, 149, 41, 150)))
        assertFalse(vertical.intersects(ScreenshotWindowPolicy.Box(42, 149, 44, 150)))
        assertFalse(vertical.intersects(ScreenshotWindowPolicy.Box(39, 301, 41, 302)))
        val diagonal = VisualTapPolicy.Segment(VisualTapPolicy.Point(20, 20), VisualTapPolicy.Point(300, 300))
        assertTrue(diagonal.intersects(ScreenshotWindowPolicy.Box(149, 149, 150, 150)))
        assertFalse(diagonal.intersects(ScreenshotWindowPolicy.Box(20, 280, 40, 300)))
        assertFalse(diagonal.intersects(ScreenshotWindowPolicy.Box(150, 150, 150, 150)))
    }

    @Test fun targetDescriptionsAcceptNamesButStillRefuseSensitiveOrInvalidDescriptions() {
        for (description in listOf("设置", "示例群聊", "Search", "Chat list", "点击右下按钮", "打开微信首页", "进入群聊查看消息", "搜索联系人", "Open the search page", "返回上一页"))
            VisualTapPolicy.requireSafeTargetDescription(description)
        for (description in listOf("付款", "Delete", "打开付款确认", "发送消息", "删 除联系人", "搜索密码", "Open Send message", "Open authorizing transfer", "Open ＰＡＹ button", "open passcode entry"))
            error("VISUAL_TARGET_UNSAFE") { VisualTapPolicy.requireSafeTargetDescription(description) }
        for (description in listOf("", "  \n ", "a".repeat(257)))
            error("INVALID_ARGUMENT") { VisualTapPolicy.requireSafeTargetDescription(description) }
    }

    @Test fun tapAllowsRemoteVideoFramesButStillRejectsAChangedTarget() {
        val before = pixels(360, 640)
        // A video occupies most of the page; the bottom toolbar remains fixed.
        val video = pixels(360, 640).also { image ->
            for (index in 0 until 360 * 500) image.values[index] = 0xffc02090.toInt()
        }
        VisualTapPolicy.requireActionScene(before, video, 180, 580, 360, 640)
        video.values[580 * 360 + 180] = 0xff000000.toInt()
        val refusal = error("VISUAL_SCENE_CHANGED") {
            VisualTapPolicy.requireActionScene(before, video, 180, 580, 360, 640)
        }
        assertEquals(listOf(VisualTapPolicy.ComparisonTrigger.LOCAL_PIXELS), refusal.visualComparison!!.triggers)
        assertEquals(180001, refusal.visualComparison!!.globalChangedPixels)
        assertEquals(1, refusal.visualComparison!!.localChangedPixels)
        // Content replacing the target is still rejected, even within the same window.
        val replacement = pixels(360, 640).also { it.values.fill(0xff000000.toInt()) }
        error("VISUAL_SCENE_CHANGED") { VisualTapPolicy.requireActionScene(before, replacement, 180, 580, 360, 640) }
        before.close()
        assertTrue(before.values.all { it == 0 })
    }

    @Test fun browsingSwipeAllowsMotionAcrossTheWholeStrokeButStillRequiresMatchingDimensions() {
        val before = pixels(200, 200)
        fun compare(after: VisualTapPolicy.Pixels) = VisualTapPolicy.requireActionScene(before, after, 40, 100, 200, 200, swipe = true)
        compare(pixels(200, 200))
        for (x in listOf(40, 100, 160)) {
            compare(pixels(200, 200).also { it.values[100 * 200 + x] = 0xff000000.toInt() })
        }
        // Full-screen video has no stable content anchor; the service's original
        // window/lease and current overlay/native-path guards remain mandatory.
        compare(pixels(200, 200).also { it.values.fill(0xff000000.toInt()) })
        val refusal = error("VISUAL_SCENE_CHANGED") { compare(pixels(100, 200)) }
        assertEquals(listOf(VisualTapPolicy.ComparisonTrigger.DIMENSIONS), refusal.visualComparison!!.triggers)
    }

    @Test fun tapComparisonPreservesLocalNoiseThresholdsAndReportsGlobalDifferencesWithoutGlobalVeto() {
        val before = pixels()
        fun compare(after: VisualTapPolicy.Pixels) = error("VISUAL_SCENE_CHANGED") {
            VisualTapPolicy.requireActionScene(before, after, 50, 50, 100, 100)
        }.visualComparison!!
        val remote = pixels().also { for (i in 0 until 100) it.values[i] = 0xff000000.toInt() }
        VisualTapPolicy.requireActionScene(before, remote, 50, 50, 100, 100)
        val localThreshold = pixels().also { it.values[5050] = 0xff6c6060.toInt() }
        VisualTapPolicy.requireActionScene(before, localThreshold, 50, 50, 100, 100)
        localThreshold.values[5050] = 0xff000000.toInt()
        assertEquals(VisualTapPolicy.SceneComparison(listOf(VisualTapPolicy.ComparisonTrigger.LOCAL_PIXELS),
            10000, 1, 10, 6561, 1, 15), compare(localThreshold))
        val lowAmplitude = pixels().also { it.values.fill(0xff616161.toInt()) }
        assertEquals(VisualTapPolicy.SceneComparison(listOf(VisualTapPolicy.ComparisonTrigger.LOCAL_MEAN),
            10000, 0, 1000, 6561, 0, 1000), compare(lowAmplitude))
        val changed = pixels().also { it.values.fill(0xff000000.toInt()) }
        assertEquals(VisualTapPolicy.SceneComparison(listOf(VisualTapPolicy.ComparisonTrigger.LOCAL_PIXELS,
            VisualTapPolicy.ComparisonTrigger.LOCAL_MEAN), 10000, 10000, 96000, 6561, 6561, 96000), compare(changed))
        assertEquals(VisualTapPolicy.SceneComparison(listOf(VisualTapPolicy.ComparisonTrigger.DIMENSIONS),
            10000, null, null, null, null, null), compare(pixels(50, 100)))
    }

    @Test fun comparisonWireDetailsRequireExplicitPreDispatchEvidenceAndContainOnlyAggregateFields() {
        val before = pixels()
        val changed = pixels().also { it.values[5050] = 0xff000000.toInt() }
        val refusal = error("VISUAL_SCENE_CHANGED") { VisualTapPolicy.requireActionScene(before, changed, 50, 50, 100, 100) }
        assertFalse(refusal.toJson().has("details"))
        // TTL was checked before comparison; pauses during comparison may make this exceed 60s.
        refusal.visualNotSentComparison = VisualTapPolicy.NotSentComparison(refusal.visualComparison!!, 60001)
        val details = refusal.toJson().getJSONObject("details")
        assertEquals(setOf("executor", "dispatchState", "visualComparison"), details.keys().asSequence().toSet())
        assertEquals("visual-tap-v1", details.getString("executor"))
        assertEquals("not_sent", details.getString("dispatchState"))
        val diagnostics = details.getJSONObject("visualComparison")
        val numericalKeys = setOf("referenceAgeMs", "globalPixelCount", "globalChangedPixels", "globalMeanRgbMilli",
            "localPixelCount", "localChangedPixels", "localMeanRgbMilli")
        assertEquals(numericalKeys + "triggers", diagnostics.keys().asSequence().toSet())
        for (key in numericalKeys) assertTrue("Only numeric aggregates: $key", diagnostics.get(key) is Number)
        assertEquals(60001L, diagnostics.getLong("referenceAgeMs"))
        assertEquals("[\"local_pixels\"]", diagnostics.getJSONArray("triggers").toString())
        assertFalse(refusal.nativeNotSent)
        assertFalse(AgentError("VISUAL_SCENE_CHANGED", "Unrelated site").toJson().has("details"))
        assertFalse(AgentError("VISUAL_CONTEXT_CHANGED", "Different failure").also {
            it.visualNotSentComparison = refusal.visualNotSentComparison
        }.toJson().has("details"))
        val dimensions = error("VISUAL_SCENE_CHANGED") { VisualTapPolicy.requireActionScene(before, pixels(50, 100), 50, 50, 100, 100) }
        dimensions.visualNotSentComparison = VisualTapPolicy.NotSentComparison(dimensions.visualComparison!!, 20)
        val dimensionDetails = dimensions.toJson().getJSONObject("details").getJSONObject("visualComparison")
        assertEquals("[\"dimensions\"]", dimensionDetails.getJSONArray("triggers").toString())
        assertEquals(numericalKeys + "triggers", dimensionDetails.keys().asSequence().toSet())
        for (key in numericalKeys - setOf("referenceAgeMs", "globalPixelCount")) assertTrue(dimensionDetails.isNull(key))
    }

    @Test fun referencesAreSingleUseAndExpireWithoutKeepingImageMemory() {
        var now = 0L
        val store = VisualCaptureStore<Owned> { now }
        val value = Owned()
        assertTrue(store.issue("first", value, store.generation()))
        val lease = store.consume("first")
        store.requireCurrent(lease)
        error("VISUAL_REFERENCE_INVALID") { store.consume("first") }
        now = VisualTapPolicy.TTL_MS
        error("VISUAL_REFERENCE_EXPIRED") { store.requireCurrent(lease) }
        lease.value.close()
        val expired = Owned()
        assertTrue(store.issue("expired", expired, store.generation()))
        now += VisualTapPolicy.TTL_MS
        error("VISUAL_REFERENCE_EXPIRED") { store.consume("expired") }
        assertEquals(1, expired.closed)
        error("VISUAL_REFERENCE_INVALID") { store.consume("expired") }
    }

    @Test fun newScreenshotsMutationsAndLifecycleClearRevokePendingLeasesAndLateIssuance() {
        val store = VisualCaptureStore<Owned> { 0L }
        val oldGeneration = store.generation()
        val old = Owned()
        assertTrue(store.issue("old", old, oldGeneration))
        val lease = store.consume("old")
        store.clear()
        error("VISUAL_CONTEXT_CHANGED") { store.requireCurrent(lease) }
        val staleCompletion = Owned()
        assertFalse(store.issue("late", staleCompletion, oldGeneration))
        assertEquals(1, staleCompletion.closed)
        val replacement = Owned()
        assertTrue(store.issue("latest", replacement, store.generation()))
        error("VISUAL_REFERENCE_INVALID") { store.consume("old") }
        store.clear()
        assertEquals(1, replacement.closed)
        lease.value.close()
        assertEquals(1, old.closed)
    }

    @Test fun scheduledExpiryClosesOnlyItsOwnStillCurrentReference() {
        var now = 0L
        val store = VisualCaptureStore<Owned> { now }
        val first = Owned()
        store.issue("first", first, store.generation())
        store.clear()
        val second = Owned()
        store.issue("second", second, store.generation())
        now = VisualTapPolicy.TTL_MS
        store.expire("first")
        assertEquals(0, second.closed)
        store.expire("second")
        assertEquals(1, second.closed)
    }

    @Test fun rpcRequiresTypedImageCoordinatesAndDoesNotAcceptSafetyOverrideFlags() {
        val args = JSONObject().put("captureId", "synthetic").put("x", 30).put("y", 40).put("targetDescription", "打开搜索")
        ToolCatalog.validateRpc("tap_visual", args)
        ToolCatalog.validateRpc("act_and_observe", JSONObject().put("action", "tap_visual").put("arguments", args))
        for (bad in listOf(JSONObject(args.toString()).put("x", 1.5), JSONObject(args.toString()).put("y", -1),
            JSONObject(args.toString()).put("confirmed", true), JSONObject(args.toString()).put("targetDescription", "")))
            error("INVALID_ARGUMENT") { ToolCatalog.validateRpc("tap_visual", bad) }
    }

    @Test fun visualSwipeRpcUsesTheSameSingleUseContractAndBoundedOptionalDuration() {
        assertEquals(listOf("tap_visual", "swipe_visual"), VisualTapPolicy.ACTIONS)
        val args = JSONObject().put("captureId", "synthetic").put("startX", 50).put("startY", 160)
            .put("endX", 50).put("endY", 40).put("targetDescription", "合成列表")
        ToolCatalog.validateRpc("swipe_visual", args)
        ToolCatalog.validateRpc("act_and_observe", JSONObject().put("action", "swipe_visual").put("arguments", args))
        for (duration in listOf(200, 450, 1000)) ToolCatalog.validateRpc("swipe_visual", JSONObject(args.toString()).put("durationMs", duration))
        for (bad in listOf(JSONObject(args.toString()).put("startX", 1.5), JSONObject(args.toString()).put("endY", -1),
            JSONObject(args.toString()).put("durationMs", 199), JSONObject(args.toString()).put("durationMs", 1001),
            JSONObject(args.toString()).put("durationMs", 450.5), JSONObject(args.toString()).put("confirmed", true),
            JSONObject(args.toString()).also { it.remove("endX") })) error("INVALID_ARGUMENT") { ToolCatalog.validateRpc("swipe_visual", bad) }
        val accepted = JSONObject().put("action", "swipe_visual").put("accepted", true)
            .put("executor", VisualTapPolicy.CONTRACT).put("completion", "completed")
        val execution = ObservationContract.execution(accepted, null, JSONObject())
        assertEquals("sent", execution.getString("dispatch"))
        assertEquals("unknown", execution.getString("effect"))
        assertEquals("unverified", execution.getString("verification"))
    }

    private val window = ScreenshotWindowPolicy.Box(0, 0, 400, 800)
    private fun targetNode(path: List<Int>, box: ScreenshotWindowPolicy.Box, clickable: Boolean = false,
                           text: String = "", resourceId: String = "") = VisualTapPolicy.TargetNode(path, box, true, clickable,
        sensitiveLabel = VisualTapPolicy.nativeLabelIsSensitive(text, "", resourceId), hasLabel = text.isNotBlank())
    private fun compoundButton(label: String) = listOf(
        targetNode(emptyList(), window),
        targetNode(listOf(0), ScreenshotWindowPolicy.Box(20, 100, 320, 200), true, resourceId = "id/visual_container"),
        targetNode(listOf(0, 0), ScreenshotWindowPolicy.Box(100, 120, 180, 160), text = label),
    )

    @Test fun sensitiveNonClickableButtonLabelsRefuseBothTextAndBlankButtonArea() {
        for (label in listOf("付款", "删除", "发送")) {
            val nodes = compoundButton(label)
            error("VISUAL_TARGET_UNSAFE") { VisualTapPolicy.requireSafeNativeTarget(nodes, VisualTapPolicy.Point(140, 140), window) }
            error("VISUAL_TARGET_UNSAFE") { VisualTapPolicy.requireSafeNativeTarget(nodes, VisualTapPolicy.Point(30, 190), window) }
        }
    }

    @Test fun nativeSwipeChecksThinMiddleFieldsAndCompoundButtonSemanticsAcrossTheWholePath() {
        val stroke = VisualTapPolicy.Segment(VisualTapPolicy.Point(40, 80), VisualTapPolicy.Point(40, 300))
        val safe = compoundButton("打开设置")
        VisualTapPolicy.requireSafeNativeSwipe(safe, stroke, window)
        VisualTapPolicy.requireSafeNativeSwipe(emptyList(), stroke, window)
        for (label in listOf("付款", "删除", "发送")) error("VISUAL_TARGET_UNSAFE") {
            VisualTapPolicy.requireSafeNativeSwipe(compoundButton(label), stroke, window)
        }
        val icon = targetNode(listOf(0, 1), ScreenshotWindowPolicy.Box(200, 120, 230, 150), resourceId = "id/delete_icon")
        error("VISUAL_TARGET_UNSAFE") { VisualTapPolicy.requireSafeNativeSwipe(safe + icon, stroke, window) }
        val field = targetNode(listOf(1), ScreenshotWindowPolicy.Box(39, 149, 41, 150)).copy(editable = true)
        error("VISUAL_TARGET_UNSAFE") { VisualTapPolicy.requireSafeNativeSwipe(safe + field, stroke, window) }
        val leaf = targetNode(listOf(1), ScreenshotWindowPolicy.Box(39, 149, 41, 150), text = "发送")
        error("VISUAL_TARGET_UNSAFE") { VisualTapPolicy.requireSafeNativeSwipe(safe + leaf, stroke, window) }
        val remote = targetNode(listOf(1), ScreenshotWindowPolicy.Box(200, 400, 300, 450), true, text = "删除")
        VisualTapPolicy.requireSafeNativeSwipe(safe + remote, stroke, window)
        val overlap = targetNode(listOf(1), ScreenshotWindowPolicy.Box(30, 149, 60, 150), true)
        error("VISUAL_TARGET_UNSAFE") { VisualTapPolicy.requireSafeNativeSwipe(safe + overlap, stroke, window) }
        error("VISUAL_TARGET_UNSAFE") { VisualTapPolicy.requireSafeNativeSwipe(safe,
            VisualTapPolicy.Segment(VisualTapPolicy.Point(-1, 80), stroke.end), window) }
        error("CANCELLED") { VisualTapPolicy.requireSafeNativeSwipe(safe, stroke, window) { throw AgentError("CANCELLED", "synthetic") } }
    }

    @Test fun sensitiveResourceIdsUseTheNativeGuardIncludingItsUnderscoreRules() {
        for (id in listOf("id/delete_button", "id/publish_button", "id/send_icon")) {
            val nodes = listOf(targetNode(emptyList(), window),
                targetNode(listOf(0), ScreenshotWindowPolicy.Box(20, 100, 320, 200), true, resourceId = id))
            error("VISUAL_TARGET_UNSAFE") { VisualTapPolicy.requireSafeNativeTarget(nodes, VisualTapPolicy.Point(30, 190), window) }
        }
        val descendantIcon = compoundButton("") + targetNode(listOf(0, 1), ScreenshotWindowPolicy.Box(200, 120, 230, 150), resourceId = "id/delete_icon")
        error("VISUAL_TARGET_UNSAFE") { VisualTapPolicy.requireSafeNativeTarget(descendantIcon, VisualTapPolicy.Point(30, 190), window) }
    }

    @Test fun navigationButtonDoesNotInheritSensitiveTextFromAnUnrelatedPeer() {
        val nodes = compoundButton("打开设置") + listOf(
            targetNode(listOf(1), ScreenshotWindowPolicy.Box(20, 300, 320, 400), true),
            targetNode(listOf(1, 0), ScreenshotWindowPolicy.Box(100, 320, 180, 360), text = "删除"))
        VisualTapPolicy.requireSafeNativeTarget(nodes, VisualTapPolicy.Point(140, 140), window)
        VisualTapPolicy.requireSafeNativeTarget(nodes, VisualTapPolicy.Point(30, 190), window)
        // An enclosing screen wrapper must not replace the more specific button.
        VisualTapPolicy.requireSafeNativeTarget(nodes.map { if (it.path.isEmpty()) it.copy(clickable = true) else it }, VisualTapPolicy.Point(30, 190), window)
    }

    @Test fun overlappingButtonsAndScreenWideMixedContainersAreAmbiguousButEmptyCanvasRemainsUsable() {
        val overlapping = compoundButton("打开设置") + targetNode(listOf(1), ScreenshotWindowPolicy.Box(20, 100, 320, 200), true)
        error("VISUAL_TARGET_UNSAFE") { VisualTapPolicy.requireSafeNativeTarget(overlapping, VisualTapPolicy.Point(30, 190), window) }
        val wide = listOf(targetNode(emptyList(), window, true), targetNode(listOf(0), ScreenshotWindowPolicy.Box(100, 320, 180, 360), text = "删除"))
        error("VISUAL_TARGET_UNSAFE") { VisualTapPolicy.requireSafeNativeTarget(wide, VisualTapPolicy.Point(30, 190), window) }
        VisualTapPolicy.requireSafeNativeTarget(listOf(targetNode(emptyList(), window, true)), VisualTapPolicy.Point(30, 190), window)
        VisualTapPolicy.requireSafeNativeTarget(listOf(targetNode(emptyList(), ScreenshotWindowPolicy.Box(0, 0, 0, 0)).copy(visible = false)), VisualTapPolicy.Point(30, 190), window)
    }
}
