package dev.tappilot.agent

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Executors

/** Protected local control surface: it cannot be read or operated through TapPilot tools. */
class MainActivity : Activity() {
    private val ink = Color.rgb(23, 43, 38)
    private val muted = Color.rgb(99, 117, 109)
    private val green = Color.rgb(20, 120, 93)
    private val surface = Color.rgb(244, 247, 243)
    private val worker = Executors.newSingleThreadExecutor()
    private val tabs = mutableListOf<Button>()
    private lateinit var body: LinearLayout
    private lateinit var taskPage: LinearLayout
    private lateinit var modelPage: LinearLayout
    private lateinit var devicePage: LinearLayout
    private lateinit var task: EditText
    private lateinit var url: EditText
    private lateinit var key: EditText
    private lateinit var model: EditText
    private lateinit var status: TextView
    private lateinit var result: TextView
    private lateinit var timings: TextView
    private lateinit var deviceStatus: TextView
    private lateinit var modelStatus: TextView
    private lateinit var start: Button
    private var testing: ModelClient? = null
    private var waitingToStart = false
    private val observer: (TaskViewState) -> Unit = { renderState(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        window.statusBarColor = surface
        window.navigationBarColor = surface
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        val root = column().apply { setBackgroundColor(surface); setPadding(dp(22), dp(22), dp(22), dp(16)) }
        root.setOnApplyWindowInsetsListener { view, insets ->
            view.setPadding(dp(22) + insets.systemWindowInsetLeft, dp(18) + insets.systemWindowInsetTop, dp(22) + insets.systemWindowInsetRight, dp(12) + insets.systemWindowInsetBottom)
            insets.consumeSystemWindowInsets()
        }
        val brand = row()
        brand.addView(label("T", 26f, Color.WHITE, true).apply { gravity = Gravity.CENTER; background = rounded(green, 15); setPadding(0, 0, 0, 0) }, LinearLayout.LayoutParams(dp(48), dp(48)))
        brand.addView(column().apply { setPadding(dp(12), 0, 0, 0); addView(label("TapPilot", 25f, ink, true)); addView(label("你的手机，由你指挥", 12f, muted)) })
        root.addView(brand)
        val navigation = row().apply { setPadding(0, dp(24), 0, dp(18)) }
        listOf("任务", "模型", "设备").forEachIndexed { index, name ->
            val button = button(name, false) { selectTab(index) }
            tabs.add(button)
            navigation.addView(button, LinearLayout.LayoutParams(0, dp(45), 1f).apply { if (index != 2) marginEnd = dp(8) })
        }
        root.addView(navigation)
        body = column()
        root.addView(ScrollView(this).apply { isFillViewport = true; addView(body) }, LinearLayout.LayoutParams(-1, 0, 1f))
        taskPage = buildTaskPage(); modelPage = buildModelPage(); devicePage = buildDevicePage()
        setContentView(root)
        selectTab(0)
        loadSettings()
    }
    private fun buildTaskPage() = column().apply {
        addView(label("今天，想让手机做什么？", 23f, ink, true))
        addView(label("配置你信任的模型，直接在手机运行。", 14f, muted).apply { setPadding(0, dp(8), 0, dp(20)) })
        addView(card().apply {
            task = input("例如：打开系统设置，找到电池页面，告诉我当前显示了什么。", multiline = true).apply { id = R.id.task_input; minLines = 4; maxLines = 7 }
            addView(task, LinearLayout.LayoutParams(-1, -2))
            addView(label("运行时会回到桌面，模型再根据界面逐步操作。", 12f, muted).apply { setPadding(0, dp(12), 0, dp(14)) })
            start = button("开始任务", true, ::startTask).apply { id = R.id.task_start }
            addView(start, LinearLayout.LayoutParams(-1, dp(50)))
        })
        addView(card().apply {
            addView(label("运行状态", 13f, muted, true))
            status = label("准备就绪", 18f, ink, true).apply { id = R.id.task_status; setPadding(0, dp(10), 0, dp(10)) }; addView(status)
            timings = label("模型与手机操作耗时会分别显示在这里。", 12f, muted); addView(timings)
            result = label("先在“模型”页保存配置，再在“设备”页开启无障碍与自动化权限。", 14f, ink).apply { setPadding(0, dp(16), 0, dp(8)); setTextIsSelectable(true) }; addView(result)
            addView(button("停止当前任务", false) { AgentTaskService.cancelActive() }, LinearLayout.LayoutParams(-1, dp(46)))
        })
        addView(label("任务与界面只保留在本次运行内存中。当前界面会发送给你配置的模型服务商；请先确认信任。付款、发送、删除等敏感提交请手动完成。", 12f, muted).apply { setPadding(dp(4), dp(6), dp(4), dp(22)) })
    }
    private fun buildModelPage() = column().apply {
        addView(label("连接你的模型", 23f, ink, true))
        addView(label("支持带工具调用能力的 OpenAI 兼容接口。", 14f, muted).apply { setPadding(0, dp(8), 0, dp(20)) })
        addView(card().apply {
            addView(label("API 地址", 13f, muted, true))
            url = input("https://你的服务地址/v1").apply { id = R.id.model_url; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI }; addView(url)
            addView(label("模型名称", 13f, muted, true).apply { setPadding(0, dp(18), 0, 0) })
            model = input("服务商提供的 model ID").apply { id = R.id.model_name }; addView(model)
            addView(label("API Key", 13f, muted, true).apply { setPadding(0, dp(18), 0, 0) })
            key = input("填写你的 API Key").apply { id = R.id.model_key; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }; addView(key)
            addView(label("配置经 Android Keystore 加密保存。不会写入日志或备份。无鉴权的自托管 HTTPS 接口可留空 Key。", 12f, muted).apply { setPadding(0, dp(12), 0, dp(16)) })
            addView(button("保存配置", true) { safe { SettingsStore(this@MainActivity).save(readSettings()); modelStatus.text = "配置已加密保存" } }.apply { id = R.id.model_save }, LinearLayout.LayoutParams(-1, dp(48)))
            addView(button("测试连接", false, ::testConnection).apply { id = R.id.model_test }, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(8) })
            modelStatus = label("尚未测试", 13f, muted).apply { setPadding(0, dp(14), 0, 0) }; addView(modelStatus)
        })
        addView(button("清除本机模型配置", false) {
            AlertDialog.Builder(this@MainActivity).setTitle("清除模型配置？").setMessage("会删除本机保存的 API 地址、模型名称与密钥。").setNegativeButton("取消", null)
                .setPositiveButton("清除") { _, _ -> SettingsStore(this@MainActivity).clear(); url.setText(""); key.setText(""); model.setText(""); modelStatus.text = "配置已清除" }.show()
        })
    }
    private fun buildDevicePage() = column().apply {
        addView(label("让手机准备好", 23f, ink, true))
        addView(label("日常使用无需电脑、数据线或开发者模式。", 14f, muted).apply { setPadding(0, dp(8), 0, dp(20)) })
        addView(card().apply {
            deviceStatus = label("", 15f, ink).apply { setPadding(0, 0, 0, dp(18)) }; addView(deviceStatus)
            addView(button("1  开启无障碍服务", true) { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }, LinearLayout.LayoutParams(-1, dp(49)))
            addView(label("在系统设置中找到“TapPilot 手机自动化”，阅读权限说明并手动开启。若系统提示受限设置，请按系统提供的流程处理。", 12f, muted).apply { setPadding(0, dp(10), 0, dp(16)) })
            addView(button("2  允许自动化 / 恢复", false) {
                getSharedPreferences("safety", MODE_PRIVATE).edit().putBoolean("stopped", false).commit()
                AgentAccessibilityService.instance?.resumeLocally(); updateDeviceStatus()
            }, LinearLayout.LayoutParams(-1, dp(49)))
            addView(button("3  允许任务通知", false) { requestNotifications() }, LinearLayout.LayoutParams(-1, dp(49)).apply { topMargin = dp(8) })
        })
        addView(card().apply {
            addView(label("随时掌握控制权", 18f, ink, true))
            addView(label("任务进行时可从通知栏停止。紧急停止会同时禁止手机端及电脑端继续操作，只能由你在这里恢复。", 13f, muted).apply { setPadding(0, dp(10), 0, dp(16)) })
            addView(button("紧急停止所有自动化", false) {
                getSharedPreferences("safety", MODE_PRIVATE).edit().putBoolean("stopped", true).commit()
                AgentTaskService.cancelActive("已紧急停止")
                AgentAccessibilityService.instance?.stopAutomation(); updateDeviceStatus()
            }.apply { setTextColor(Color.rgb(167, 56, 44)); background = rounded(Color.rgb(252, 235, 231), 12) }, LinearLayout.LayoutParams(-1, dp(49)))
        })
        addView(label("兼容电脑：原有 ADB / MCP 接口仍可使用。手机客户端直接调用原生控制服务，不依赖 Codex。", 12f, muted).apply { setPadding(dp(4), dp(4), dp(4), dp(20)) })
    }
    private fun startTask() = safe {
        if (TaskState.value.running) return@safe
        if (task.text.isBlank()) { toast("先写下你想完成的任务"); return@safe }
        if (SettingsStore(this).load() == null) { selectTab(1); toast("请先保存模型配置"); return@safe }
        if (AgentAccessibilityService.instance == null || getSharedPreferences("safety", MODE_PRIVATE).getBoolean("stopped", true)) {
            selectTab(2); toast("请先开启服务并允许自动化"); return@safe
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            waitingToStart = true; requestNotifications(); return@safe
        }
        startForegroundService(Intent(this, AgentTaskService::class.java).setAction(AgentTaskService.ACTION_START).putExtra("task", task.text.toString()))
        startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 10) else toast("此系统无需单独授予通知权限")
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 10 && waitingToStart) {
            waitingToStart = false
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startTask()
            else toast("为便于从通知栏停止任务，请允许通知后再开始")
        }
        updateDeviceStatus()
    }
    private fun readSettings() = ModelSettings(url.text.toString(), key.text.toString(), model.text.toString()).also { it.endpoint() }
    private fun loadSettings() = safe {
        SettingsStore(this).load()?.let { url.setText(it.baseUrl); key.setText(it.apiKey); model.setText(it.model); modelStatus.text = "已加载本机加密配置" }
    }
    private fun testConnection() = safe {
        if (testing != null) return@safe
        val client = ModelClient(readSettings()); testing = client
        modelStatus.text = "正在测试 HTTPS 连接…"
        worker.execute {
            val message = try { client.testConnection() } catch (error: Exception) { if (error is AgentError) "${error.code} · ${error.message}" else "连接测试失败" }
            runOnUiThread { testing = null; if (!isDestroyed) modelStatus.text = message }
        }
    }
    private fun renderState(state: TaskViewState) {
        if (!::status.isInitialized) return
        status.text = state.status; start.isEnabled = !state.running
        if (state.result.isNotBlank()) result.text = state.result
        else if (state.running) result.text = "任务正在目标应用中执行。可从通知停止；返回控制页可能使下一次读取暂停。"
        val modelMs = state.events.filter { it.phase == "model" }.sumOf { it.durationMs }
        val toolMs = state.events.filter { it.phase == "tool" }.sumOf { it.durationMs }
        val rounds = state.events.maxOfOrNull { it.round } ?: 0
        val modelRequests = state.events.count { it.phase == "model" }
        val toolCalls = state.events.count { it.phase == "tool" }
        val totalMs = state.events.maxOfOrNull { it.elapsedMs } ?: 0
        if (rounds > 0) timings.text = "模型 $modelRequests 次 · 工具 $toolCalls 次 · 总计 ${"%.1f".format(totalMs / 1000.0)} s\n模型 ${"%.1f".format(modelMs / 1000.0)} s · 手机 ${"%.1f".format(toolMs / 1000.0)} s"
    }
    private fun updateDeviceStatus() {
        if (!::deviceStatus.isInitialized) return
        val stopped = getSharedPreferences("safety", MODE_PRIVATE).getBoolean("stopped", true)
        val notifications = if (Build.VERSION.SDK_INT >= 33) checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED else true
        deviceStatus.text = "无障碍服务   ${if (AgentAccessibilityService.instance != null) "已连接 ✓" else "待开启"}\n自动化权限   ${if (stopped) "已停止" else "已允许 ✓"}\n任务通知      ${if (notifications) "已允许 ✓" else "待允许"}"
    }
    private fun selectTab(index: Int) {
        body.removeAllViews(); body.addView(listOf(taskPage, modelPage, devicePage)[index])
        tabs.forEachIndexed { i, b -> b.setTextColor(if (i == index) Color.WHITE else muted); b.background = rounded(if (i == index) green else Color.WHITE, 12) }
        updateDeviceStatus()
    }
    override fun onStart() { super.onStart(); TaskState.observe(observer) }
    override fun onStop() { TaskState.remove(observer); super.onStop() }
    override fun onResume() { super.onResume(); updateDeviceStatus() }
    override fun onDestroy() { testing?.cancel(); worker.shutdownNow(); super.onDestroy() }
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.flags and (MotionEvent.FLAG_WINDOW_IS_OBSCURED or MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED) != 0) return false
        return super.dispatchTouchEvent(event)
    }
    private fun safe(action: () -> Unit) { try { action() } catch (error: Exception) { toast(if (error is AgentError) error.message else "操作未完成，请检查配置后重试") } }
    private fun toast(value: String) { Toast.makeText(this, value, Toast.LENGTH_LONG).show() }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply { setColor(color); cornerRadius = dp(radius).toFloat() }
    private fun label(value: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value; textSize = size; setTextColor(color); includeFontPadding = false; setLineSpacing(dp(4).toFloat(), 1f)
        if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }
    private fun card() = column().apply { background = rounded(Color.WHITE, 20); setPadding(dp(20), dp(20), dp(20), dp(20)); layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(16) } }
    private fun button(value: String, primary: Boolean, action: () -> Unit) = Button(this).apply {
        text = value; textSize = 14f; isAllCaps = false; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setTextColor(if (primary) Color.WHITE else green); background = rounded(if (primary) green else Color.rgb(235, 245, 237), 12)
        filterTouchesWhenObscured = true; minHeight = 0; minWidth = 0; elevation = 0f; setPadding(dp(12), 0, dp(12), 0)
        setOnClickListener { action() }
    }
    private fun input(hintValue: String, multiline: Boolean = false) = EditText(this).apply {
        hint = hintValue; textSize = 15f; setTextColor(ink); setHintTextColor(Color.rgb(138, 153, 145)); isSaveEnabled = false
        inputType = InputType.TYPE_CLASS_TEXT or if (multiline) InputType.TYPE_TEXT_FLAG_MULTI_LINE else InputType.TYPE_TEXT_VARIATION_NORMAL
        setSingleLine(!multiline); gravity = Gravity.TOP or Gravity.START; setPadding(dp(10), dp(13), dp(10), dp(13)); background = rounded(surface, 10)
        if (Build.VERSION.SDK_INT >= 26) importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) }
    }
}
