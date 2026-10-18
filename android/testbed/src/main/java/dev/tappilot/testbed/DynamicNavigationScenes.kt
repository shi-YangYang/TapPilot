package dev.tappilot.testbed

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.Build
import android.os.Handler
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import kotlin.math.abs

/** Synthetic animation and pages. Only delivered touches update the independent business oracle. */
class DynamicNavigationScenes(private val activity: Activity, private val handler: Handler, private val scene: String) {
    companion object {
        val names = setOf("visual_dynamic_remote", "visual_dynamic_target", "visual_dynamic_swipe", "native_navigation_pages",
            "native_launcher_visible", "native_launcher_paged", "native_launcher_followup")
        const val ARM = "dev.tappilot.testbed.DYNAMIC_NAVIGATION_ARM"
    }
    private var receiver: BroadcastReceiver? = null
    private var closed = false
    private var armed = false
    private var frame = 0
    private fun dp(value: Int) = value * activity.resources.displayMetrics.density
    private fun bounds(view: View): JSONArray {
        val location = IntArray(2).also(view::getLocationOnScreen)
        return JSONArray(listOf(location[0], location[1], location[0] + view.width, location[1] + view.height))
    }

    fun show() {
        require(scene in names)
        OracleState.update("gestureCount" to 0, "wrongGestures" to 0, "cancelledGestures" to 0, "touchDownCount" to 0)
        if (scene == "native_navigation_pages") { nativePage(0); return }
        if (scene in setOf("native_launcher_visible", "native_launcher_paged", "native_launcher_followup")) {
            OracleState.update("swipeCount" to 0)
            launcherPage(0)
            return
        }
        val canvas = object : View(activity) {
            private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            private val target = RectF()
            private var down = false
            private var startX = 0f
            private var startY = 0f
            init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS }
            override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
                target.set(w * .18f, h * .72f, w * .82f, h * .90f)
            }
            override fun onDraw(canvas: Canvas) {
                canvas.drawColor(Color.WHITE)
                // Every armed frame is far from the baseline dark video. Thus a matching
                // phase cannot accidentally make the dynamic-content regression pass.
                paint.color = if (!armed) Color.rgb(15, 20, 25) else if (frame % 2 == 0) Color.rgb(230, 55, 70) else Color.rgb(50, 200, 100)
                val videoBottom = if (scene == "visual_dynamic_swipe") height.toFloat() else height * .58f
                canvas.drawRect(0f, 0f, width.toFloat(), videoBottom, paint)
                if (scene != "visual_dynamic_swipe") {
                    paint.color = if (scene == "visual_dynamic_target" && armed) Color.rgb(245, 220, 30) else Color.rgb(18, 69, 120)
                    canvas.drawRect(target, paint)
                    paint.color = Color.WHITE
                    paint.textSize = dp(22)
                    paint.textAlign = Paint.Align.CENTER
                    canvas.drawText(if (scene == "visual_dynamic_target" && armed) "已变为其他目标" else "打开合成详情", target.centerX(), target.centerY(), paint)
                }
            }
            override fun onTouchEvent(event: MotionEvent): Boolean {
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        down = true; startX = event.x; startY = event.y
                        val state = OracleState.snapshot(activity)
                        OracleState.update("touchDownCount" to state.optInt("touchDownCount") + 1)
                    }
                    MotionEvent.ACTION_UP -> {
                        if (scene == "visual_dynamic_swipe") {
                            val correct = down && startX > width * .6f && event.x < width * .4f && startX - event.x > width * .3f && abs(startY - event.y) < height * .12f
                            val state = OracleState.snapshot(activity)
                            OracleState.update("gestureCount" to state.optInt("gestureCount") + 1,
                                "wrongGestures" to state.optInt("wrongGestures") + if (correct) 0 else 1)
                            down = false
                            if (correct) finishNative()
                        } else {
                            val correct = down && target.contains(startX, startY) && target.contains(event.x, event.y) && scene != "visual_dynamic_target"
                            OracleState.click(if (correct) "dynamic_stable_target" else "dynamic_wrong_target", correct)
                            down = false
                            if (correct) finishNative()
                        }
                    }
                    MotionEvent.ACTION_CANCEL -> if (down) {
                        down = false
                        val state = OracleState.snapshot(activity)
                        OracleState.update("cancelledGestures" to state.optInt("cancelledGestures") + 1)
                    }
                }
                return true
            }
            fun targetBounds(): JSONArray {
                val location = IntArray(2).also(::getLocationOnScreen)
                return JSONArray(listOf(location[0] + target.left.toInt(), location[1] + target.top.toInt(), location[0] + target.right.toInt(), location[1] + target.bottom.toInt()))
            }
        }
        activity.setContentView(canvas)
        canvas.post {
            if (closed) return@post
            receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    if (closed || armed || intent?.action != ARM || intent.getStringExtra("runId") != OracleState.snapshot(activity).optString("runId")) return
                    armed = true
                    fun animate() {
                        if (closed) return
                        frame++
                        canvas.invalidate()
                        OracleState.update("armed" to true, "frame" to frame)
                        handler.postDelayed({ animate() }, 150)
                    }
                    animate()
                }
            }.also {
                if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(it, IntentFilter(ARM), Context.RECEIVER_EXPORTED)
                else activity.registerReceiver(it, IntentFilter(ARM))
            }
            OracleState.update("page" to "dynamic_ready", "frame" to 0,
                "visualWindowBounds" to bounds(activity.window.decorView), "visualCanvasBounds" to bounds(canvas), "visualTargetBounds" to canvas.targetBounds())
        }
    }

    private fun finishNative() {
        close()
        activity.setContentView(TextView(activity).apply {
            id = R.id.visual_action_native_result
            text = "合成操作完成"
            textSize = 26f
            setTextColor(Color.BLACK)
            setBackgroundColor(Color.WHITE)
            gravity = Gravity.CENTER
        })
        OracleState.update("page" to "dynamic_native_done", "completed" to true)
    }

    private fun nativePage(page: Int) {
        val body = object : LinearLayout(activity) {
            private var down = false
            private var startX = 0f
            private var startY = 0f
            init { orientation = VERTICAL; setBackgroundColor(Color.WHITE) }
            override fun onTouchEvent(event: MotionEvent): Boolean {
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> { down = true; startX = event.x; startY = event.y }
                    MotionEvent.ACTION_UP -> {
                        val correct = down && startX - event.x > width * .3f && abs(startY - event.y) < height * .12f && page < 2
                        val state = OracleState.snapshot(activity)
                        OracleState.update("gestureCount" to state.optInt("gestureCount") + 1,
                            "wrongGestures" to state.optInt("wrongGestures") + if (correct) 0 else 1)
                        down = false
                        if (correct) nativePage(page + 1)
                    }
                    MotionEvent.ACTION_CANCEL -> if (down) {
                        down = false
                        val state = OracleState.snapshot(activity)
                        OracleState.update("cancelledGestures" to state.optInt("cancelledGestures") + 1)
                    }
                }
                return true
            }
        }
        body.addView(TextView(activity).apply {
            id = R.id.visual_action_native_result
            text = "合成桌面第 ${page + 1} 页"
            textSize = 26f
            setTextColor(Color.BLACK)
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(-1, dp(100).toInt()))
        if (page == 2) body.addView(Button(activity).apply {
            id = R.id.visual_action_native_target
            text = "合成目标入口"
            setOnClickListener { OracleState.click("unexpected_navigation_tap", false) }
        }, LinearLayout.LayoutParams(-1, dp(72).toInt()))
        activity.setContentView(body)
        OracleState.update("page" to "native_navigation_$page", "completed" to (page == 2))
    }

    private fun launcherPage(page: Int) {
        val paged = scene == "native_launcher_paged"
        val body = object : LinearLayout(activity) {
            private var down = false
            private var startX = 0f
            private var startY = 0f
            private var interceptSwipe = false
            init { orientation = VERTICAL; setBackgroundColor(Color.WHITE) }
            override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
                if (event.actionMasked == MotionEvent.ACTION_MOVE && down &&
                    (abs(event.x - startX) > dp(16) || abs(event.y - startY) > dp(16))) interceptSwipe = true
                return interceptSwipe
            }
            override fun onTouchEvent(event: MotionEvent) = true
            override fun dispatchTouchEvent(event: MotionEvent): Boolean {
                if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                    down = true; interceptSwipe = false; startX = event.x; startY = event.y
                    val state = OracleState.snapshot(activity)
                    OracleState.update("touchDownCount" to state.optInt("touchDownCount") + 1)
                }
                val handled = super.dispatchTouchEvent(event)
                when (event.actionMasked) {
                    MotionEvent.ACTION_UP -> {
                        val dx = event.x - startX
                        val dy = event.y - startY
                        if (down && (abs(dx) > dp(16) || abs(dy) > dp(16))) {
                            val horizontal = abs(dx) > width * .3f && abs(dy) < height * .12f
                            val nextPage = if (dx < 0) page + 1 else page - 1
                            val correct = paged && horizontal && nextPage in 0..1
                            val state = OracleState.snapshot(activity)
                            OracleState.update("gestureCount" to state.optInt("gestureCount") + 1,
                                "swipeCount" to state.optInt("swipeCount") + if (correct) 1 else 0,
                                "wrongGestures" to state.optInt("wrongGestures") + if (correct) 0 else 1)
                            down = false
                            if (correct) launcherPage(nextPage)
                        } else down = false
                    }
                    MotionEvent.ACTION_CANCEL -> if (down) {
                        down = false
                        val state = OracleState.snapshot(activity)
                        OracleState.update("cancelledGestures" to state.optInt("cancelledGestures") + 1)
                    }
                }
                return handled
            }
        }
        body.addView(TextView(activity).apply {
            text = "桌面"
            textSize = 26f
            setTextColor(Color.BLACK)
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(-1, dp(96).toInt()))
        val icons = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        fun icon(label: String, description: String, second: Boolean? = null) = LinearLayout(activity).apply {
            id = R.id.launcher_icon_container
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
            addView(View(activity).apply {
                setBackgroundColor(if (second == null) Color.rgb(100, 115, 140) else Color.rgb(25, 180, 85))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(dp(64).toInt(), dp(64).toInt()))
            addView(TextView(activity).apply {
                id = R.id.launcher_icon_label
                text = label
                contentDescription = description
                textSize = 20f
                setTextColor(Color.BLACK)
                gravity = Gravity.CENTER
                isClickable = false
                isFocusable = false
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
            }, LinearLayout.LayoutParams(-1, dp(56).toInt()))
            setOnClickListener {
                val correct = second == true
                val destination = when (second) { true -> "second"; false -> "first"; null -> "other" }
                OracleState.click("launcher_$destination", correct)
                launcherDestination(destination)
            }
        }
        if (!paged || page == 1) {
            icons.addView(icon("微信", "微信", false), LinearLayout.LayoutParams(0, dp(176).toInt(), 1f))
            icons.addView(icon("微信", "微信分身，2条未读消息", true), LinearLayout.LayoutParams(0, dp(176).toInt(), 1f))
        } else {
            icons.addView(icon("天气", "天气"), LinearLayout.LayoutParams(0, dp(176).toInt(), 1f))
            icons.addView(icon("相机", "相机"), LinearLayout.LayoutParams(0, dp(176).toInt(), 1f))
        }
        body.addView(icons, LinearLayout.LayoutParams(-1, dp(176).toInt()))
        body.addView(View(activity).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO },
            LinearLayout.LayoutParams(-1, 0, 1f))
        body.addView(TextView(activity).apply {
            text = if (!paged) "1 / 1" else "${page + 1} / 2"
            contentDescription = "第 ${page + 1} 页，共 ${if (paged) 2 else 1} 页"
            textSize = 18f
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(-1, dp(64).toInt()))
        activity.setContentView(body)
        OracleState.update("page" to "launcher_$page", "completed" to false)
    }

    private fun launcherDestination(destination: String) {
        val needsFollowup = scene == "native_launcher_followup" && destination == "second"
        activity.setContentView(LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            gravity = Gravity.CENTER
            addView(TextView(activity).apply {
                id = R.id.launcher_destination
                text = when (destination) { "second" -> "微信 · 分身"; "first" -> "微信 · 主应用"; else -> "其他应用" }
                textSize = 28f
                setTextColor(Color.BLACK)
            })
            addView(TextView(activity).apply {
                text = if (destination == "other") "首页" else "消息列表"
                textSize = 20f
                setTextColor(Color.BLACK)
            })
            if (needsFollowup) addView(Button(activity).apply {
                id = R.id.launcher_notice
                text = "通知详情"
                setOnClickListener {
                    OracleState.click("launcher_notice")
                    launcherNotice()
                }
            })
        })
        OracleState.update("page" to "destination_$destination", "completed" to (destination == "second" && !needsFollowup))
    }

    private fun launcherNotice() {
        activity.setContentView(LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            gravity = Gravity.CENTER
            addView(TextView(activity).apply {
                text = "通知详情"
                textSize = 28f
                setTextColor(Color.BLACK)
            })
            addView(TextView(activity).apply {
                id = R.id.launcher_notice_time
                text = "活动时间：15:30"
                textSize = 22f
                setTextColor(Color.BLACK)
            })
        })
        OracleState.update("page" to "notice_detail", "completed" to true)
    }

    fun close() {
        closed = true
        receiver?.let { runCatching { activity.unregisterReceiver(it) } }; receiver = null
    }
}
