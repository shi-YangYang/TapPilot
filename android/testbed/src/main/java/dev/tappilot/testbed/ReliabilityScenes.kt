package dev.tappilot.testbed

import android.app.Activity
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Handler
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/** Temporal executor contracts with business counters independent of the accessibility response. */
object ReliabilityScenes {
    val names = setOf("reliability_delayed_input", "reliability_silent_input", "reliability_noop",
        "reliability_toggle", "reliability_input_transform")

    fun show(activity: Activity, scene: String, handler: Handler) {
        require(scene in names)
        val seed = activity.intent.getIntExtra("seed", 0)
        val delayMs = 650L + Math.floorMod(seed, 3) * 100L
        fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
        var suppress = false
        var suppressed = 0
        val body = object : LinearLayout(activity) {
            override fun requestSendAccessibilityEvent(child: View, event: AccessibilityEvent): Boolean {
                if (suppress && event.eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
                    OracleState.update("suppressedContentEvents" to ++suppressed)
                    return false
                }
                return super.requestSendAccessibilityEvent(child, event)
            }
        }.apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(20))
            setBackgroundColor(Color.WHITE)
            isFocusableInTouchMode = true
        }
        activity.setContentView(body)
        OracleState.update("page" to "reliability_ready", "suppressedContentEvents" to 0,
            "inputEvents" to 0, "checked" to false, "expectedDelayMs" to delayMs)
        fun label(value: String) = TextView(activity).apply {
            id = R.id.reliability_status; text = value; textSize = 20f; setTextColor(Color.BLACK)
            body.addView(this, LinearLayout.LayoutParams(-1, dp(56)))
        }
        fun editor(transform: Boolean = false) {
            var mutating = false
            var inputEvents = 0
            body.addView(EditText(activity).apply {
                id = R.id.reliability_input; hint = "输入合成中文"; isSingleLine = true
                isSaveEnabled = false; showSoftInputOnFocus = false
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                    override fun afterTextChanged(s: Editable?) {
                        if (mutating) return
                        inputEvents++
                        if (transform && s?.toString() == "中文输入验证") {
                            mutating = true
                            s.replace(0, s.length, "合成拒绝值")
                            mutating = false
                        }
                        val actual = s?.toString().orEmpty()
                        OracleState.input("reliability_field", actual, "中文输入验证")
                        OracleState.update("inputEvents" to inputEvents,
                            "completed" to (actual == "中文输入验证"),
                            "page" to if (actual == "中文输入验证") "reliability_typed" else "reliability_input_changed")
                    }
                })
            }, LinearLayout.LayoutParams(-1, dp(64)))
            body.requestFocus()
        }
        label("合成执行结果验证")
        if (scene == "reliability_input_transform") { editor(transform = true); return }
        if (scene == "reliability_toggle") {
            body.addView(CheckBox(activity).apply {
                id = R.id.reliability_target; text = "合成开关"
                setOnCheckedChangeListener { _, checked ->
                    OracleState.click("reliability_toggle", checked)
                    OracleState.update("checked" to checked, "completed" to checked, "page" to "reliability_toggled")
                }
            }, LinearLayout.LayoutParams(-1, dp(64)))
            return
        }
        body.addView(Button(activity).apply {
            id = R.id.reliability_target; text = "打开合成输入页"; isAllCaps = false
            setOnClickListener {
                OracleState.click(if (scene == "reliability_noop") "reliability_noop" else "reliability_open")
                if (scene == "reliability_noop") return@setOnClickListener
                body.removeAllViews()
                body.addView(object : View(activity) {
                    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; textSize = dp(20).toFloat() }
                    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS }
                    override fun onDraw(canvas: Canvas) {
                        canvas.drawText("合成加载中", dp(10).toFloat(), dp(80).toFloat(), paint)
                    }
                }, LinearLayout.LayoutParams(-1, dp(150)))
                OracleState.update("page" to "reliability_loading", "armed" to true)
                handler.postDelayed({
                    suppress = scene == "reliability_silent_input"
                    body.removeAllViews()
                    editor()
                    // An actual descendant content notification is swallowed by the fixture,
                    // so the comparison cannot pass without exercising the missing-event case.
                    if (suppress) body.getChildAt(0).sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
                    OracleState.update("page" to "reliability_input_ready", "changed" to true)
                }, delayMs)
            }
        }, LinearLayout.LayoutParams(-1, dp(56)))
        body.requestFocus()
    }
}
