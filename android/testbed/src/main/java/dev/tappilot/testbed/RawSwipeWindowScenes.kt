package dev.tappilot.testbed

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray

/** Same foreground/native tree; only a separate non-focusable application panel changes. */
class RawSwipeWindowScenes(private val activity: Activity, private val handler: Handler, private val scene: String) {
    companion object {
        val names = setOf("raw_swipe_window_noise", "raw_swipe_window_obscured")
        const val ARM = "dev.tappilot.testbed.RAW_SWIPE_WINDOW_ARM"
    }
    private val manager = activity.getSystemService(WindowManager::class.java)
    private var panel: View? = null
    private var receiver: BroadcastReceiver? = null
    private var closed = false
    private var armed = false
    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()

    fun show() {
        require(scene in names)
        val body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
        }
        body.addView(TextView(activity).apply {
            id = R.id.raw_swipe_window_title
            text = "合成窗口噪声"
            textSize = 22f
            setTextColor(Color.BLACK)
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(-1, dp(96)))
        val surface = object : View(activity) {
            var down = false
            var startX = 0f
            var startY = 0f
            init {
                id = R.id.raw_swipe_window_surface
                contentDescription = "合成滑动区域"
                importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
                setBackgroundColor(Color.rgb(225, 238, 250))
            }
            override fun onTouchEvent(event: MotionEvent): Boolean {
                val prior = OracleState.snapshot(activity)
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        down = true; startX = event.x; startY = event.y
                        OracleState.update("touchDownCount" to prior.optInt("touchDownCount") + 1)
                    }
                    MotionEvent.ACTION_UP -> {
                        val correct = down && startX in width * .6f..width * .9f && event.x in width * .1f..width * .4f &&
                            startX - event.x >= width * .35f && kotlin.math.abs(startY - event.y) < height * .1f
                        down = false
                        OracleState.update("gestureCount" to prior.optInt("gestureCount") + 1,
                            "wrongGestures" to prior.optInt("wrongGestures") + if (correct) 0 else 1,
                            "completed" to correct)
                    }
                    MotionEvent.ACTION_CANCEL -> if (down) {
                        down = false
                        OracleState.update("cancelledGestures" to prior.optInt("cancelledGestures") + 1)
                    }
                }
                return true
            }
        }
        body.addView(surface, LinearLayout.LayoutParams(-1, 0, 1f))
        activity.setContentView(body)
        body.post {
            if (closed) return@post
            val surfaceLocation = IntArray(2).also(surface::getLocationOnScreen)
            val decorLocation = IntArray(2).also(activity.window.decorView::getLocationOnScreen)
            val panelView = object : TextView(activity) {
                override fun onTouchEvent(event: MotionEvent): Boolean {
                    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                        val prior = OracleState.snapshot(activity)
                        OracleState.update("overlayTouches" to prior.optInt("overlayTouches") + 1)
                    }
                    return true
                }
            }.apply {
                text = "合成块"
                textSize = 12f
                gravity = Gravity.CENTER
                setTextColor(Color.WHITE)
                setBackgroundColor(Color.rgb(90, 45, 130))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
            }
            val params = WindowManager.LayoutParams(dp(76), dp(30), WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.OPAQUE).apply {
                token = activity.window.decorView.windowToken
                gravity = Gravity.TOP or Gravity.LEFT
                x = decorLocation[0] + dp(8)
                y = decorLocation[1] + dp(8)
                setTitle("TapPilot synthetic window noise")
            }
            manager.addView(panelView, params)
            panel = panelView
            OracleState.update("page" to "raw_swipe_window_ready", "panelUpdates" to 0,
                "touchDownCount" to 0, "gestureCount" to 0, "wrongGestures" to 0,
                "cancelledGestures" to 0, "overlayTouches" to 0,
                "surfaceBounds" to JSONArray(listOf(surfaceLocation[0], surfaceLocation[1], surfaceLocation[0] + surface.width, surfaceLocation[1] + surface.height)))
            var updates = 0
            fun updatePanel() {
                if (closed) return
                updates++
                if (scene == "raw_swipe_window_obscured") {
                    params.x = surfaceLocation[0] + surface.width / 2 - params.width / 2
                    params.y = surfaceLocation[1] + surface.height / 2 - params.height / 2
                } else params.x = decorLocation[0] + dp(if (updates % 2 == 0) 8 else 96)
                manager.updateViewLayout(panelView, params)
                OracleState.update("panelUpdates" to updates, "panelInPath" to (scene == "raw_swipe_window_obscured"),
                    "mainHasFocus" to activity.hasWindowFocus())
                if (scene == "raw_swipe_window_noise" && updates < 40) handler.postDelayed({ updatePanel() }, 700)
            }
            receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    if (closed || armed || intent?.action != ARM || intent.getStringExtra("runId") != OracleState.snapshot(activity).optString("runId")) return
                    armed = true
                    OracleState.update("armed" to true)
                    updatePanel()
                }
            }.also {
                if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(it, IntentFilter(ARM), Context.RECEIVER_EXPORTED)
                else activity.registerReceiver(it, IntentFilter(ARM))
            }
        }
    }

    fun close() {
        closed = true
        receiver?.let { runCatching { activity.unregisterReceiver(it) } }; receiver = null
        panel?.let { runCatching { manager.removeViewImmediate(it) } }; panel = null
    }
}
