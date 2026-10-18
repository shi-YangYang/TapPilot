package dev.tappilot.testbed

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** Native tab roles come from Android accessibility semantics, never a fixture
 * exemption in the receiver. The negative recipient is an ordinary TextView.
 */
object NativeTabRefreshScenes {
    val names = setOf("native_tab_refresh", "native_button_refresh", "native_tab_recipient_refresh", "native_tab_initial_refresh")

    fun show(activity: Activity, scene: String, handler: Handler) {
        require(scene in names)
        val nativeTabs = scene != "native_button_refresh"
        val changesRecipient = scene == "native_tab_recipient_refresh"
        val initialRefresh = scene == "native_tab_initial_refresh"
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
        root.addView(label("合成导航刷新验证"), LinearLayout.LayoutParams(-1, dp(56)))
        val page = label("合成初始页面", R.id.semantic_result)
        val recipient = label(if (changesRecipient) "Recipient: Synthetic A" else "合成只读信息",
            if (changesRecipient) R.id.native_recipient else R.id.native_leaf)
        val status = label("合成状态 00000000", R.id.native_status).apply {
            contentDescription = "合成状态描述 00000000"
        }
        root.addView(page, LinearLayout.LayoutParams(-1, dp(56)))
        root.addView(recipient, LinearLayout.LayoutParams(-1, dp(56)))
        root.addView(status, LinearLayout.LayoutParams(-1, dp(56)))

        var scheduled = false
        var started = false
        var refreshCount = 0
        var armClicks = 0
        var targetClicks = 0
        var actionAt = 0L
        OracleState.update("page" to "native_tab_initial", "refreshScheduled" to false,
            "refreshStarted" to false, "recipientChanged" to false, "armClicks" to 0,
            "targetClicks" to 0, "refreshCount" to 0, "refreshDelayMs" to 0,
            "targetSelected" to false, "nativeTabs" to nativeTabs)

        val bar = LinearLayout(activity).apply {
            id = R.id.native_list
            orientation = LinearLayout.HORIZONTAL
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
            if (nativeTabs) accessibilityDelegate = object : View.AccessibilityDelegate() {
                override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                    super.onInitializeAccessibilityNodeInfo(host, info)
                    info.collectionInfo = AccessibilityNodeInfo.CollectionInfo.obtain(
                        1, 2, false, AccessibilityNodeInfo.CollectionInfo.SELECTION_MODE_SINGLE)
                }
            }
        }
        fun tab(value: String, resource: Int, column: Int, selected: Boolean): TextView {
            val control = if (nativeTabs) label(value, resource) else Button(activity).apply {
                id = resource; text = value; isAllCaps = false; setTextColor(Color.BLACK)
            }
            control.apply {
                gravity = Gravity.CENTER
                isClickable = true
                isSelected = selected
                setBackgroundColor(Color.LTGRAY)
                if (nativeTabs) accessibilityDelegate = object : View.AccessibilityDelegate() {
                    override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                        super.onInitializeAccessibilityNodeInfo(host, info)
                        info.extras.putCharSequence("AccessibilityNodeInfo.roleDescription", "Tab")
                        info.collectionItemInfo = AccessibilityNodeInfo.CollectionItemInfo.obtain(
                            0, 1, column, 1, false, host.isSelected)
                    }
                }
            }
            return control
        }
        val initialTab = tab("概览", R.id.native_peer_a, 0, true)
        val destinationTab = tab("详情", R.id.native_target, 1, false)
        initialTab.setOnClickListener { OracleState.click("native_tab_initial", false) }
        destinationTab.setOnClickListener {
            targetClicks++
            val correct = (scene == "native_tab_refresh" || initialRefresh) && started && targetClicks == 1
            OracleState.click("native_tab_destination", correct)
            destinationTab.isSelected = true
            initialTab.isSelected = false
            page.text = "合成目标页面"
            OracleState.update("targetClicks" to targetClicks, "targetSelected" to true,
                "page" to "native_tab_destination", "completed" to correct)
        }
        bar.addView(initialTab, LinearLayout.LayoutParams(0, dp(64), 1f))
        bar.addView(destinationTab, LinearLayout.LayoutParams(0, dp(64), 1f))
        root.addView(bar, LinearLayout.LayoutParams(-1, dp(64)))
        fun startRefresh(delayMs: Long) {
            scheduled = true
            actionAt = SystemClock.uptimeMillis()
            OracleState.update("refreshScheduled" to true)
            handler.postDelayed({
                started = true
                OracleState.update("refreshStarted" to true, "refreshDelayMs" to SystemClock.uptimeMillis() - actionAt)
                handler.post(object : Runnable {
                    override fun run() {
                        refreshCount++
                        val tick = refreshCount.toString().padStart(8, '0')
                        status.text = "合成状态 $tick"
                        status.contentDescription = "合成状态描述 $tick"
                        if (changesRecipient) recipient.text = "Recipient: Synthetic B $tick"
                        OracleState.update("refreshCount" to refreshCount, "recipientChanged" to changesRecipient)
                        handler.postDelayed(this, 80)
                    }
                })
            }, delayMs)
        }
        if (!initialRefresh) root.addView(Button(activity).apply {
            id = R.id.native_arm; text = "准备刷新"; isAllCaps = false
            setOnClickListener {
                armClicks++
                OracleState.click("native_tab_arm", !scheduled)
                OracleState.update("armClicks" to armClicks)
                if (scheduled) return@setOnClickListener
                startRefresh(1_400)
            }
        }, LinearLayout.LayoutParams(-1, dp(64)))
        activity.setContentView(root)
        root.requestFocus()
        if (initialRefresh) startRefresh(0)
    }
}
