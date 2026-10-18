package dev.tappilot.testbed

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.SystemClock
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

/** Delayed app-owned work starts after the triggering action already returned a
 * stable old page. This exercises a later ordinary get_ui_tree in the same window.
 */
object LateTransitionReadinessScenes {
    val names = setOf("late_multistage_editor", "late_loading_editor", "late_never_ready")

    fun show(activity: Activity, scene: String, handler: Handler) {
        require(scene in names)
        fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(20))
            setBackgroundColor(Color.WHITE)
            isFocusableInTouchMode = true
        }
        val body = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        var scheduled = false
        var transitioning = false
        var ready = false
        var actionAt = 0L
        var transitionAt = 0L
        var phaseCount = 0
        var intermediateSamples = 0
        var refreshCount = 0
        val phase = object : TextView(activity) {
            override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(info)
                if (transitioning && !ready) {
                    intermediateSamples++
                    OracleState.update("intermediateSamples" to intermediateSamples)
                }
            }
        }.apply {
            id = R.id.action_readiness_phase
            text = "合成延后更新页面"; textSize = 22f; setTextColor(Color.BLACK)
        }
        fun label(value: String) = TextView(activity).apply {
            text = value; textSize = 18f; setTextColor(Color.BLACK)
        }
        fun status(value: String) {
            phase.text = value
            phaseCount++
            OracleState.update("phaseCount" to phaseCount)
        }
        fun intermediate(number: Int) {
            body.removeAllViews()
            body.addView(label("延后过渡内容 $number"), LinearLayout.LayoutParams(-1, dp(48)))
            body.addView(Button(activity).apply {
                id = R.id.action_readiness_intermediate
                text = "临时入口"; isAllCaps = false
                setOnClickListener { OracleState.click("late_intermediate", false) }
            }, LinearLayout.LayoutParams(-1, dp(64)))
            status("延后更新阶段 $number")
        }
        fun showEditor() {
            body.removeAllViews()
            body.addView(label("合成延后编辑器"), LinearLayout.LayoutParams(-1, dp(48)))
            body.addView(EditText(activity).apply {
                id = R.id.action_readiness_editor
                hint = "合成文字"; isSingleLine = true; isSaveEnabled = false
                showSoftInputOnFocus = false
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            }, LinearLayout.LayoutParams(-1, dp(64)))
            root.requestFocus()
            status("延后编辑器已就绪")
            ready = true
            OracleState.update("transitionReady" to true, "editorMounted" to true, "completed" to true,
                "readyAfterTransitionMs" to SystemClock.uptimeMillis() - transitionAt,
                "page" to "late_transition_final")
        }
        fun beginTransition() {
            transitioning = true
            transitionAt = SystemClock.uptimeMillis()
            OracleState.update("transitionStarted" to true, "transitionDelayMs" to transitionAt - actionAt,
                "page" to "late_transition_active")
            when (scene) {
                "late_multistage_editor" -> {
                    intermediate(0)
                    for (number in 1..3) handler.postDelayed({ intermediate(number) }, number * 160L)
                    handler.postDelayed({ showEditor() }, 600)
                }
                "late_loading_editor" -> {
                    body.removeAllViews()
                    body.addView(ProgressBar(activity), LinearLayout.LayoutParams(dp(48), dp(48)))
                    status("正在载入延后内容")
                    handler.postDelayed({ showEditor() }, 600)
                }
                "late_never_ready" -> {
                    intermediate(0)
                    handler.post(object : Runnable {
                        override fun run() {
                            status("持续延后更新 ${++refreshCount}")
                            OracleState.update("refreshCount" to refreshCount)
                            handler.postDelayed(this, 70)
                        }
                    })
                }
            }
        }
        OracleState.update("page" to "late_transition_initial", "transitionScheduled" to false,
            "transitionStarted" to false, "transitionReady" to false, "editorMounted" to false,
            "phaseCount" to 0, "intermediateSamples" to 0, "refreshCount" to 0,
            "transitionDelayMs" to 0, "readyAfterTransitionMs" to 0)
        root.addView(phase, LinearLayout.LayoutParams(-1, dp(64)))
        root.addView(body, LinearLayout.LayoutParams(-1, -2))
        body.addView(Button(activity).apply {
            id = R.id.action_readiness_start
            text = "安排延后更新"; isAllCaps = false
            setOnClickListener {
                OracleState.click("late_transition_start", !scheduled)
                if (scheduled) return@setOnClickListener
                scheduled = true
                actionAt = SystemClock.uptimeMillis()
                OracleState.update("transitionScheduled" to true)
                // No UI mutation here. The action must first return this same
                // stable page; the harness independently checks that it did.
                handler.postDelayed({ beginTransition() }, 1_400)
            }
        }, LinearLayout.LayoutParams(-1, dp(64)))
        activity.setContentView(root)
        root.requestFocus()
    }
}
