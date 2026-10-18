package dev.tappilot.testbed

import android.app.UiAutomation
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Read-only oracle for allowlisted public flows. Never invokes TapPilot or clicks. */
@RunWith(AndroidJUnit4::class)
class RealAppObservationInstrumentedTest {
    /** Fixed structural evidence for a live hit-test failure; no labels or input values. */
    @Test fun observeNativeDrawingOrder() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("realAppDrawingOrder") == "true")
        assertTrue("real-app oracle is emulator-only", Build.HARDWARE in setOf("ranchu", "goldfish"))
        val packageName = requireNotNull(args.getString("packageName"))
        require(packageName in setOf("com.xunmeng.pinduoduo", "org.wikipedia", "de.danoeh.antennapod", "net.gsantner.markor", "org.fossify.math", "org.fossify.filemanager", "org.schabi.newpipe", "org.fossify.clock"))
        val ui = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        if (Build.VERSION.SDK_INT >= 34) ui.clearCache()
        val root = requireNotNull(ui.rootInActiveWindow)
        val nodes = JSONArray()
        try {
            require(root.packageName?.toString() == packageName)
            fun visit(node: AccessibilityNodeInfo, path: String, parent: String?) {
                require(nodes.length() < 500)
                val bounds = Rect(); node.getBoundsInScreen(bounds)
                nodes.put(JSONObject().put("path", path).put("parent", parent ?: JSONObject.NULL)
                    .put("className", node.className?.toString()).put("drawingOrder", node.drawingOrder)
                    .put("bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)))
                    .put("clickable", node.isClickable).put("scrollable", node.isScrollable)
                    .put("visible", node.isVisibleToUser).put("childCount", node.childCount)
                    .put("selected", node.isSelected)
                    .put("collection", node.collectionInfo?.let { info -> JSONObject().put("rows", info.rowCount)
                        .put("columns", info.columnCount).put("selectionMode", info.selectionMode) } ?: JSONObject.NULL)
                    .put("item", node.collectionItemInfo?.let { item -> JSONObject().put("row", item.rowIndex)
                        .put("column", item.columnIndex).put("selected", item.isSelected) } ?: JSONObject.NULL)
                    .put("tabRole", node.extras.getCharSequence("AccessibilityNodeInfo.roleDescription")?.toString() == "Tab"))
                for (index in 0 until node.childCount) {
                    val child = node.getChild(index) ?: continue
                    try { visit(child, "$path/$index", path) } finally { child.recycle() }
                }
            }
            visit(root, "root", null)
            File(instrumentation.targetContext.filesDir, "real-app-drawing-order.json").writeText(
                JSONObject().put("packageName", packageName).put("nodes", nodes).toString())
        } finally { root.recycle() }
    }

    @Test fun observePublicSearch() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("realAppObservation") == "true")
        assertTrue("real-app oracle is emulator-only", Build.HARDWARE in setOf("ranchu", "goldfish"))
        val packageName = requireNotNull(args.getString("packageName"))
        require(packageName in setOf("com.xunmeng.pinduoduo", "org.wikipedia", "de.danoeh.antennapod", "net.gsantner.markor", "org.fossify.math", "org.fossify.filemanager", "org.schabi.newpipe", "org.fossify.clock"))
        val query = requireNotNull(args.getString("query"))
        require(query.length in 1..40 && query.matches(Regex("[\\p{L}\\p{N} ·-]+")) && !Regex("\\d{6,}").containsMatchIn(query))
        val stage = requireNotNull(args.getString("stage"))
        require(stage in setOf("search_input", "search_results", "assertions"))
        require(stage == "assertions" || packageName == "com.xunmeng.pinduoduo")
        val assertions = if (stage == "assertions") {
            val encoded = requireNotNull(args.getString("assertionsBase64"))
            require(encoded.length <= 32_000)
            JSONArray(String(Base64.decode(encoded, Base64.DEFAULT), Charsets.UTF_8)).also(::validateAssertions)
        } else null
        val timeout = args.getString("timeoutMs")?.toLong() ?: 2500L
        require(timeout in 0..10_000)
        val runId = UUID.fromString(requireNotNull(args.getString("runId"))).toString()
        val config = Configurator.getInstance()
        val oldIdle = config.waitForIdleTimeout
        val oldFlags = config.uiAutomationFlags
        config.waitForIdleTimeout = 0
        config.uiAutomationFlags = UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
        val ui = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        val device = UiDevice.getInstance(instrumentation)
        val started = SystemClock.uptimeMillis()
        val deadline = started + timeout
        fun baseReport() = JSONObject().put("schemaVersion", 1).put("runId", runId)
            .put("packageName", packageName).put("stage", stage)
        var report = JSONObject()
        try {
            do {
                try {
                    // This is a separate client from TapPilot; invalidate its own cached roots.
                    if (Build.VERSION.SDK_INT >= 34) ui.clearCache()
                    val nodes = device.findObjects(By.pkg(packageName))
                    val packageMatched = device.currentPackageName == packageName
                    if (assertions != null) {
                        val checks = JSONArray()
                        var verified = packageMatched
                        for (index in 0 until assertions.length()) {
                            val assertion = assertions.getJSONObject(index)
                            val selector = assertion.getJSONObject("selector")
                            val count = nodes.count { nodeMatches(it, selector) }
                            val passed = count in assertion.getInt("minCount")..assertion.getInt("maxCount")
                            checks.put(JSONObject().put("id", assertion.getString("id")).put("count", count).put("passed", passed))
                            verified = verified && passed
                        }
                        report = baseReport().put("packageMatched", packageMatched).put("checks", checks)
                            .put("nodeCount", nodes.size).put("observationSampled", true)
                            .put("verdict", if (verified) "verified" else "unverified")
                            .put("durationMs", SystemClock.uptimeMillis() - started)
                        if (verified) break
                    } else {
                    // Complete one local sample before publishing any evidence. If a node
                    // becomes stale, discard every field from this attempt rather than merge
                    // labels or checks from different UI generations.
                    val labels = nodes.flatMap { listOfNotNull(it.text, it.contentDescription) }.map(String::trim).toSet()
                    val queryVisible = query in labels
                    // UiObject2.text can expose an empty field's hint. Its public API
                    // lacks isShowingHintText, so equal hint/value is conservatively
                    // uncertain rather than proof of typed input.
                    val editableQuery = nodes.any {
                        it.className == "android.widget.EditText" && it.text?.trim() == query && it.hint?.trim() != query
                    }
                    val searchAction = "搜索" in labels
                    val resultMarkers = setOf("综合", "销量", "价格", "筛选", "品牌").count { it in labels }
                    val noResults = labels.any { it.contains("没有找到相关商品") || it.contains("暂无搜索结果") }
                    val loading = labels.any { it == "加载中" || it == "加载中…" || it == "加载中..." }
                    val loginGate = "微信登录" in labels && "其他方式登录" in labels &&
                        setOf("手机号", "QQ", "数字身份").any { it in labels }
                    val blocked = loginGate || labels.any { text -> listOf("请先登录", "登录后搜索", "安全验证", "拖动滑块", "完成验证", "网络不给力").any(text::contains) }
                    val verified = packageMatched && !blocked && !loading && when (stage) {
                        "search_input" -> editableQuery
                        else -> queryVisible && (resultMarkers >= 2 || noResults)
                    }
                    report = baseReport().put("packageMatched", packageMatched).put("queryVisible", queryVisible)
                        .put("editableQueryVisible", editableQuery).put("searchActionVisible", searchAction)
                        .put("resultMarkerCount", resultMarkers).put("noResultsVisible", noResults)
                        .put("loadingVisible", loading).put("blocked", blocked).put("nodeCount", nodes.size)
                        .put("loginRequired", loginGate).put("observationSampled", true)
                        .put("verdict", if (blocked) "blocked" else if (verified) "verified" else "unverified")
                        .put("durationMs", SystemClock.uptimeMillis() - started)
                    if (verified || blocked) break
                    }
                } catch (_: StaleObjectException) {
                    report = baseReport().put("verdict", "unverified").put("observationSampled", false)
                        .put("reason", "UI_CHANGED_DURING_OBSERVATION")
                        .put("durationMs", SystemClock.uptimeMillis() - started)
                }
                val remaining = deadline - SystemClock.uptimeMillis()
                if (remaining <= 0) break
                SystemClock.sleep(minOf(100, remaining))
            } while (SystemClock.uptimeMillis() < deadline)
            File(instrumentation.targetContext.filesDir, "real-app-observation.json").writeText(report.toString())
        } finally {
            config.waitForIdleTimeout = oldIdle
            config.uiAutomationFlags = oldFlags
        }
    }

    private fun validateAssertions(assertions: JSONArray) {
        require(assertions.length() in 1..20)
        val ids = mutableSetOf<String>()
        val strings = setOf("text", "resourceId", "contentDescription", "className")
        val booleans = setOf("checked", "editable", "enabled", "selected", "scrollable")
        for (index in 0 until assertions.length()) {
            val assertion = assertions.getJSONObject(index)
            require(assertion.keys().asSequence().all { it in setOf("id", "selector", "minCount", "maxCount") })
            val id = assertion.getString("id")
            require(id.matches(Regex("[a-z][a-z0-9_]{0,63}")) && ids.add(id))
            val minimum = assertion.getInt("minCount")
            val maximum = assertion.getInt("maxCount")
            require(minimum in 0..500 && maximum in minimum..500 && (minimum != 0 || maximum == 0))
            val selector = assertion.getJSONObject("selector")
            require(selector.length() > 0)
            selector.keys().forEach { key ->
                val value = selector.get(key)
                require(if (key in strings) value is String && value.length in 1..300 &&
                    value.none { it.code < 32 || it.code == 127 } else key in booleans && value is Boolean)
            }
        }
    }

    /** Every property must hold on the same live object, not unrelated matching labels. */
    private fun nodeMatches(node: UiObject2, selector: JSONObject): Boolean {
        if (node.visibleBounds.isEmpty) return false
        return selector.keys().asSequence().all { key ->
            when (key) {
                "text" -> node.text == selector.getString(key) &&
                    (node.className != "android.widget.EditText" || node.hint != node.text)
                "resourceId" -> node.resourceName == selector.getString(key)
                "contentDescription" -> node.contentDescription == selector.getString(key)
                "className" -> node.className == selector.getString(key)
                "checked" -> node.isCheckable && node.isChecked == selector.getBoolean(key)
                "editable" -> (node.className == "android.widget.EditText") == selector.getBoolean(key)
                "enabled" -> node.isEnabled == selector.getBoolean(key)
                "selected" -> node.isSelected == selector.getBoolean(key)
                "scrollable" -> node.isScrollable == selector.getBoolean(key)
                else -> false
            }
        }
    }
}
