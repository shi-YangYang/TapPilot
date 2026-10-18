package dev.tappilot.testbed

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView

/** Same Activity/window throughout. Only a real button callback starts the transition. */
object ActionReadinessScenes {
    val names = setOf("action_multistage_editor", "action_delayed_scroll", "action_refreshing_collection",
        "action_never_ready", "action_noop")

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
        var transitioning = false
        var ready = false
        var actionAt = 0L
        var intermediateSamples = 0
        var phaseCount = 0
        var refreshCount = 0
        var preLoadScrollSamples = 0
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
            text = "打开合成工作页"
            textSize = 22f
            setTextColor(Color.BLACK)
        }
        fun label(value: String) = TextView(activity).apply {
            text = value; textSize = 18f; setTextColor(Color.BLACK)
        }
        fun status(value: String) {
            phase.text = value
            phaseCount++
            OracleState.update("phaseCount" to phaseCount)
        }
        fun complete() {
            ready = true
            OracleState.update("transitionReady" to true, "completed" to true,
                "readyAfterActionMs" to SystemClock.uptimeMillis() - actionAt,
                "page" to "action_readiness_final")
        }
        fun intermediateButton() = Button(activity).apply {
            id = R.id.action_readiness_intermediate
            text = "临时入口"; isAllCaps = false
            setOnClickListener { OracleState.click("intermediate_target", false) }
        }
        fun showIntermediate(number: Int) {
            body.removeAllViews()
            body.addView(label("过渡内容 $number"), LinearLayout.LayoutParams(-1, dp(48)))
            body.addView(intermediateButton(), LinearLayout.LayoutParams(-1, dp(64)))
            status("工作页阶段 $number")
        }
        fun showEditor() {
            body.removeAllViews()
            body.addView(label("合成便签编辑器"), LinearLayout.LayoutParams(-1, dp(48)))
            body.addView(EditText(activity).apply {
                id = R.id.action_readiness_editor
                hint = "合成文字"; isSingleLine = true; isSaveEnabled = false
                showSoftInputOnFocus = false
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            }, LinearLayout.LayoutParams(-1, dp(64)))
            root.requestFocus()
            status("工作页已就绪")
            OracleState.update("editorMounted" to true, "finalControlMounted" to true)
            complete()
        }
        fun showList() {
            body.removeAllViews()
            var rowCount = 2
            val adapter = object : BaseAdapter() {
                override fun getCount() = rowCount
                override fun getItem(position: Int) = position
                override fun getItemId(position: Int) = position.toLong()
                override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                    (convertView as? LinearLayout ?: LinearLayout(activity).apply {
                        orientation = LinearLayout.VERTICAL
                        layoutParams = AbsListView.LayoutParams(-1, dp(72))
                        addView(label(""))
                        addView(label(""))
                    }).apply {
                        (getChildAt(0) as TextView).text = "合成条目 ${position + 1}"
                        (getChildAt(1) as TextView).text = "动态内容 $refreshCount"
                    }
            }
            val list = object : ListView(activity) {
                override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
                    super.onInitializeAccessibilityNodeInfo(info)
                    if (transitioning && !ready && !info.isScrollable) {
                        preLoadScrollSamples++
                        OracleState.update("preLoadScrollSamples" to preLoadScrollSamples)
                    }
                }
            }.apply {
                id = R.id.action_readiness_list
                this.adapter = adapter
                dividerHeight = 0
            }
            body.addView(list, LinearLayout.LayoutParams(-1, dp(260)))
            status("目录阶段 0")
            for (number in 1..3) handler.postDelayed({ status("目录阶段 $number") }, number * 160L)
            handler.postDelayed({
                list.viewTreeObserver.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
                    override fun onGlobalLayout() {
                        if (!list.canScrollVertically(1)) return
                        list.viewTreeObserver.removeOnGlobalLayoutListener(this)
                        OracleState.update("finalControlMounted" to true, "listScrollable" to true)
                        complete()
                    }
                })
                rowCount = 24
                adapter.notifyDataSetChanged()
                status("目录已就绪")
                if (scene == "action_refreshing_collection") handler.post(object : Runnable {
                    override fun run() {
                        refreshCount++
                        adapter.notifyDataSetChanged()
                        OracleState.update("refreshCount" to refreshCount)
                        handler.postDelayed(this, 70)
                    }
                })
            }, 600)
        }
        OracleState.update("page" to "action_readiness_initial", "transitionStarted" to false,
            "transitionReady" to false, "finalControlMounted" to false, "editorMounted" to false,
            "listScrollable" to false, "phaseCount" to 0, "intermediateSamples" to 0,
            "preLoadScrollSamples" to 0, "readyAfterActionMs" to 0, "refreshCount" to 0)
        root.addView(phase, LinearLayout.LayoutParams(-1, dp(64)))
        root.addView(body, LinearLayout.LayoutParams(-1, -2))
        body.addView(Button(activity).apply {
            id = R.id.action_readiness_start
            text = "打开工作页"; isAllCaps = false
            setOnClickListener {
                OracleState.click("action_readiness_start", !transitioning)
                if (transitioning) return@setOnClickListener
                transitioning = true
                actionAt = SystemClock.uptimeMillis()
                OracleState.update("transitionStarted" to true, "actionAtUptimeMs" to actionAt)
                when (scene) {
                    "action_noop" -> complete() // Business callback changes oracle only; UI stays identical.
                    "action_multistage_editor" -> {
                        showIntermediate(0)
                        for (number in 1..3) handler.postDelayed({ showIntermediate(number) }, number * 160L)
                        handler.postDelayed({ showEditor() }, 600)
                    }
                    "action_delayed_scroll", "action_refreshing_collection" -> showList()
                    "action_never_ready" -> {
                        showIntermediate(0)
                        handler.post(object : Runnable {
                            override fun run() {
                                status("变化中的工作页 ${++refreshCount}")
                                OracleState.update("refreshCount" to refreshCount)
                                handler.postDelayed(this, 70)
                            }
                        })
                    }
                }
            }
        }, LinearLayout.LayoutParams(-1, dp(64)))
        activity.setContentView(root)
        root.requestFocus()
    }
}
