package dev.tappilot.testbed

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.random.Random
import java.util.UUID

/** An isolated test fixture. It has no permissions, network access, or production data. */
class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var body: LinearLayout
    private var dialog: AlertDialog? = null
    private var webView: WebView? = null
    private var scene = "navigation"
    private var seed = 0
    private var refreshCount = 0
    private var recipient = "synthetic_a"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        initialize(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        initialize(intent)
    }

    private fun initialize(intent: Intent) {
        handler.removeCallbacksAndMessages(null)
        dialog?.dismiss(); dialog = null
        webView?.destroy(); webView = null
        scene = intent.getStringExtra("scene")?.takeIf { it in OracleState.scenes } ?: "navigation"
        seed = intent.getIntExtra("seed", 0)
        refreshCount = 0; recipient = "synthetic_a"
        val runId = intent.getStringExtra("runId")?.let { supplied ->
            runCatching { UUID.fromString(supplied).toString() }.getOrNull()
        } ?: UUID.randomUUID().toString()
        OracleState.reset(this, scene, seed, runId)
        when (scene) {
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

    private fun screen(title: String, page: String, scroll: Boolean = false) {
        body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(32), dp(20), dp(16))
            setBackgroundColor(Color.WHITE)
        }
        if (scroll) setContentView(ScrollView(this).apply { addView(body) }) else setContentView(body)
        label("TapPilot 合成测试 · $title", 22f)
        label("仅使用页面指定的合成文字，不输入真实信息。", 13f)
        OracleState.update("page" to page)
    }

    private fun label(text: String, size: Float = 18f): TextView = TextView(this).apply {
        this.text = text; textSize = size; setTextColor(Color.BLACK)
        setPadding(0, dp(10), 0, dp(10))
        body.addView(this, LinearLayout.LayoutParams(-1, -2))
    }

    private fun button(text: String, id: Int = View.NO_ID, parent: LinearLayout = body, action: () -> Unit): Button = Button(this).apply {
        this.text = text; this.id = id
        isAllCaps = false
        setOnClickListener { action() }
        parent.addView(this, LinearLayout.LayoutParams(-1, dp(56)))
    }

    private fun input(hint: String, id: Int, field: String, expected: String): EditText = EditText(this).apply {
        this.id = id; this.hint = hint; isSingleLine = true; isSaveEnabled = false
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        setOnFocusChangeListener { _, hasFocus -> OracleState.update("focus" to if (hasFocus) field else "none") }
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = OracleState.input(field, s.toString(), expected)
            override fun afterTextChanged(s: Editable?) = Unit
        })
        body.addView(this, LinearLayout.LayoutParams(-1, dp(64)))
    }

    private fun navigation(page: String) {
        screen("三页导航", page)
        when (page) {
            "home" -> button("打开测试目录", R.id.navigation_open) { OracleState.click("directory"); navigation("directory") }
            "directory" -> {
                button("合成电池", R.id.navigation_target) { OracleState.click("battery"); navigation("battery") }
                button("合成显示") { OracleState.click("display", false) }
            }
            "battery" -> {
                label("合成电池电量：73%")
                OracleState.update("completed" to true)
            }
        }
    }

    private fun search() {
        screen("中文搜索", "search")
        label("搜索“合成电池”，打开匹配结果。")
        val field = input("输入合成关键词", R.id.search_input, "search", "合成电池")
        button("搜索", R.id.search_go) {
            OracleState.click("search_go")
            if (field.text.toString() == "合成电池") {
                (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(field.windowToken, 0)
                screen("中文搜索", "results")
                button("查看合成电池", R.id.search_result) {
                    OracleState.click("search_result"); OracleState.update("page" to "battery", "completed" to true)
                    screen("中文搜索", "battery"); label("合成商品：电池，价格 42 元")
                }
            } else label("请使用页面指定的合成关键词。")
        }
    }

    private fun asyncList() {
        screen("异步列表", "list")
        label("打开“合成目标 B”；列表会异步刷新。")
        val status = label("刷新次数：0").apply { id = R.id.async_refresh }
        val rows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        body.addView(rows)
        val random = Random(seed)
        fun populate() {
            rows.removeAllViews()
            listOf("A", "B", "C").shuffled(random).forEach { key ->
                button("合成目标 $key", if (key == "B") R.id.async_target else View.NO_ID, rows) {
                    OracleState.click("async_$key", key == "B")
                    if (key == "B") {
                        handler.removeCallbacksAndMessages(null)
                        screen("异步列表", "detail_b"); label("已打开合成目标 B")
                        OracleState.update("completed" to true)
                    }
                }
            }
        }
        populate()
        val refresh = object : Runnable {
            override fun run() {
                refreshCount++
                status.text = "刷新次数：$refreshCount"
                OracleState.update("refreshCount" to refreshCount)
                populate()
                if (refreshCount < 8) handler.postDelayed(this, 900)
            }
        }
        handler.postDelayed(refresh, 900)
    }

    private fun ime() {
        screen("输入法与焦点", "conversation_a")
        val recipientLabel = label("合成会话甲")
        label("在合成会话甲输入“合成输入”，保存草稿。不会发送消息。")
        val status = label("动态内容：0")
        val field = input("输入合成草稿", R.id.ime_input, "draft", "合成输入")
        button("打开键盘", R.id.ime_focus) {
            OracleState.click("focus_input")
            field.requestFocus()
            (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
        }
        button("保存草稿", R.id.ime_save) {
            val accepted = recipient == "synthetic_a" && field.text.toString() == "合成输入"
            OracleState.click("save_draft", accepted)
            OracleState.update("completed" to accepted, "page" to if (accepted) "draft_saved" else "draft_rejected")
            label(if (accepted) "合成草稿已保存" else "合成内容或会话不符合要求")
        }
        button("切换为合成会话乙", R.id.ime_switch) {
            recipient = "synthetic_b"; recipientLabel.text = "合成会话乙"
            OracleState.click("switch_recipient")
            OracleState.update("recipient" to recipient, "page" to "conversation_b")
        }
        val refresh = object : Runnable {
            override fun run() {
                refreshCount++; status.text = "动态内容：$refreshCount"
                OracleState.update("refreshCount" to refreshCount)
                if (refreshCount < 8) handler.postDelayed(this, 900)
            }
        }
        handler.postDelayed(refresh, 900)
    }

    private fun overlay() {
        screen("浮层遮挡", "covered")
        button("打开被遮挡目标", R.id.overlay_target) {
            val dismissed = OracleState.snapshot(this).optBoolean("overlayDismissed")
            OracleState.click("overlay_target", dismissed)
            OracleState.update("completed" to dismissed, "page" to "target")
            if (dismissed) label("已打开被遮挡目标")
        }
        dialog = AlertDialog.Builder(this).setTitle("合成遮挡层")
            .setMessage("先关闭此浮层，再打开下方目标。")
            .setCancelable(false)
            .setPositiveButton("关闭浮层") { _, _ ->
                OracleState.click("dismiss_overlay")
                OracleState.update("overlayDismissed" to true, "page" to "uncovered")
            }.show()
    }

    private fun longList() {
        screen("长列表", "list", scroll = true)
        label("找到并打开“合成项目 42”。")
        for (number in 1..60) button("合成项目 $number", if (number == 42) R.id.long_target else View.NO_ID) {
            OracleState.click("item_$number", number == 42)
            if (number == 42) {
                screen("长列表", "item_42"); label("合成项目 42 的详细信息")
                OracleState.update("completed" to true)
            }
        }
    }

    @Suppress("SetJavaScriptEnabled")
    private fun web() {
        screen("WebView", "web_form")
        webView = WebView(this).apply {
            id = R.id.web_content
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false; settings.allowContentAccess = false
            settings.blockNetworkLoads = true
            addJavascriptInterface(object {
                @JavascriptInterface fun save(value: String) {
                    runOnUiThread {
                        val accepted = value == "合成网页"
                        OracleState.input("web", value, "合成网页")
                        OracleState.click("web_save", accepted)
                        OracleState.update("completed" to accepted, "page" to if (accepted) "web_saved" else "web_form")
                    }
                }
            }, "SyntheticOracle")
            body.addView(this, LinearLayout.LayoutParams(-1, 0, 1f))
            loadDataWithBaseURL("https://fixture.invalid/", """
                <!doctype html><html lang="zh"><meta name="viewport" content="width=device-width, initial-scale=1">
                <style>body{font:20px sans-serif;padding:16px}input,button{font:20px sans-serif;padding:14px;margin:12px 0;width:100%;box-sizing:border-box}</style>
                <h2>合成网页表单</h2><label for="synthetic">输入“合成网页”后保存</label>
                <input id="synthetic" placeholder="合成网页内容" autocomplete="off">
                <button onclick="SyntheticOracle.save(document.getElementById('synthetic').value);document.getElementById('result').textContent=document.getElementById('synthetic').value==='合成网页'?'合成网页已保存':'合成内容不符合要求'">保存网页内容</button>
                <p id="result" role="status"></p></html>
            """.trimIndent(), "text/html", "utf-8", null)
        }
    }

    private fun canvas() {
        screen("自绘内容", "canvas")
        label("点击画面中的蓝色圆形按钮。此区域没有无障碍节点。")
        body.addView(SyntheticCanvas(this).apply { id = R.id.canvas_content }, LinearLayout.LayoutParams(-1, 0, 1f))
    }

    private inner class SyntheticCanvas(context: Context) : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            paint.color = Color.rgb(24, 101, 213)
            canvas.drawCircle(width / 2f, height / 2f, dp(74).toFloat(), paint)
            paint.color = Color.WHITE; paint.textSize = dp(18).toFloat(); paint.textAlign = Paint.Align.CENTER
            canvas.drawText("合成圆形按钮", width / 2f, height / 2f + dp(6), paint)
        }
        override fun onTouchEvent(event: MotionEvent): Boolean {
            if (event.actionMasked == MotionEvent.ACTION_UP) {
                val dx = event.x - width / 2f; val dy = event.y - height / 2f
                val accepted = dx * dx + dy * dy <= dp(74).toFloat().let { it * it }
                OracleState.click(if (accepted) "canvas_circle" else "canvas_miss", accepted)
                if (accepted) OracleState.update("completed" to true, "page" to "canvas_selected")
                performClick()
            }
            return true
        }
        override fun performClick(): Boolean { super.performClick(); return true }
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        dialog?.dismiss(); webView?.destroy()
        super.onDestroy()
    }
}
