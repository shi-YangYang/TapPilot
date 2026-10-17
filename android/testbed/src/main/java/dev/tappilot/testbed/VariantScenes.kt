package dev.tappilot.testbed

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Handler
import android.text.Editable
import android.text.TextWatcher
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import kotlin.random.Random

/** Parameterized real Android views, with business-state verification independent of accessibility. */
class VariantScenes(private val activity: Activity, private val handler: Handler, private val variant: ScenarioVariant) {
    private lateinit var body: LinearLayout
    private var dialog: AlertDialog? = null
    private var webView: WebView? = null
    private val labels get() = variant.labels
    private var disposed = false

    fun show() {
        OracleState.update("variantId" to variant.id, "configurationError" to false,
            "layout" to variant.layout, "itemCount" to variant.itemCount, "targetIndex" to variant.targetIndex)
        when (variant.scene) {
            "navigation" -> navigation("home")
            "search" -> search()
            "async_list" -> asyncList()
            "ime" -> ime()
            "overlay" -> overlay()
            "long_list" -> longList()
            "webview" -> web()
            "canvas" -> canvas()
        }
    }

    fun close() {
        disposed = true
        dialog?.dismiss()
        webView?.destroy()
    }

    private fun later(action: () -> Unit) {
        if (variant.delayMs == 0) action()
        else handler.postDelayed({ if (!disposed) action() }, variant.delayMs.toLong())
    }

