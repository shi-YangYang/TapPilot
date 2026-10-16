package dev.tappilot.agent

import android.Manifest
import android.animation.ValueAnimator
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.text.Editable
import android.text.TextUtils
import android.text.TextWatcher
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.PathInterpolator
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Executors
import com.google.zxing.integration.android.IntentIntegrator

/** Protected local control surface: it cannot be read or operated through TapPilot tools. */
class MainActivity : Activity() {
    private val ink = Color.rgb(23, 23, 23)
    private val muted = Color.rgb(99, 99, 99)
    private val primary = Color.rgb(2, 133, 247)
    private val surface = Color.rgb(252, 252, 252)
    private val cardSurface = Color.rgb(245, 245, 245)
    private val border = Color.rgb(229, 229, 229)
    private val danger = Color.rgb(180, 35, 24)
    private val worker = Executors.newSingleThreadExecutor()
    private val tabs = mutableListOf<Button>()
    private lateinit var tabIndicator: View
    private var tabSpring: UiSpring? = null
    private var selectedTab = 0
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
    private lateinit var accessibilityStatus: TextView
    private lateinit var automationStatus: TextView
    private lateinit var notificationStatus: TextView
    private lateinit var taskModelState: Button
    private lateinit var taskDeviceState: Button
    private lateinit var modelStatus: TextView
    private lateinit var start: Button
    private lateinit var stop: Button
    private lateinit var pairingInput: EditText
    private lateinit var wirelessStatus: TextView
    private lateinit var wirelessConnect: Button
    private var waitingToConnect = false
    private var testing: ModelClient? = null
    private var waitingToStart = false
    private var modelConfigured = false
    private val observer: (TaskViewState) -> Unit = { renderState(it) }
    private val wirelessObserver: (WirelessViewState) -> Unit = { renderWireless(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        window.statusBarColor = surface
        window.navigationBarColor = surface
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        val root = column().apply { setBackgroundColor(surface); setPadding(dp(24), dp(20), dp(24), dp(16)); isFocusableInTouchMode = true }
        root.setOnApplyWindowInsetsListener { view, insets ->
            view.setPadding(dp(24) + insets.systemWindowInsetLeft, dp(20) + insets.systemWindowInsetTop, dp(24) + insets.systemWindowInsetRight, dp(12) + insets.systemWindowInsetBottom)
            insets.consumeSystemWindowInsets()
        }
        val brand = row()
        brand.addView(label("T", 17f, Color.WHITE, true).apply { gravity = Gravity.CENTER; background = rounded(primary, 8); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, LinearLayout.LayoutParams(dp(28), dp(28)))
        brand.addView(label("TapPilot", 20f, ink, true), LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = dp(8) })
        brand.addView(badge("手机端"))
        root.addView(brand)
        val navigation = row().apply { setPadding(dp(4), dp(4), dp(4), dp(4)) }
        listOf("任务", "模型", "设备").forEachIndexed { index, name ->
            val button = button(name, false) { selectTab(index) }.apply { background = buttonBackground(false, navigation = true) }
            tabs.add(button)
            navigation.addView(button, LinearLayout.LayoutParams(dp(72), dp(48)).apply { if (index != 2) marginEnd = dp(4) })
        }
        val tabTrack = FrameLayout(this).apply { background = rounded(cardSurface, 28) }
        tabIndicator = View(this).apply { background = rounded(primary, 28); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        tabTrack.addView(tabIndicator, FrameLayout.LayoutParams(dp(72), dp(48)).apply { topMargin = dp(4) })
        tabTrack.addView(navigation, FrameLayout.LayoutParams(-2, -2))
        root.addView(tabTrack, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(20); bottomMargin = dp(16) })
        body = column()
        root.addView(ScrollView(this).apply { isFillViewport = true; isVerticalScrollBarEnabled = false; clipToPadding = false; addView(body) }, LinearLayout.LayoutParams(-1, 0, 1f))
        taskPage = buildTaskPage(); modelPage = buildModelPage(); devicePage = buildDevicePage()
        setContentView(root)
        selectTab(0)
        loadSettings()
    }
    private fun buildTaskPage() = column().apply {
        // PromptInput: p-2, text-sm / leading-6, two rows and a single footer.
        addView(column().apply {
            background = rounded(surface, 16, border); setPadding(dp(8), dp(8), dp(8), dp(8))
            val composer = this
            task = input("让手机帮你完成什么？", multiline = true).apply {
                id = R.id.task_input; minLines = 2; maxLines = 8; textSize = 14f
                includeFontPadding = false; setLineSpacing(maxOf(0f, dp(24) - paint.fontSpacing), 1f)
                background = null; setPadding(dp(8), dp(6), dp(8), 0)
                setOnFocusChangeListener { _, focused -> composer.background = rounded(surface, 16, if (focused) Color.rgb(183, 183, 183) else border) }
            }
            addView(task, LinearLayout.LayoutParams(-1, -2))
            addView(row().apply {
                taskModelState = footerAction("设置模型 ⌄") { selectTab(1) }
                taskDeviceState = footerAction("设备授权 ⌄") { selectTab(2) }
                addView(taskModelState, LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginEnd = dp(4) })
                addView(taskDeviceState, LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginEnd = dp(4) })
                val sendSlot = FrameLayout(this@MainActivity)
                start = button("↑", true, action = ::startTask).apply {
                    id = R.id.task_start; textSize = 22f; setPadding(0, 0, 0, 0)
                    contentDescription = "开始任务"; tooltipText = "开始任务"; isEnabled = false
                    background = InsetDrawable(buttonBackground(true), dp(8))
                }
                stop = button("■", true) { AgentTaskService.cancelActive() }.apply {
                    textSize = 12f; setPadding(0, 0, 0, 0); visibility = View.GONE
                    contentDescription = "停止当前任务"; tooltipText = "停止任务"
                    background = InsetDrawable(buttonBackground(true), dp(8))
                }
                sendSlot.addView(start, FrameLayout.LayoutParams(dp(48), dp(48)))
                sendSlot.addView(stop, FrameLayout.LayoutParams(dp(48), dp(48)))
                addView(sendSlot, LinearLayout.LayoutParams(dp(48), dp(48)))
            }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(4) })
            task.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) { updateSubmitState() }
                override fun afterTextChanged(text: Editable?) = Unit
            })
        }, LinearLayout.LayoutParams(-1, -2))
        addView(label("开始后返回桌面，任务可从通知栏停止。", 12f, muted).apply { setPadding(dp(8), dp(8), dp(8), dp(16)) })
        addView(column().apply {
            setPadding(dp(8), dp(8), dp(8), dp(16))
            status = label("准备就绪", 14f, ink, true).apply { id = R.id.task_status }; addView(status)
            result = label("先配置模型并允许设备自动化。", 14f, muted).apply { setPadding(0, dp(6), 0, 0); setTextIsSelectable(true) }; addView(result)
            timings = label("", 12f, muted).apply { visibility = View.GONE; setPadding(0, dp(8), 0, 0) }; addView(timings)
        })
        addView(label("界面将发送给你配置的模型，本机不保存任务记录。付款、发送、删除需手动完成。", 12f, muted).apply { setPadding(dp(8), dp(8), dp(8), dp(24)) })
    }
    private fun buildModelPage() = column().apply {
        addView(pageTitle("模型设置"))
        addView(label("OpenAI 兼容 · 工具调用 · HTTPS", 14f, muted).apply { setPadding(0, 0, 0, dp(16)) })
        addView(card().apply {
            addView(label("API 地址", 14f, ink, true))
            url = input("https://你的服务地址/v1").apply { id = R.id.model_url; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI }; addView(url)
            addView(label("模型名称", 14f, ink, true).apply { setPadding(0, dp(20), 0, 0) })
            model = input("服务商提供的模型名称").apply { id = R.id.model_name }; addView(model)
            addView(label("API Key", 14f, ink, true).apply { setPadding(0, dp(20), 0, 0) })
            key = input("粘贴 API Key").apply { id = R.id.model_key; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }; addView(key)
            addView(label("仅加密保存在本机；无需密钥时可留空。", 13f, muted).apply { setPadding(0, dp(12), 0, dp(20)) })
            addView(row().apply {
                addView(button("保存配置", true) { safe { SettingsStore(this@MainActivity).save(readSettings()); modelStatus.text = "已保存"; modelConfigured = true; updateTaskSetup() } }.apply { id = R.id.model_save }, LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginEnd = dp(8) })
                addView(button("测试连接", false, action = ::testConnection).apply { id = R.id.model_test }, LinearLayout.LayoutParams(0, dp(48), 1f))
            })
            modelStatus = label("尚未测试", 13f, muted).apply { setPadding(0, dp(16), 0, 0) }; addView(modelStatus)
        })
        addView(button("清除本机模型配置", false) {
            AlertDialog.Builder(this@MainActivity).setTitle("清除模型配置？").setMessage("会删除本机保存的 API 地址、模型名称与密钥。").setNegativeButton("取消", null)
                .setPositiveButton("清除") { _, _ -> SettingsStore(this@MainActivity).clear(); url.setText(""); key.setText(""); model.setText(""); modelStatus.text = "配置已清除"; modelConfigured = false; updateTaskSetup() }.show()
        }, LinearLayout.LayoutParams(-1, dp(48)).apply { bottomMargin = dp(24) })
    }
    private fun buildDevicePage() = column().apply {
        addView(pageTitle("设备与连接"))
        addView(card().apply {
            addView(sectionTitle("手机权限", "必需"))
            accessibilityStatus = label("未开启", 13f, muted)
            addView(permissionRow("无障碍服务", accessibilityStatus, button("开启服务", true) { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }))
            addView(label("在系统设置中找到“TapPilot 手机自动化”。受限设置请按系统指引处理。", 13f, muted).apply { setPadding(0, dp(10), 0, dp(16)) })
            addView(divider(), LinearLayout.LayoutParams(-1, dp(1)))
            automationStatus = label("已停止", 13f, muted)
            addView(permissionRow("自动化", automationStatus, button("允许 / 恢复", false) {
                safe {
                    val service = AgentAccessibilityService.instance ?: throw AgentError("SERVICE_UNAVAILABLE", "请先开启无障碍服务，再允许自动化")
                    service.resumeLocally(); updateDeviceStatus()
                }
            }))
            addView(divider(), LinearLayout.LayoutParams(-1, dp(1)).apply { topMargin = dp(16) })
            notificationStatus = label("待允许", 13f, muted)
            addView(permissionRow("任务通知", notificationStatus, button("允许通知", false) { requestNotifications() }))
        })
        addView(card(outlined = true).apply {
            addView(sectionTitle("连接电脑", "可选"))
            wirelessStatus = label("尚未连接", 14f, muted).apply { id = R.id.wireless_status; setPadding(0, dp(12), 0, dp(12)) }; addView(wirelessStatus)
            addView(label("同一 Wi-Fi 下，在电脑设备页显示二维码。", 13f, muted))
            addView(button("扫描二维码", true, action = ::scanPairing).apply { id = R.id.wireless_scan; contentDescription = "扫描电脑二维码" }, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(16) })
            pairingInput = input("或粘贴电脑端配对地址").apply { id = R.id.wireless_pairing; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }; addView(pairingInput)
            addView(row().apply {
                wirelessConnect = button("连接电脑", false, action = ::connectWireless).apply { id = R.id.wireless_connect }
                addView(wirelessConnect, LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginEnd = dp(8) })
                addView(button("断开连接", false) { WirelessService.disconnectActive() }, LinearLayout.LayoutParams(0, dp(48), 1f))
            }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
            addView(label("重启应用需重新配对；连接期间不能运行手机端任务。", 13f, muted).apply { setPadding(0, dp(14), 0, 0) })
        })
        addView(card(outlined = true).apply {
            addView(label("安全控制", 15f, ink, true))
            addView(label("通知栏可停止任务。急停后需在上方手动恢复。", 13f, muted).apply { setPadding(0, dp(10), 0, dp(16)) })
            addView(button("紧急停止所有自动化", false, dangerButton = true) {
                safe { AgentAccessibilityService.latchEmergencyStop(this@MainActivity); updateDeviceStatus() }
            }, LinearLayout.LayoutParams(-1, dp(48)))
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
        updateTaskSetup()
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
        SettingsStore(this).load()?.let { url.setText(it.baseUrl); key.setText(it.apiKey); model.setText(it.model); modelStatus.text = "已加载保存的配置"; modelConfigured = true }
        updateTaskSetup()
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
        status.text = state.status; updateSubmitState(state.running)
        if (state.result.isNotBlank()) result.text = state.result
        else if (state.running) result.text = "任务进行中，可从通知栏停止。返回本页可能中断任务。"
        result.setTextColor(if (state.result.isNotBlank()) ink else muted)
        val modelMs = state.events.filter { it.phase == "model" }.sumOf { it.durationMs }
        val toolMs = state.events.filter { it.phase == "tool" }.sumOf { it.durationMs }
        val rounds = state.events.maxOfOrNull { it.round } ?: 0
        val modelRequests = state.events.count { it.phase == "model" }
        val toolCalls = state.events.count { it.phase == "tool" }
        val totalMs = state.events.maxOfOrNull { it.elapsedMs } ?: 0
        timings.visibility = if (rounds > 0) View.VISIBLE else View.GONE
        if (rounds > 0) timings.text = "总用时 ${"%.1f".format(totalMs / 1000.0)} 秒 · 模型 $modelRequests 次 · 操作 $toolCalls 次\n模型 ${"%.1f".format(modelMs / 1000.0)} 秒 · 手机 ${"%.1f".format(toolMs / 1000.0)} 秒"
    }
    private fun updateSubmitState(running: Boolean = TaskState.value.running) {
        if (!::start.isInitialized) return
        start.isEnabled = !running && task.text.isNotBlank()
        start.visibility = if (running) View.GONE else View.VISIBLE
        stop.visibility = if (running) View.VISIBLE else View.GONE
        stop.isEnabled = running
    }
    private fun updateDeviceStatus() {
        if (!::accessibilityStatus.isInitialized) return
        val stopped = getSharedPreferences("safety", MODE_PRIVATE).getBoolean("stopped", true)
        val notifications = if (Build.VERSION.SDK_INT >= 33) checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED else true
        accessibilityStatus.text = if (AgentAccessibilityService.instance != null) "已开启" else "未开启"
        automationStatus.text = if (stopped) "已停止" else "已允许"
        notificationStatus.text = if (notifications) "已允许" else "待允许"
        updateTaskSetup()
    }
    private fun updateTaskSetup() {
        if (!::taskModelState.isInitialized) return
        taskModelState.text = if (modelConfigured) "模型已设置 ⌄" else "设置模型 ⌄"
        taskModelState.contentDescription = if (modelConfigured) "模型已设置，打开模型设置" else "尚未配置模型，打开模型设置"
        val stopped = getSharedPreferences("safety", MODE_PRIVATE).getBoolean("stopped", true)
        val notifications = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        taskDeviceState.text = when {
            WirelessState.value.connected || WirelessState.value.connecting -> "电脑已连接 ⌄"
            AgentAccessibilityService.instance != null && !stopped && notifications -> "设备就绪 ⌄"
            else -> "设备授权 ⌄"
        }
    }
    private fun selectTab(index: Int) {
        val changed = body.childCount > 0 && selectedTab != index
        selectedTab = index
        body.removeAllViews(); body.addView(listOf(taskPage, modelPage, devicePage)[index])
        tabs.forEachIndexed { i, button -> button.isSelected = i == index; button.setTextColor(buttonTextColors(if (i == index) Color.WHITE else muted)) }
        if (tabs[index].width > 0) moveTabIndicator(index, changed) else tabIndicator.post { moveTabIndicator(selectedTab, false) }
        (body.parent as? ScrollView)?.scrollTo(0, 0)
        body.animate().cancel()
        if (changed && ValueAnimator.areAnimatorsEnabled()) {
            body.alpha = 0f; body.translationY = dp(4).toFloat()
            body.animate().alpha(1f).translationY(0f).setDuration(180).setInterpolator(PathInterpolator(0.16f, 1f, 0.3f, 1f)).start()
        } else { body.alpha = 1f; body.translationY = 0f }
        updateDeviceStatus()
    }
    private fun moveTabIndicator(index: Int, animate: Boolean) {
        if (!tabIndicator.isAttachedToWindow) return
        // tabs.tsx defines its own spring, separate from SPRING_LAYOUT.
        val spring = tabSpring ?: UiSpring(245f, 36f, 1.2f, tabIndicator.translationX) { tabIndicator.translationX = it }.also { tabSpring = it }
        spring.to(tabs[index].left.toFloat(), animate)
    }
    override fun onStart() { super.onStart(); TaskState.observe(observer); WirelessState.observe(wirelessObserver) }
    override fun onStop() { TaskState.remove(observer); WirelessState.remove(wirelessObserver); super.onStop() }
    override fun onResume() { super.onResume(); updateDeviceStatus() }
    override fun onDestroy() { tabSpring?.cancel(); if (::body.isInitialized) body.animate().cancel(); testing?.cancel(); worker.shutdownNow(); super.onDestroy() }
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.flags and (MotionEvent.FLAG_WINDOW_IS_OBSCURED or MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED) != 0) return false
        return super.dispatchTouchEvent(event)
    }
    private fun safe(action: () -> Unit) { try { action() } catch (error: Exception) { toast(if (error is AgentError) error.message else "操作未完成，请检查配置后重试") } }
    private fun toast(value: String) { Toast.makeText(this, value, Toast.LENGTH_LONG).show() }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun rounded(color: Int, radius: Int, stroke: Int? = null, strokeWidth: Int = 1) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radius).toFloat()
        if (stroke != null) setStroke(dp(strokeWidth), stroke)
    }
    private fun label(value: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value; textSize = size; setTextColor(color); includeFontPadding = false; setLineSpacing(dp(4).toFloat(), 1f)
        typeface = Typeface.create(if (bold) "sans-serif-medium" else "sans-serif", Typeface.NORMAL)
    }
    private fun pageTitle(value: String) = label(value, 18f, ink, true).apply { setPadding(0, 0, 0, dp(16)) }
    private fun badge(value: String) = label(value, 12f, muted, true).apply { background = rounded(cardSurface, 20); setPadding(dp(10), dp(6), dp(10), dp(6)) }
    private fun sectionTitle(value: String, suffix: String) = row().apply {
        addView(label(value, 15f, ink, true), LinearLayout.LayoutParams(0, -2, 1f))
        addView(badge(suffix))
    }
    private fun divider() = View(this).apply { setBackgroundColor(border) }
    private fun permissionRow(title: String, state: TextView, action: Button) = row().apply {
        addView(column().apply {
            addView(label(title, 15f, ink, true))
            addView(state.apply { setPadding(0, dp(5), 0, 0) })
        }, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(8) })
        addView(action, LinearLayout.LayoutParams(dp(112), dp(48)))
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) }
    }
    private fun card(outlined: Boolean = true) = column().apply {
        background = rounded(if (outlined) surface else cardSurface, 16, if (outlined) border else null)
        setPadding(dp(16), dp(16), dp(16), dp(16))
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(16) }
    }
    private fun buttonTextColors(enabledColor: Int) = ColorStateList(
        arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
        intArrayOf(Color.argb(128, Color.red(enabledColor), Color.green(enabledColor), Color.blue(enabledColor)), enabledColor)
    )
    private fun buttonBackground(primaryButton: Boolean, dangerButton: Boolean = false, navigation: Boolean = false): Drawable {
        val fill = when { primaryButton -> primary; dangerButton -> Color.rgb(255, 244, 243); navigation -> Color.TRANSPARENT; else -> cardSurface }
        val outline = when { primaryButton -> primary; dangerButton -> Color.rgb(247, 213, 209); navigation -> Color.TRANSPARENT; else -> border }
        return StateListDrawable().apply {
            addState(intArrayOf(-android.R.attr.state_enabled), rounded(fill, 28, outline).apply { alpha = 128 })
            addState(intArrayOf(android.R.attr.state_focused), rounded(fill, 28, if (dangerButton) danger else primary, 2))
            addState(intArrayOf(), rounded(fill, 28, outline))
        }
    }
    private fun button(value: String, primary: Boolean, dangerButton: Boolean = false, action: () -> Unit) = BeUiButton(this).apply {
        text = value; textSize = 14f; isAllCaps = false; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setTextColor(buttonTextColors(if (primary) Color.WHITE else if (dangerButton) danger else ink)); background = buttonBackground(primary, dangerButton)
        filterTouchesWhenObscured = true; minHeight = 0; minWidth = 0; minimumHeight = 0; minimumWidth = 0
        elevation = 0f; stateListAnimator = null; includeFontPadding = false; setPadding(dp(12), 0, dp(12), 0)
        gravity = Gravity.CENTER; isAllCaps = false
        setOnClickListener { action() }
    }
    private fun footerAction(value: String, action: () -> Unit) = button(value, false, action = action).apply {
        textSize = 12f; setTextColor(buttonTextColors(muted)); setPadding(dp(8), 0, dp(8), 0)
        setSingleLine(); ellipsize = TextUtils.TruncateAt.END
        background = buttonBackground(false, navigation = true)
    }
    private fun input(hintValue: String, multiline: Boolean = false) = EditText(this).apply {
        hint = hintValue; textSize = 14f; setTextColor(ink); setHintTextColor(Color.rgb(132, 132, 132)); isSaveEnabled = false
        typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        inputType = InputType.TYPE_CLASS_TEXT or if (multiline) InputType.TYPE_TEXT_FLAG_MULTI_LINE else InputType.TYPE_TEXT_VARIATION_NORMAL
        setSingleLine(!multiline); gravity = if (multiline) Gravity.TOP or Gravity.START else Gravity.CENTER_VERTICAL or Gravity.START
        setPadding(dp(14), dp(14), dp(14), dp(14)); minHeight = dp(48)
        background = StateListDrawable().apply {
            addState(intArrayOf(-android.R.attr.state_enabled), rounded(cardSurface, 12, border))
            addState(intArrayOf(android.R.attr.state_focused), rounded(Color.WHITE, 12, primary, 2))
            addState(intArrayOf(), rounded(Color.WHITE, 12, border))
        }
        if (Build.VERSION.SDK_INT >= 26) importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) }
    }
}
