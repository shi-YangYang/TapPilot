package dev.tappilot.agent

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.MotionEvent
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** The transport cannot read or operate this screen, including the local resume control. */
class MainActivity : Activity() {
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 56, 32, 32)
        }
        fun text(value: String, size: Float = 16f): TextView = TextView(this).apply {
            text = value
            textSize = size
            setPadding(0, 16, 0, 16)
            content.addView(this)
        }
        text("TapPilot", 30f)
        text("此应用允许您授权的 Mac 通过 Android 无障碍服务读取当前页面、点击、输入和滚动。界面内容可能包含聊天或其他隐私。请只连接您信任的电脑。")
        text("仅通过 ADB 本地通道连接，不使用 Root，不请求网络权限。密码控件会被隐藏，聊天和输入内容不会持久化。发送、删除、付款等操作必须先在电脑终端确认。")
        text("先手动开启无障碍服务，再点击下方“允许自动化”。紧急停止会保持到您再次在本页手动恢复。")
        status = text("")
        fun button(label: String, action: () -> Unit) = Button(this).apply {
            text = label
            filterTouchesWhenObscured = true
            setOnClickListener { action(); updateStatus() }
            content.addView(this)
        }
        button("打开无障碍设置") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        button("允许自动化 / 恢复", ::resumeLocally)
        button("紧急停止") {
            getSharedPreferences("safety", MODE_PRIVATE).edit().putBoolean("stopped", true).commit()
            AgentAccessibilityService.instance?.stopAutomation()
        }
        text("即使紧急停止，已经交给系统执行的动作可能已发生；请检查当前手机界面。测试时建议从系统设置开始。")
        setContentView(ScrollView(this).apply { addView(content) })
    }

    private fun resumeLocally() {
        getSharedPreferences("safety", MODE_PRIVATE).edit().putBoolean("stopped", false).commit()
        AgentAccessibilityService.instance?.resumeLocally()
    }

    override fun onResume() { super.onResume(); updateStatus() }

    private fun updateStatus() {
        if (!::status.isInitialized) return
        val service = AgentAccessibilityService.instance
        val stopped = getSharedPreferences("safety", MODE_PRIVATE).getBoolean("stopped", true)
        status.text = "无障碍服务：${if (service != null) "已连接" else "未连接"}\n自动化：${if (stopped) "已停止" else "允许"}\n本地通道：${service?.transportStatus ?: "未启动"}"
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        // Reject taps obscured by other apps; remote TapPilot operations also reject this package.
        if (event.flags and (MotionEvent.FLAG_WINDOW_IS_OBSCURED or MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED) != 0) return false
        return super.dispatchTouchEvent(event)
    }
}