    private fun screen(title: String, page: String, scroll: Boolean = false) {
        body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(if (variant.layout == "compact") 12 else 20), dp(28), dp(20), dp(16))
            setBackgroundColor(Color.WHITE)
        }
        if (scroll) activity.setContentView(ScrollView(activity).apply { addView(body) }) else activity.setContentView(body)
        label("TapPilot 合成测试 · $title", 21f)
        OracleState.update("page" to page)
    }

    private fun label(text: String, size: Float = 18f, parent: LinearLayout = body): TextView = TextView(activity).apply {
        this.text = text; textSize = size; setTextColor(Color.BLACK)
        setPadding(dp(6), dp(8), dp(6), dp(8))
        parent.addView(this, LinearLayout.LayoutParams(-1, -2))
    }

    /** parent_label deliberately makes the text child nonclickable; the row owns the action. */
    private fun action(text: String, id: Int = View.NO_ID, parent: LinearLayout = body, handler: () -> Unit): View {
        val view = if (variant.layout == "parent_label") LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(235, 238, 243))
            label(text, parent = this)
            setOnClickListener { handler() }
        } else Button(activity).apply {
            this.text = text; isAllCaps = false
            setOnClickListener { handler() }
        }
        view.id = id
        parent.addView(view, LinearLayout.LayoutParams(-1, dp(if (variant.layout == "compact") 44 else 56)))
        return view
    }

    private fun input(id: Int, field: String): EditText = EditText(activity).apply {
        this.id = id; hint = "输入${labels.input}"; isSingleLine = true; isSaveEnabled = false
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        setOnFocusChangeListener { _, focused -> OracleState.update("focus" to if (focused) field else "none") }
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) =
                OracleState.input(field, s.toString(), labels.input)
            override fun afterTextChanged(s: Editable?) = Unit
        })
        body.addView(this, LinearLayout.LayoutParams(-1, dp(64)))
    }

    private fun completed(page: String, detail: String) {
        screen("任务结果", page)
        label(detail)
        label("合成任务已完成")
        OracleState.update("completed" to true)
    }

    private fun orderedIndices(): List<Int> = (1..variant.itemCount).toList().let { if (variant.reverse) it.reversed() else it }
    private fun rowLabel(index: Int) = if (index == variant.targetIndex) labels.target else "${labels.decoy} · $index"
    private fun wrong(index: Int) = OracleState.click("distractor_$index", false)

    private fun navigation(page: String) {
        screen("多页导航", page, scroll = true)
        if (page == "home") {
            lateinit var open: View
            open = action(labels.open, R.id.navigation_open) {
                open.isEnabled = false
                OracleState.click("directory")
                later { navigation("directory") }
            }
            action(labels.decoy, R.id.variant_distractor) { wrong(0) }
        } else later {
            orderedIndices().forEach { index ->
                action(rowLabel(index), if (index == variant.targetIndex) R.id.navigation_target else R.id.variant_distractor) {
                    if (index == variant.targetIndex) {
                        OracleState.click("battery")
                        completed("battery", "${labels.target}：73%")
                    } else wrong(index)
                }
            }
        }
    }

    private fun search() {
        screen("中文搜索", "search")
        label("搜索“${labels.input}”，打开“${labels.target}”。")
        val field = input(R.id.search_input, "search")
        action(labels.search, R.id.search_go) {
            val accepted = field.text.toString() == labels.input
            OracleState.click("search_go", accepted)
            if (!accepted) label("合成关键词不符合要求")
            else {
                (activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(field.windowToken, 0)
                screen("搜索结果", "results", scroll = true)
                later {
                    orderedIndices().forEach { index ->
                        action("查看${rowLabel(index)}", if (index == variant.targetIndex) R.id.search_result else R.id.variant_distractor) {
                            if (index == variant.targetIndex) {
                                OracleState.click("search_result")
                                completed("battery", "${labels.target}，价格 42 元")
                            } else wrong(index)
                        }
                    }
                }
            }
        }
    }

    private fun asyncList() {
        screen("异步列表", "list")
        label("打开“${labels.target}”。")
        val order = orderedIndices().toMutableList()
        val peerLabels = mutableMapOf<Int, TextView>()
        val random = Random(variant.seed)
        var ticks = 0
        var finished = false
        var orderChanges = 0
        var replacements = 0
        var peerTextChanges = 0
        var replacementGeneration = 0
        var attachedGeneration = 0
        val list = ListView(activity).apply { id = R.id.variant_list; dividerHeight = dp(2) }
        val adapter = object : BaseAdapter() {
            override fun getCount() = order.size
            override fun getItem(position: Int) = order[position]
            override fun getItemId(position: Int) = order[position].toLong()
            override fun hasStableIds() = true
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val index = order[position]
                val target = index == variant.targetIndex
                val generation = replacementGeneration
                // New real row objects expose AccessibilityNodeInfo replacement and recycling races.
                return LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    id = if (target) R.id.async_target else R.id.variant_distractor
                    contentDescription = rowLabel(index)
                    layoutParams = android.widget.AbsListView.LayoutParams(-1, dp(if (variant.layout == "compact") 64 else 88))
                    label(rowLabel(index), parent = this)
                    val detail = label(if (target) "固定内容" else "合成变化 $ticks", 13f, this)
                    if (!target) peerLabels[index] = detail
                    addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                        override fun onViewAttachedToWindow(view: View) {
                            // Construction alone is not proof of a visible node replacement.
                            if (!disposed && !finished && generation > attachedGeneration) {
                                attachedGeneration = generation
                                replacements++
                                OracleState.update("replacementCount" to replacements)
                            }
                        }
                        override fun onViewDetachedFromWindow(view: View) = Unit
                    })
                    setOnClickListener {
                        if (target) {
                            finished = true
                            OracleState.click("async_B")
                            completed("detail_b", "已打开${labels.target}")
                        } else wrong(index)
                    }
                }
            }
        }
        body.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
        later { list.adapter = adapter }
        if (variant.refreshMode != "none" && variant.refreshCount > 0) {
            val refresh = object : Runnable {
                override fun run() {
                    if (disposed || finished) return
                    ticks++
                    when (variant.refreshMode) {
                        "peer_text" -> {
                            var changed = false
                            val next = "合成变化 $ticks"
                            peerLabels.values.filter { it.isAttachedToWindow && it.text.toString() != next }.forEach {
                                it.text = next; changed = true
                            }
                            if (changed) peerTextChanges++
                        }
                        "replace" -> {
                            replacementGeneration++
                            peerLabels.clear(); list.adapter = adapter
                        }
                        "reorder" -> {
                            val previous = order.toList()
                            order.shuffle(random)
                            if (order == previous) order.add(order.removeAt(0))
                            if (order != previous) {
                                orderChanges++
                                peerLabels.clear(); adapter.notifyDataSetChanged()
                            }
                        }
                    }
                    OracleState.update("refreshCount" to ticks, "orderChangeCount" to orderChanges,
                        "peerTextChangeCount" to peerTextChanges)
                    if (ticks < variant.refreshCount) handler.postDelayed(this, variant.refreshMs.toLong())
                }
            }
            handler.postDelayed(refresh, (variant.delayMs + variant.refreshMs).toLong())
        }
    }

    private fun ime() {
        screen("输入法与焦点", "conversation_a", scroll = true)
        val recipient = label(labels.recipient)
        label("在当前会话输入“${labels.input}”，保存本地草稿。")
        val status = label("合成动态内容 0")
        val field = input(R.id.ime_input, "draft")
        var originalRecipient = true
        var finished = false
        action("打开键盘", R.id.ime_focus) {
            OracleState.click("focus_input")
            field.requestFocus()
            (activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
        }
        lateinit var save: View
        save = action(labels.save, R.id.ime_save) {
            val accepted = originalRecipient && field.text.toString() == labels.input
            OracleState.click("save_draft", accepted)
            if (accepted) {
                finished = true
                save.isEnabled = false
                (activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(field.windowToken, 0)
                later { completed("draft_saved", "合成草稿已保存") }
            } else OracleState.update("completed" to false, "page" to "draft_rejected")
        }
        action("切换到${labels.decoy}", R.id.ime_switch) {
            originalRecipient = false
            recipient.text = labels.decoy
            OracleState.click("switch_recipient", false)
            OracleState.update("recipient" to "synthetic_b", "page" to "conversation_b")
        }
        if (variant.refreshMode != "none" && variant.refreshCount > 0) {
            var ticks = 0
            var peerTextChanges = 0
            val refresh = object : Runnable {
                override fun run() {
                    if (disposed || finished) return
                    ticks++
                    val next = "合成动态内容 $ticks"
                    if (status.isAttachedToWindow && status.text.toString() != next) {
                        status.text = next
                        peerTextChanges++
                    }
                    OracleState.update("refreshCount" to ticks, "peerTextChangeCount" to peerTextChanges)
                    if (ticks < variant.refreshCount) handler.postDelayed(this, variant.refreshMs.toLong())
                }
            }
            handler.postDelayed(refresh, (variant.delayMs + variant.refreshMs).toLong())
        }
    }

    private fun overlay() {
        screen("浮层遮挡", "covered")
        val target = action(labels.target, R.id.overlay_target) {
            val dismissed = OracleState.snapshot(activity).optBoolean("overlayDismissed")
            OracleState.click("overlay_target", dismissed)
            if (dismissed) completed("target", "已打开${labels.target}")
        }
        // The target is disabled until the modal exists: initialization delay cannot create a bypass.
        target.isEnabled = false
        action(labels.decoy, R.id.variant_distractor) { wrong(0) }
        later {
            dialog = AlertDialog.Builder(activity).setTitle("合成遮挡层")
                .setMessage("先关闭浮层，再打开“${labels.target}”。")
                .setCancelable(false)
                .setPositiveButton(labels.dismiss) { _, _ ->
                    OracleState.click("dismiss_overlay")
                    OracleState.update("overlayDismissed" to true, "page" to "uncovered")
                }.show()
            target.isEnabled = true
        }
    }

    private fun longList() {
        screen("长列表", "list")
        label("找到并打开“${labels.target}”。")
        val order = orderedIndices()
        val list = ListView(activity).apply { id = R.id.variant_list; dividerHeight = dp(2) }
        val adapter = object : BaseAdapter() {
            override fun getCount() = order.size
            override fun getItem(position: Int) = order[position]
            override fun getItemId(position: Int) = order[position].toLong()
            override fun hasStableIds() = true
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val index = order[position]
                val target = index == variant.targetIndex
                val container = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
                val row = action(rowLabel(index), if (target) R.id.long_target else R.id.variant_distractor, container) {
                    if (target) {
                        OracleState.click("item_42")
                        completed("item_42", "${labels.target}的详细信息")
                    } else wrong(index)
                }
                container.removeView(row)
                row.layoutParams = android.widget.AbsListView.LayoutParams(-1, dp(if (variant.layout == "compact") 44 else 56))
                return row
            }
        }
        body.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
        later { list.adapter = adapter }
    }

    @Suppress("SetJavaScriptEnabled")
    private fun web() {
        screen("WebView", "web_form")
        val expected = html(JSONObject.quote(labels.input))
        webView = WebView(activity).apply {
            id = R.id.web_content
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false; settings.allowContentAccess = false; settings.blockNetworkLoads = true
            addJavascriptInterface(object {
                @JavascriptInterface fun save(value: String) {
                    activity.runOnUiThread {
                        if (disposed) return@runOnUiThread
                        val accepted = value == labels.input
                        OracleState.input("web", value, labels.input)
                        OracleState.click("web_save", accepted)
                        OracleState.update("completed" to accepted, "page" to if (accepted) "web_saved" else "web_form")
                    }
                }
                @JavascriptInterface fun decoy() { activity.runOnUiThread { if (!disposed) wrong(0) } }
            }, "SyntheticOracle")
            body.addView(this, LinearLayout.LayoutParams(-1, 0, 1f))
            val saveLabel = if (variant.layout == "parent_label") "<span>${html(labels.save)}</span>" else html(labels.save)
            val save = """<button id="save" onclick="const v=document.getElementById('synthetic').value;SyntheticOracle.save(v);document.getElementById('result').textContent=v===$expected?'合成任务已完成':'合成内容不符合要求'">$saveLabel</button>"""
            val decoy = """<button id="decoy" onclick="SyntheticOracle.decoy()">${html(labels.decoy)}</button>"""
            val buttons = if (variant.reverse) decoy + save else save + decoy
            val page = """
                <!doctype html><html lang="zh"><meta name="viewport" content="width=device-width, initial-scale=1">
                <style>body{font:20px sans-serif;padding:16px}input,button{font:20px sans-serif;padding:${if (variant.layout == "compact") 8 else 14}px;margin:12px 0;width:100%;box-sizing:border-box}</style>
                <h2>${html(labels.target)}</h2><label for="synthetic">输入“${html(labels.input)}”后${html(labels.save)}</label>
                <input id="synthetic" placeholder="合成网页内容" autocomplete="off">$buttons
                <p id="result" role="status"></p></html>
            """.trimIndent()
            later { loadDataWithBaseURL("https://fixture.invalid/", page, "text/html", "utf-8", null) }
        }
    }

    private fun canvas() {
        screen("自绘内容", "canvas")
        label("点击蓝色圆形按钮。此区域没有无障碍节点。")
        body.addView(object : View(activity) {
            private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            private val horizontal = if (variant.reverse) 0.68f else 0.32f
            private val vertical = 0.3f + 0.4f * (variant.targetIndex - 1) / (variant.itemCount - 1)
            private fun radius() = dp(if (variant.layout == "compact") 48 else 64).toFloat()
            init { id = R.id.canvas_content; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
            override fun onDraw(canvas: Canvas) {
                paint.color = Color.rgb(24, 101, 213)
                canvas.drawCircle(width * horizontal, height * vertical, radius(), paint)
                paint.color = Color.WHITE; paint.textSize = dp(14).toFloat(); paint.textAlign = Paint.Align.CENTER
                canvas.drawText("合成圆形按钮", width * horizontal, height * vertical + dp(5), paint)
            }
            override fun onTouchEvent(event: MotionEvent): Boolean {
                if (event.actionMasked == MotionEvent.ACTION_UP) {
                    val dx = event.x - width * horizontal; val dy = event.y - height * vertical
                    val accepted = dx * dx + dy * dy <= radius() * radius()
                    OracleState.click(if (accepted) "canvas_circle" else "canvas_miss", accepted)
                    if (accepted) OracleState.update("completed" to true, "page" to "canvas_selected")
                    performClick()
                }
                return true
            }
            override fun performClick(): Boolean { super.performClick(); return true }
        }, LinearLayout.LayoutParams(-1, 0, 1f))
    }

    private fun html(value: String) = value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\"", "&quot;").replace("'", "&#39;")
    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
}
