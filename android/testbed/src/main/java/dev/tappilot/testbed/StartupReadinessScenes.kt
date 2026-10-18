package dev.tappilot.testbed

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView

/** Deterministic cold-observation transitions; never shipped with the receiver. */
object StartupReadinessScenes {
    val names = setOf("startup_blank", "startup_entering", "startup_delayed_controls",
        "startup_refreshing_collection", "startup_never_ready")

    fun show(activity: Activity, scene: String, handler: Handler) {
        require(scene in names)
        fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
        val delayMs = 1_200L
        val root = FrameLayout(activity).apply { setBackgroundColor(Color.WHITE) }
        val body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(20))
        }
        var ready = false
        var gateStarted = false
        var probeReads = 0
        var refreshCount = 0
        var earlyClicks = 0
        var gateAt = 0L
        val peerLabels = mutableListOf<TextView>()
        val title = when (scene) {
            "startup_blank" -> "文档工作台"
            "startup_entering" -> "媒体目录"
            "startup_delayed_controls" -> "Notes workspace"
            "startup_refreshing_collection" -> "旅行发现"
            else -> "空白启动场景"
        }
        val actionName = when (scene) {
            "startup_blank" -> "新建文档"
            "startup_entering" -> "选择媒体"
            "startup_delayed_controls" -> "Create note"
            else -> "筛选行程"
        }
        OracleState.update("page" to "startup_starting", "startupReady" to false,
            "targetMounted" to false, "animationDone" to false, "earlyClicks" to 0,
            "gateStarted" to false, "probeReads" to 0, "startupDelayMs" to delayMs,
            "refreshCount" to 0, "eventCount" to 0)
        fun label(value: String) = object : TextView(activity) {
            override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(info)
                // Deliberately model a native-visible view outside the display.
                if (scene == "startup_entering") info.isVisibleToUser = true
            }
        }.apply { text = value; textSize = 20f; setTextColor(Color.BLACK) }
        fun target() = object : Button(activity) {
            override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(info)
                if (scene == "startup_entering") info.isVisibleToUser = true
            }
        }.apply {
            id = R.id.startup_target; text = actionName; isAllCaps = false
            setOnClickListener {
                if (!ready) {
                    earlyClicks++
                    OracleState.click("startup_early", false)
                    OracleState.update("earlyClicks" to earlyClicks)
                } else {
                    OracleState.click("startup_target")
                    OracleState.update("completed" to true, "page" to "startup_selected")
                }
            }
        }
        fun appendTarget() {
            body.addView(target(), LinearLayout.LayoutParams(-1, dp(64)))
            OracleState.update("targetMounted" to true)
        }
        fun completeStartup() {
            ready = true
            OracleState.update("startupReady" to true, "animationDone" to true,
                "readyAfterGateMs" to SystemClock.uptimeMillis() - gateAt, "page" to "startup_ready")
        }
        val loading = ProgressBar(activity).apply {
            id = R.id.startup_loading; isIndeterminate = true
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        if (scene == "startup_entering") {
            body.addView(label(title), LinearLayout.LayoutParams(-1, dp(64)))
            appendTarget()
            body.translationX = activity.resources.displayMetrics.widthPixels.toFloat() + dp(40)
        } else if (scene in setOf("startup_delayed_controls", "startup_refreshing_collection")) {
            body.addView(label(title), LinearLayout.LayoutParams(-1, dp(64)))
            body.addView(loading, LinearLayout.LayoutParams(dp(48), dp(48)))
        }
        if (scene == "startup_refreshing_collection") {
            val adapter = object : BaseAdapter() {
                override fun getCount() = 4
                override fun getItem(position: Int) = position
                override fun getItemId(position: Int) = position.toLong()
                override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                    LinearLayout(activity).apply {
                        orientation = LinearLayout.VERTICAL
                        layoutParams = AbsListView.LayoutParams(-1, dp(82))
                        addView(label("推荐路线 ${position + 1}"))
                        addView(label("动态推荐 $refreshCount").also { peerLabels.add(it) })
                    }
            }
            body.addView(ListView(activity).apply {
                id = R.id.startup_collection; this.adapter = adapter; dividerHeight = 0
            }, LinearLayout.LayoutParams(-1, dp(260)))
        }
        fun beginTransition() {
            if (gateStarted) return
            gateStarted = true
            gateAt = SystemClock.uptimeMillis()
            OracleState.update("gateStarted" to true, "gateAtUptimeMs" to gateAt)
            if (scene == "startup_refreshing_collection") {
                handler.post(object : Runnable {
                    override fun run() {
                        refreshCount++
                        peerLabels.forEach { it.text = "动态推荐 $refreshCount" }
                        OracleState.update("refreshCount" to refreshCount)
                        handler.postDelayed(this, 70)
                    }
                })
            }
            if (scene == "startup_never_ready") {
                handler.post(object : Runnable {
                    var events = 0
                    override fun run() {
                        root.sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
                        OracleState.update("eventCount" to ++events)
                        handler.postDelayed(this, 75)
                    }
                })
            } else if (scene == "startup_entering") {
                val outside = body.translationX
                handler.post(object : Runnable {
                    override fun run() {
                        val elapsed = SystemClock.uptimeMillis() - gateAt
                        body.translationX = outside * (1f - (elapsed.toFloat() / delayMs).coerceAtMost(1f))
                        if (elapsed < delayMs) handler.postDelayed(this, 40)
                        else { body.translationX = 0f; completeStartup() }
                    }
                })
            } else handler.postDelayed({
                if (scene == "startup_blank") body.addView(label(title), LinearLayout.LayoutParams(-1, dp(64)))
                else body.removeView(loading)
                appendTarget()
                completeStartup()
            }, delayMs)
        }
        // The neutral native probe anchors timing to the first accessibility
        // sample, so ADB/process startup cannot silently consume the transition.
        // It exposes no label, selector instruction or action to the receiver.
        root.addView(object : View(activity) {
            init { id = R.id.startup_probe; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES }
            override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(info)
                probeReads++
                OracleState.update("probeReads" to probeReads)
                beginTransition()
            }
        }, FrameLayout.LayoutParams(dp(1), dp(1)))
        root.addView(body, FrameLayout.LayoutParams(-1, -1))
        activity.setContentView(root)
    }
}
