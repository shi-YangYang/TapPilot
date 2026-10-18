package dev.tappilot.testbed

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Handler
import android.text.Editable
import android.text.TextWatcher
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/** Event notifications, visible effects and business success are deliberately independent. */
class SemanticObservationScenes(private val activity: Activity, private val handler: Handler, private val scene: String) {
    companion object {
        val names = setOf(
            "semantic_event_noise", "semantic_blank", "semantic_delayed", "semantic_selector",
            "semantic_window", "semantic_noop", "semantic_input", "semantic_selector_visible",
            "semantic_blank_recovery", "semantic_text_only", "semantic_large_noise",
            "screenshot_secure", "screenshot_password"
        )
    }

    private var dialog: AlertDialog? = null
    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()

    fun show() {
        require(scene in names)
        val seed = activity.intent.getIntExtra("seed", 0)
        val delayMs = 2_200L + Math.floorMod(seed, 3) * 80L
        val noiseMs = 60L + Math.floorMod(seed, 3) * 15L
        val body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(20))
            setBackgroundColor(Color.WHITE)
            isFocusableInTouchMode = true
        }
        fun label(text: String, id: Int) = TextView(activity).apply {
            this.id = id; this.text = text; textSize = 20f; setTextColor(Color.BLACK)
            body.addView(this, LinearLayout.LayoutParams(-1, dp(64)))
        }
        fun blank() {
            // This really has visible pixels, but no accessibility text, actions or descendants.
            // System bars are outside this activity's accessibility root.
            activity.setContentView(object : View(activity) {
                private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; textSize = dp(20).toFloat() }
                init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS; setBackgroundColor(Color.WHITE) }
                override fun onDraw(canvas: Canvas) {
                    super.onDraw(canvas)
                    canvas.drawText("仅画布内容", dp(20).toFloat(), dp(80).toFloat(), paint)
                }
            })
        }
        OracleState.update("page" to "semantic_ready", "eventCount" to 0, "effectCount" to 0)
        if (scene == "screenshot_secure") {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            blank()
            return
        }
        if (scene == "semantic_blank") { blank(); return }
        activity.setContentView(body)
        label("合成观察测试", R.id.semantic_status)
        if (scene == "semantic_text_only") return
        if (scene == "screenshot_password") {
            activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
            body.addView(EditText(activity).apply {
                id = R.id.semantic_input
                hint = "合成密码控件（无真实数据）"
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                isSaveEnabled = false
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
                showSoftInputOnFocus = false
            }, LinearLayout.LayoutParams(-1, dp(64)))
            body.requestFocus()
            return
        }

        if (scene == "semantic_input") {
            body.addView(EditText(activity).apply {
                id = R.id.semantic_input; hint = "输入合成内容"; isSingleLine = true; isSaveEnabled = false
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                        OracleState.input("semantic_field", s.toString(), "中文输入验证")
                        if (s.toString() == "中文输入验证") OracleState.update("completed" to true, "page" to "semantic_typed")
                    }
                    override fun afterTextChanged(s: Editable?) = Unit
                })
            }, LinearLayout.LayoutParams(-1, dp(64)))
            body.requestFocus()
            return
        }

        if (scene in setOf("semantic_noop", "semantic_event_noise", "semantic_large_noise", "semantic_selector_visible")) {
            body.addView(Button(activity).apply {
                id = R.id.semantic_target; text = "合成空操作"; isAllCaps = false
                setOnClickListener {
                    // The framework accepts this callback, but no visible or business effect occurs.
                    OracleState.click("semantic_noop")
                }
            }, LinearLayout.LayoutParams(-1, dp(56)))
        }
        if (scene == "semantic_large_noise") {
            // More than the default 300-node capture budget, still fully visible.
            // Every text/geometry stays fixed; only unrelated events are emitted.
            repeat(330) { index ->
                body.addView(TextView(activity).apply {
                    text = "合成项 $index"; textSize = 1f; setTextColor(Color.BLACK)
                    includeFontPadding = false
                    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
                }, LinearLayout.LayoutParams(-1, dp(1)))
            }
        }
        if (scene in setOf("semantic_event_noise", "semantic_large_noise")) {
            val noise = object : Runnable {
                var count = 0
                override fun run() {
                    body.sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
                    OracleState.update("eventCount" to ++count)
                    if (count < 150) this@SemanticObservationScenes.handler.postDelayed(this, noiseMs)
                }
            }
            this@SemanticObservationScenes.handler.postDelayed(noise, noiseMs)
        }

        if (scene in setOf("semantic_delayed", "semantic_selector", "semantic_window", "semantic_blank_recovery")) {
            body.addView(Button(activity).apply {
                id = R.id.semantic_arm; text = "准备变化"; isAllCaps = false
                setOnClickListener {
                    if (!OracleState.snapshot(activity).optBoolean("armed")) {
                        OracleState.update("armed" to true)
                        if (scene == "semantic_blank_recovery") blank()
                        // View.handler becomes null when blank() detaches this button.
                        // Always schedule against the activity-owned main handler.
                        this@SemanticObservationScenes.handler.postDelayed({
                            if (scene == "semantic_window") {
                                dialog = AlertDialog.Builder(activity).setTitle("合成新窗口")
                                    .setMessage("窗口身份已经改变")
                                    .setCancelable(false)
                                    .setPositiveButton("合成关闭") { _, _ -> OracleState.click("semantic_wrong", false) }
                                    .show()
                            } else {
                                if (scene == "semantic_blank_recovery") activity.setContentView(body)
                                label("合成内容已到达", R.id.semantic_result)
                            }
                            OracleState.update("changed" to true, "effectCount" to 1, "page" to "semantic_changed")
                        }, delayMs)
                    }
                }
            }, LinearLayout.LayoutParams(-1, dp(56)))
        }
        body.requestFocus()
    }

    fun close() {
        dialog?.dismiss(); dialog = null
        if (scene == "screenshot_secure") activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (scene == "screenshot_password") activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_UNSPECIFIED)
    }
}
