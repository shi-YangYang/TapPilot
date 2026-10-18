package dev.tappilot.testbed

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.SystemClock
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.ViewTreeObserver
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/** A native setText completes immediately, while its business side effects do not.
 * Delays start in the real TextWatcher, not in the host or an accessibility read.
 */
object InputSettlingScenes {
    val names = setOf("input_enabled_500", "input_geometry_800", "input_refresh_forever")
    private const val EXPECTED = "合成输入验证"

    fun show(activity: Activity, scene: String, handler: Handler) {
        require(scene in names)
        fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(20))
            setBackgroundColor(Color.WHITE)
            isFocusableInTouchMode = true
        }
        fun label(value: String, resource: Int = View.NO_ID) = TextView(activity).apply {
            id = resource; text = value; textSize = 20f; setTextColor(Color.BLACK)
        }
        var scheduled = false
        var inputAt = 0L
        var expectedInputCount = 0
        var refreshCount = 0
        var targetClicks = 0
        var effectReady = false
        val status = label("合成状态 00000000", R.id.input_settling_status)
        val result = label("合成结果等待中", R.id.input_settling_result)
        val save = Button(activity).apply {
            id = R.id.input_settling_save; text = "保存"; isAllCaps = false; isEnabled = false
            setOnClickListener { OracleState.click("input_wrong_save", false) }
        }
        val undo = Button(activity).apply {
            id = R.id.input_settling_undo; text = "撤销"; isAllCaps = false; isEnabled = false
            setOnClickListener { OracleState.click("input_wrong_undo", false) }
        }
        fun ready() {
            effectReady = true
            OracleState.update("sideEffectReady" to true,
                "effectAfterInputMs" to SystemClock.uptimeMillis() - inputAt,
                "page" to "input_effect_ready")
        }
        val editor = EditText(activity).apply {
            id = R.id.input_settling_editor; hint = "合成输入"; isSingleLine = true; isSaveEnabled = false
            showSoftInputOnFocus = false
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun afterTextChanged(s: Editable?) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    OracleState.input("input_settling", s.toString(), EXPECTED)
                    if (s.toString() != EXPECTED) return
                    expectedInputCount++
                    OracleState.update("expectedInputCount" to expectedInputCount, "inputValueMatches" to true)
                    if (scheduled) return
                    scheduled = true
                    inputAt = SystemClock.uptimeMillis()
                    OracleState.update("inputApplied" to true, "inputAtUptimeMs" to inputAt)
                    when (scene) {
                        "input_enabled_500" -> handler.postDelayed({
                            save.isEnabled = true
                            undo.isEnabled = true
                            OracleState.update("saveEnabled" to true, "undoEnabled" to true)
                            ready()
                        }, 500)
                        "input_geometry_800" -> handler.postDelayed({
                            result.viewTreeObserver.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
                                override fun onGlobalLayout() {
                                    if (result.height != dp(168)) return
                                    result.viewTreeObserver.removeOnGlobalLayoutListener(this)
                                    OracleState.update("resultGeometryChanged" to true)
                                    ready()
                                }
                            })
                            result.text = "合成结果已加载"
                            result.layoutParams = result.layoutParams.apply { height = dp(168) }
                            OracleState.update("resultTextChanged" to true)
                        }, 800)
                        "input_refresh_forever" -> handler.post(object : Runnable {
                            override fun run() {
                                refreshCount++
                                status.text = "合成状态 " + refreshCount.toString().padStart(8, '0')
                                OracleState.update("refreshCount" to refreshCount)
                                handler.postDelayed(this, 80)
                            }
                        })
                    }
                }
            })
        }
        root.addView(label("合成输入延迟副作用"), LinearLayout.LayoutParams(-1, dp(56)))
        root.addView(editor, LinearLayout.LayoutParams(-1, dp(64)))
        root.addView(LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(Button(activity).apply {
                id = R.id.input_settling_search; text = "搜索"; isAllCaps = false
                setOnClickListener {
                    targetClicks++
                    val correct = scene != "input_refresh_forever" && effectReady &&
                        expectedInputCount == 1 && editor.text.toString() == EXPECTED && targetClicks == 1
                    OracleState.click("input_search", correct)
                    OracleState.update("targetClicks" to targetClicks,
                        "targetAfterInputMs" to SystemClock.uptimeMillis() - inputAt)
                    if (correct) OracleState.update("completed" to true)
                }
            }, LinearLayout.LayoutParams(0, dp(64), 1f))
            addView(Button(activity).apply {
                id = R.id.input_settling_close; text = "关闭"; isAllCaps = false
                setOnClickListener { OracleState.click("input_wrong_close", false) }
            }, LinearLayout.LayoutParams(0, dp(64), 1f))
        }, LinearLayout.LayoutParams(-1, dp(64)))
        root.addView(LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(save, LinearLayout.LayoutParams(0, dp(64), 1f))
            addView(undo, LinearLayout.LayoutParams(0, dp(64), 1f))
        }, LinearLayout.LayoutParams(-1, dp(64)))
        root.addView(status, LinearLayout.LayoutParams(-1, dp(56)))
        // This expands BELOW the stable search controls: the follow-up target's
        // own identity and geometry do not change, only the surrounding context.
        root.addView(result, LinearLayout.LayoutParams(-1, dp(56)))
        OracleState.update("page" to "input_settling_initial", "inputApplied" to false,
            "inputValueMatches" to false, "expectedInputCount" to 0, "sideEffectReady" to false,
            "saveEnabled" to false, "undoEnabled" to false, "resultTextChanged" to false,
            "resultGeometryChanged" to false, "effectAfterInputMs" to 0,
            "targetClicks" to 0, "targetAfterInputMs" to 0)
        activity.setContentView(root)
        root.requestFocus()
    }
}
