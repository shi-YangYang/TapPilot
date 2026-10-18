package dev.tappilot.testbed

import android.app.Activity
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import android.view.Gravity
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray

/** Synthetic pixels only. The independent oracle records delivered touches, not tool claims. */
object VisualActionScenes {
    val names = setOf("visual_action_chain", "visual_action_sensitive", "visual_swipe_chain")

    fun show(activity: Activity, scene: String) {
        require(scene in names)
        fun dp(value: Int) = value * activity.resources.displayMetrics.density
        if (scene == "visual_swipe_chain") {
            val body = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(Color.WHITE)
            }
            body.addView(TextView(activity).apply {
                id = R.id.visual_action_native_result
                text = "合成卡片"
                textSize = 24f
                setTextColor(Color.BLACK)
                gravity = Gravity.CENTER
            }, LinearLayout.LayoutParams(-1, dp(72).toInt()))
            val canvas = object : View(activity) {
                private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
                private var startX = 0f
                private var startY = 0f
                private var down = false
                private var consumed = false
                init {
                    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                    setBackgroundColor(Color.rgb(232, 244, 255))
                }
                override fun onDraw(canvas: Canvas) {
                    super.onDraw(canvas)
                    paint.color = Color.rgb(18, 69, 120)
                    canvas.drawRoundRect(width * .12f, height * .25f, width * .88f, height * .75f, dp(18), dp(18), paint)
                    paint.color = Color.WHITE
                    paint.textAlign = Paint.Align.CENTER
                    paint.textSize = dp(22)
                    canvas.drawText("向左滑动查看合成详情", width / 2f, height / 2f, paint)
                }
                override fun onTouchEvent(event: MotionEvent): Boolean {
                    when (event.actionMasked) {
                        MotionEvent.ACTION_DOWN -> { startX = event.x; startY = event.y; down = true }
                        MotionEvent.ACTION_UP -> {
                            val correct = !consumed && down && startX in width * .6f..width * .9f &&
                                event.x in width * .1f..width * .4f && startX - event.x >= width * .35f &&
                                kotlin.math.abs(startY - event.y) <= height * .12f && startY in height * .3f..height * .7f
                            val prior = OracleState.snapshot(activity)
                            OracleState.update("swipeCount" to prior.optInt("swipeCount") + 1,
                                "wrongGestures" to prior.optInt("wrongGestures") + if (correct) 0 else 1)
                            down = false
                            if (correct) {
                                consumed = true
                                body.removeView(this)
                                body.addView(Button(activity).apply {
                                    id = R.id.visual_action_native_target
                                    text = "合成详情"
                                    isAllCaps = false
                                    setOnClickListener { OracleState.click("visual_swipe_unexpected_click", false) }
                                }, LinearLayout.LayoutParams(-1, dp(72).toInt()))
                                OracleState.update("page" to "visual_swipe_native", "completed" to true)
                            }
                        }
                        MotionEvent.ACTION_CANCEL -> {
                            // removeView during ACTION_UP can synchronously cancel the parent's
                            // old touch target. That gesture already ended; only an active DOWN
                            // can be interrupted. Real cancellations before UP still fail the oracle.
                            if (down) {
                                down = false
                                val prior = OracleState.snapshot(activity)
                                OracleState.update("cancelledGestures" to prior.optInt("cancelledGestures") + 1)
                            }
                        }
                    }
                    return true
                }
            }
            body.addView(canvas, LinearLayout.LayoutParams(-1, 0, 1f))
            activity.setContentView(body)
            body.post {
                fun bounds(view: View): JSONArray {
                    val location = IntArray(2)
                    view.getLocationOnScreen(location)
                    return JSONArray(listOf(location[0], location[1], location[0] + view.width, location[1] + view.height))
                }
                OracleState.update("page" to "visual_swipe_ready", "swipeCount" to 0,
                    "wrongGestures" to 0, "cancelledGestures" to 0,
                    "visualWindowBounds" to bounds(activity.window.decorView), "visualCanvasBounds" to bounds(canvas))
            }
            return
        }
        if (scene == "visual_action_sensitive") {
            // No description on this clickable owner. The non-clickable child carries
            // the sensitive purpose, including when touching empty space in the owner.
            val target = FrameLayout(activity).apply {
                id = R.id.visual_action_native_target
                setBackgroundColor(Color.rgb(18, 69, 120))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
                setOnClickListener { OracleState.click("visual_sensitive_target", false) }
            }
            val label = TextView(activity).apply {
                id = R.id.visual_action_native_result
                text = "付款"
                textSize = 28f
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
                setPadding(dp(8).toInt(), dp(8).toInt(), dp(8).toInt(), dp(8).toInt())
                isClickable = false
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
            }
            target.addView(label, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
            val body = FrameLayout(activity).apply {
                setBackgroundColor(Color.WHITE)
                addView(target, FrameLayout.LayoutParams((activity.resources.displayMetrics.widthPixels * .76f).toInt(), dp(260).toInt(), Gravity.CENTER))
            }
            activity.setContentView(body)
            body.post {
                // Known synthetic geometry only, used to prove which part of the composite
                // button each test addresses. It is never included in the host report.
                fun bounds(view: View): JSONArray {
                    val location = IntArray(2)
                    view.getLocationOnScreen(location)
                    return JSONArray(listOf(location[0], location[1], location[0] + view.width, location[1] + view.height))
                }
                OracleState.update("page" to "visual_sensitive_ready",
                    "visualWindowBounds" to bounds(activity.window.decorView),
                    "visualTargetBounds" to bounds(target), "visualLabelBounds" to bounds(label))
            }
            return
        }
        fun nativePage() {
            activity.setContentView(LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(24).toInt(), dp(40).toInt(), dp(24).toInt(), dp(24).toInt())
                setBackgroundColor(Color.WHITE)
                addView(TextView(activity).apply {
                    id = R.id.visual_action_native_result
                    text = "合成原生页面已打开"
                    textSize = 24f
                    setTextColor(Color.BLACK)
                })
                addView(Button(activity).apply {
                    id = R.id.visual_action_native_target
                    text = "合成原生入口"
                    isAllCaps = false
                    // This is not part of the two-touch scenario. Any extra tap is observable.
                    setOnClickListener { OracleState.click("visual_unexpected_native", false) }
                })
            })
            OracleState.update("page" to "visual_native_ready", "visualStage" to 3, "completed" to true)
        }
        fun canvasPage(stage: Int, next: () -> Unit) {
            activity.setContentView(object : View(activity) {
                private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
                private val target = RectF()
                private var downInside = false
                private var consumed = false

                init {
                    // No semantic text, click action or virtual descendants; the visible button
                    // is deliberately Canvas-only. A real app must locate it from image evidence.
                    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                    setBackgroundColor(if (stage == 1) Color.rgb(232, 244, 255) else Color.rgb(249, 235, 215))
                }

                override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
                    super.onSizeChanged(w, h, oldw, oldh)
                    // The fixed synthetic target covers the screenshot's centre even with system
                    // insets. Harness coordinates derive from the returned JPEG, never adb input.
                    target.set(w * .18f, h * .36f, w * .82f, h * .64f)
                }

                override fun onDraw(canvas: Canvas) {
                    super.onDraw(canvas)
                    paint.color = Color.BLACK
                    paint.textSize = dp(22)
                    paint.textAlign = Paint.Align.CENTER
                    canvas.drawText("合成视觉页面 $stage", width / 2f, height * .2f, paint)
                    paint.color = if (stage == 1) Color.rgb(18, 69, 120) else Color.rgb(108, 63, 10)
                    canvas.drawRoundRect(target, dp(18), dp(18), paint)
                    paint.color = Color.WHITE
                    canvas.drawText(if (stage == 1) "打开下一页" else "打开原生页面", target.centerX(), target.centerY() - (paint.ascent() + paint.descent()) / 2, paint)
                }

                override fun onTouchEvent(event: MotionEvent): Boolean {
                    when (event.actionMasked) {
                        MotionEvent.ACTION_DOWN -> { downInside = target.contains(event.x, event.y); return true }
                        MotionEvent.ACTION_UP -> {
                            val correct = !consumed && downInside && target.contains(event.x, event.y)
                            OracleState.click(if (correct) "visual_stage_$stage" else "visual_wrong_target", correct)
                            downInside = false
                            if (correct) { consumed = true; next() }
                            return true
                        }
                        MotionEvent.ACTION_CANCEL -> { downInside = false; return true }
                    }
                    return true
                }
            })
            OracleState.update("page" to "visual_canvas_$stage", "visualStage" to stage)
        }
        canvasPage(1) { canvasPage(2) { nativePage() } }
    }
}
