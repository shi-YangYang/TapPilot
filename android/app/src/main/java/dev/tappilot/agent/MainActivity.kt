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
import com.google.zxing.integration.android.IntentIntegrator

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
    private lateinit var pairingInput: EditText
    private lateinit var wirelessStatus: TextView
    private lateinit var wirelessConnect: Button
    private var waitingToConnect = false
    private var testing: ModelClient? = null
    private var waitingToStart = false
    private val observer: (TaskViewState) -> Unit = { renderState(it) }
    private val wirelessObserver: (WirelessViewState) -> Unit = { renderWireless(it) }

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
        brand.addView(column().apply { setPadding(dp(12), 0, 0, 0); addView(label("TapPilot", 25f, ink, true)) })
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
        addView(label("想让手机做什么？", 23f, ink, true).apply { setPadding(0, 0, 0, dp(20)) })
        addView(card().apply {
            task = input("例如：打开设置，查看电池信息", multiline = true).apply { id = R.id.task_input; minLines = 4; maxLines = 7 }
            addView(task, LinearLayout.LayoutParams(-1, -2))
            addView(label("开始后将返回桌面自动操作。", 12f, muted).apply { setPadding(0, dp(12), 0, dp(14)) })
            start = button("开始任务", true, ::startTask).apply { id = R.id.task_start }
            addView(start, LinearLayout.LayoutParams(-1, dp(50)))
        })
        addView(card().apply {
            status = label("准备就绪", 18f, ink, true).apply { id = R.id.task_status; setPadding(0, dp(10), 0, dp(10)) }; addView(status)
            timings = label("", 12f, muted); addView(timings)
            result = label("首次使用：先配置模型，再开启设备权限。", 14f, ink).apply { setPadding(0, dp(16), 0, dp(8)); setTextIsSelectable(true) }; addView(result)
            addView(button("停止当前任务", false) { AgentTaskService.cancelActive() }, LinearLayout.LayoutParams(-1, dp(46)))
        })
        addView(label("界面会发送给所选模型，请确认信任。本机不保存任务记录。付款、发送、删除等操作需手动完成。", 12f, muted).apply { setPadding(dp(4), dp(6), dp(4), dp(22)) })
    }
    private fun buildModelPage() = column().apply {
        addView(label("模型设置", 23f, ink, true))
        addView(label("需支持工具调用的 OpenAI 兼容 HTTPS 接口。", 14f, muted).apply { setPadding(0, dp(8), 0, dp(20)) })
        addView(card().apply {
            addView(label("API 地址", 13f, muted, true))
            url = input("https://你的服务地址/v1").apply { id = R.id.model_url; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI }; addView(url)
            addView(label("模型名称", 13f, muted, true).apply { setPadding(0, dp(18), 0, 0) })
            model = input("填写服务商提供的模型名称").apply { id = R.id.model_name }; addView(model)
            addView(label("密钥（API Key）", 13f, muted, true).apply { setPadding(0, dp(18), 0, 0) })
            key = input("粘贴 API Key").apply { id = R.id.model_key; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }; addView(key)
            addView(label("配置仅加密保存在本机。无需密钥的服务可留空。", 12f, muted).apply { setPadding(0, dp(12), 0, dp(16)) })
            addView(button("保存配置", true) { safe { SettingsStore(this@MainActivity).save(readSettings()); modelStatus.text = "已保存" } }.apply { id = R.id.model_save }, LinearLayout.LayoutParams(-1, dp(48)))
            addView(button("测试连接", false, ::testConnection).apply { id = R.id.model_test }, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(8) })
            modelStatus = label("尚未测试", 13f, muted).apply { setPadding(0, dp(14), 0, 0) }; addView(modelStatus)
        })
        addView(button("清除本机模型配置", false) {
            AlertDialog.Builder(this@MainActivity).setTitle("清除模型配置？").setMessage("会删除本机保存的 API 地址、模型名称与密钥。").setNegativeButton("取消", null)
                .setPositiveButton("清除") { _, _ -> SettingsStore(this@MainActivity).clear(); url.setText(""); key.setText(""); model.setText(""); modelStatus.text = "配置已清除" }.show()
        })
    }
    private fun buildDevicePage() = column().apply {
        addView(label("连接与权限", 23f, ink, true).apply { setPadding(0, 0, 0, dp(20)) })
        addView(card().apply {
            addView(label("无线连接电脑", 18f, ink, true))
            addView(label("连接同一 Wi-Fi，在电脑设备页点击“显示二维码”，再扫码。", 12f, muted).apply { setPadding(0, dp(10), 0, dp(12)) })
            wirelessStatus = label("尚未连接电脑", 13f, muted).apply { id = R.id.wireless_status }; addView(wirelessStatus)
            addView(button("扫描电脑二维码", true, ::scanPairing).apply { id = R.id.wireless_scan }, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(14) })
            pairingInput = input("或粘贴电脑端配对地址").apply { id = R.id.wireless_pairing; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }; addView(pairingInput)
            wirelessConnect = button("连接电脑", false, ::connectWireless).apply { id = R.id.wireless_connect }
            addView(wirelessConnect, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(10) })
            addView(button("断开电脑", false) { WirelessService.disconnectActive() }, LinearLayout.LayoutParams(-1, dp(45)).apply { topMargin = dp(6) })
            addView(label("应用重启后需重新配对。连接电脑时，不能启动手机端任务。", 12f, muted).apply { setPadding(0, dp(12), 0, 0) })
        })
        addView(card().apply {
            deviceStatus = label("", 15f, ink).apply { setPadding(0, 0, 0, dp(18)) }; addView(deviceStatus)
            addView(button("1  开启无障碍服务", true) { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }, LinearLayout.LayoutParams(-1, dp(49)))
            addView(label("在系统设置中开启“TapPilot 手机自动化”；若提示“受限设置”，按系统指引处理。", 12f, muted).apply { setPadding(0, dp(10), 0, dp(16)) })
            addView(button("2  允许自动化 / 恢复", false) {
                safe {
                    val service = AgentAccessibilityService.instance ?: throw AgentError("SERVICE_UNAVAILABLE", "请先开启无障碍服务，再允许自动化")
                    service.resumeLocally(); updateDeviceStatus()
                }
            }, LinearLayout.LayoutParams(-1, dp(49)))
            addView(button("3  允许任务通知", false) { requestNotifications() }, LinearLayout.LayoutParams(-1, dp(49)).apply { topMargin = dp(8) })
        })
        addView(card().apply {
            addView(label("停止与恢复", 18f, ink, true))
            addView(label("通知栏可停止任务。急停后所有自动化都将停止，需在本页点击“允许自动化 / 恢复”。", 13f, muted).apply { setPadding(0, dp(10), 0, dp(16)) })
            addView(button("紧急停止所有自动化", false) {
                safe { AgentAccessibilityService.latchEmergencyStop(this@MainActivity); updateDeviceStatus() }
            }.apply { setTextColor(Color.rgb(167, 56, 44)); background = rounded(Color.rgb(252, 235, 231), 12) }, LinearLayout.LayoutParams(-1, dp(49)))
        })
    }
    private fun startTask() = safe {
        if (TaskState.value.running) return@safe
        if (WirelessState.value.connecting || WirelessState.value.connected) { selectTab(2); toast("请先断开电脑，再开始手机端任务"); return@safe }
        if (task.text.isBlank()) { toast("先写下你想完成的任务"); return@safe }
        if (SettingsStore(this).load() == null) { selectTab(1); toast("请先保存模型配置"); return@safe }
        if (AgentAccessibilityService.instance == null || getSharedPreferences("safety", MODE_PRIVATE).getBoolean("stopped", true)) {
            selectTab(2); toast("请先开启服务并允许自动化"); return@safe
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            waitingToStart = true; waitingToConnect = false; requestNotifications(); return@safe
        }
        startForegroundService(Intent(this, AgentTaskService::class.java).setAction(AgentTaskService.ACTION_START).putExtra("task", task.text.toString()))
        startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    private fun scanPairing() = safe {
        if (WirelessState.value.connecting || WirelessState.value.connected || TaskState.value.running) { toast("请先停止任务或断开连接，再扫描新的配对码"); return@safe }
        IntentIntegrator(this).setCaptureActivity(SecureScanActivity::class.java).setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
            .setPrompt("扫描 TapPilot 电脑端的无线配对二维码").setBeepEnabled(false).setBarcodeImageEnabled(false).setOrientationLocked(false).initiateScan()
    }
    private fun connectWireless() = safe {
        if (WirelessState.value.connecting || WirelessState.value.connected) return@safe
        if (TaskState.value.running || AutomationOwner.busy()) { toast("请先停止手机端任务"); return@safe }
        val entered = pairingInput.text.toString()
        if (entered.isNotBlank()) WirelessState.pairing = PairingInfo.parse(entered)
        if (WirelessState.pairing == null) { toast("先扫描或粘贴电脑端配对地址"); return@safe }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            waitingToConnect = true; waitingToStart = false; requestNotifications(); return@safe
        }
        startForegroundService(Intent(this, WirelessService::class.java).setAction(WirelessService.CONNECT))
        pairingInput.setText("")
    }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (result != null) {
            result.contents?.let { content -> safe { WirelessState.pairing = PairingInfo.parse(content); pairingInput.setText(""); WirelessState.publish(WirelessViewState(status = "已扫码，请点击“连接电脑”")); selectTab(2) } }
        } else super.onActivityResult(requestCode, resultCode, data)
    }
    private fun renderWireless(state: WirelessViewState) {
        if (!::wirelessStatus.isInitialized) return
        wirelessStatus.text = state.status
        wirelessConnect.isEnabled = !state.connecting && !state.connected
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
        if (requestCode == 10 && waitingToConnect) {
            waitingToConnect = false
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) connectWireless()
            else toast("请允许通知，便于随时断开电脑连接")
        }
        updateDeviceStatus()
    }
    private fun readSettings() = ModelSettings(url.text.toString(), key.text.toString(), model.text.toString()).also { it.endpoint() }
    private fun loadSettings() = safe {
        SettingsStore(this).load()?.let { url.setText(it.baseUrl); key.setText(it.apiKey); model.setText(it.model); modelStatus.text = "已加载保存的配置" }
    }
    private fun testConnection() = safe {
        if (testing != null) return@safe
        val client = ModelClient(readSettings()); testing = client
        modelStatus.text = "正在测试连接…"
        worker.execute {
            val message = try { client.testConnection() } catch (error: Exception) { if (error is AgentError) "${error.code} · ${error.message}" else "连接测试失败" }
            runOnUiThread { testing = null; if (!isDestroyed) modelStatus.text = message }
        }
    }
    private fun renderState(state: TaskViewState) {
        if (!::status.isInitialized) return
        status.text = state.status; start.isEnabled = !state.running
        if (state.result.isNotBlank()) result.text = state.result
        else if (state.running) result.text = "任务进行中，可从通知栏停止。返回本页可能中断任务。"
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
    override fun onStart() { super.onStart(); TaskState.observe(observer); WirelessState.observe(wirelessObserver) }
    override fun onStop() { TaskState.remove(observer); WirelessState.remove(wirelessObserver); super.onStop() }
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
