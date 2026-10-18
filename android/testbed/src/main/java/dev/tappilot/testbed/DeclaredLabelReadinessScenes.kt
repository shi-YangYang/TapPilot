package dev.tappilot.testbed

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.SystemClock
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** Exact native label allowance must remain usable without claiming that the
 * whole continuously refreshing form is globally stable. All content is synthetic.
 */
object DeclaredLabelReadinessScenes {
    val names = setOf("label_refresh_allowed", "label_refresh_undeclared", "label_refresh_recipient")

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
        root.addView(label("合成状态声明验证"), LinearLayout.LayoutParams(-1, dp(64)))
        val recipient = label("合成收件人甲", R.id.native_recipient)
        val status = label("合成状态 00000000", R.id.native_status)
        root.addView(recipient, LinearLayout.LayoutParams(-1, dp(56)))
        root.addView(status, LinearLayout.LayoutParams(-1, dp(56)))
        var scheduled = false
        var started = false
        var recipientChanged = false
        var refreshCount = 0
        var armClicks = 0
        var targetClicks = 0
        var actionAt = 0L
        OracleState.update("page" to "declared_label_initial", "refreshScheduled" to false,
            "refreshStarted" to false, "recipientChanged" to false, "armClicks" to 0,
            "targetClicks" to 0, "refreshCount" to 0, "refreshDelayMs" to 0)
        root.addView(Button(activity).apply {
            id = R.id.native_target; text = "查看预览"; isAllCaps = false
            setOnClickListener {
                targetClicks++
                val correct = scene == "label_refresh_allowed" && started && !recipientChanged && targetClicks == 1
                OracleState.click("declared_label_target", correct)
                OracleState.update("targetClicks" to targetClicks)
                if (correct) OracleState.update("completed" to true, "page" to "declared_label_selected")
                // Keep native UI unchanged and keep refreshing. A successful
                // isolated click is not proof of whole-page readiness.
            }
        }, LinearLayout.LayoutParams(-1, dp(64)))
        root.addView(Button(activity).apply {
            id = R.id.native_arm; text = "准备状态更新"; isAllCaps = false
            setOnClickListener {
                armClicks++
                OracleState.click("declared_label_arm", !scheduled)
                OracleState.update("armClicks" to armClicks)
                if (scheduled) return@setOnClickListener
                scheduled = true
                actionAt = SystemClock.uptimeMillis()
                OracleState.update("refreshScheduled" to true)
                handler.postDelayed({
                    started = true
                    if (scene == "label_refresh_recipient") {
                        recipientChanged = true
                        recipient.text = "合成收件人乙"
                        OracleState.update("recipient" to "synthetic_b", "recipientChanged" to true)
                    }
                    OracleState.update("refreshStarted" to true, "refreshDelayMs" to SystemClock.uptimeMillis() - actionAt)
                    handler.post(object : Runnable {
                        override fun run() {
                            refreshCount++
                            status.text = "合成状态 " + refreshCount.toString().padStart(8, '0')
                            OracleState.update("refreshCount" to refreshCount)
                            handler.postDelayed(this, 80)
                        }
                    })
                }, 1_400)
            }
        }, LinearLayout.LayoutParams(-1, dp(64)))
        activity.setContentView(root)
        root.requestFocus()
    }
}
