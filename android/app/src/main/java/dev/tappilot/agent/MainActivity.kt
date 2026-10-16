package dev.tappilot.agent

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
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
import com.google.zxing.client.android.Intents
import com.google.zxing.integration.android.IntentIntegrator

/** Protected phone endpoint controls. Tasks and model credentials belong to the computer. */
class MainActivity : Activity() {
    private var darkTheme = true
    private val ink get() = if (darkTheme) Color.rgb(244, 244, 244) else Color.rgb(23, 23, 23)
    private val muted get() = if (darkTheme) Color.rgb(160, 160, 160) else Color.rgb(99, 99, 99)
    private val primary get() = ink
    private val primaryText get() = if (darkTheme) Color.rgb(16, 16, 16) else Color.WHITE
    private val backgroundColor get() = if (darkTheme) Color.rgb(16, 16, 16) else Color.WHITE
    private val surface get() = if (darkTheme) Color.rgb(24, 24, 24) else Color.WHITE
    private val cardSurface get() = if (darkTheme) Color.rgb(32, 32, 32) else Color.rgb(248, 248, 248)
    private val border get() = if (darkTheme) Color.rgb(48, 48, 48) else Color.rgb(229, 229, 229)
    private val danger get() = if (darkTheme) Color.rgb(239, 155, 150) else Color.rgb(156, 67, 61)
    private lateinit var body: LinearLayout
    private lateinit var wirelessPanel: LinearLayout
    private lateinit var usbPanel: LinearLayout
    private lateinit var wirelessChoice: Button
    private lateinit var usbChoice: Button
    private lateinit var accessibilityStatus: TextView
    private lateinit var automationStatus: TextView
    private lateinit var notificationStatus: TextView
    private lateinit var pairingInput: EditText
    private lateinit var manualPairing: LinearLayout
    private lateinit var manualToggle: Button
    private lateinit var wirelessStatus: TextView
    private lateinit var wirelessScan: Button
    private lateinit var wirelessConnect: Button
    private lateinit var wirelessDisconnect: Button
    private var selectedConnection = 0
    private var manualPairingVisible = false
    private var waitingToConnect = false
    private lateinit var protectedTouch: ProtectedTouchGuard
    private val wirelessObserver: (WirelessViewState) -> Unit = { renderWireless(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        darkTheme = getSharedPreferences("appearance", MODE_PRIVATE).getBoolean("dark_theme", true)
        setTheme(if (darkTheme) R.style.Theme_TapPilot else R.style.Theme_TapPilot_Light)
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        protectedTouch = ProtectedTouchGuard.forWindow(window)
        buildContent()
        safe { LegacyModelSettings.remove(this) }
    }

    private fun buildContent() {
        window.setBackgroundDrawable(ColorDrawable(backgroundColor))
        window.statusBarColor = backgroundColor
        window.navigationBarColor = backgroundColor
        window.decorView.systemUiVisibility = if (darkTheme) 0 else View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        val root = column().apply { setBackgroundColor(backgroundColor); setPadding(dp(24), dp(20), dp(24), dp(16)); isFocusableInTouchMode = true }
        root.setOnApplyWindowInsetsListener { view, insets ->
            view.setPadding(dp(24) + insets.systemWindowInsetLeft, dp(20) + insets.systemWindowInsetTop, dp(24) + insets.systemWindowInsetRight, dp(12) + insets.systemWindowInsetBottom)
            insets.consumeSystemWindowInsets()
        }
        root.addView(row().apply {
            addView(label("T", 17f, primaryText, true).apply { gravity = Gravity.CENTER; background = rounded(primary, 7); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, LinearLayout.LayoutParams(dp(28), dp(28)))
            addView(label("TapPilot", 19f, ink, true), LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = dp(9) })
            addView(button(if (darkTheme) "☀ 浅色" else "☾ 深色", false, action = ::toggleTheme).apply {
                id = R.id.theme_toggle; textSize = 12f
                contentDescription = if (darkTheme) "切换为浅色主题" else "切换为深色主题"
                background = buttonBackground(false, navigation = true)
            }, LinearLayout.LayoutParams(dp(88), dp(48)))
        })
        body = column().apply { setPadding(0, dp(28), 0, dp(16)) }
        root.addView(ScrollView(this).apply { isFillViewport = true; isVerticalScrollBarEnabled = false; addView(body) }, LinearLayout.LayoutParams(-1, 0, 1f))
        body.addView(label("连接电脑", 30f, ink, true).apply { letterSpacing = -0.035f })
        body.addView(label("在电脑端设置模型、发起任务。", 13f, muted).apply { setPadding(0, dp(10), 0, dp(24)) })
        body.addView(row().apply {
            background = rounded(cardSurface, 14, border); setPadding(dp(4), dp(4), dp(4), dp(4))
            wirelessChoice = button("扫码连接", false) { selectConnection(0) }.apply { id = R.id.connection_wireless }
            usbChoice = button("USB · ADB", false) { selectConnection(1) }.apply { id = R.id.connection_usb }
            addView(wirelessChoice, LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginEnd = dp(4) })
            addView(usbChoice, LinearLayout.LayoutParams(0, dp(48), 1f))
        })
        wirelessPanel = buildWirelessPanel()
        usbPanel = buildUsbPanel()
        body.addView(wirelessPanel, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(24); bottomMargin = dp(28) })
        body.addView(usbPanel, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(24); bottomMargin = dp(28) })
        body.addView(divider(), LinearLayout.LayoutParams(-1, dp(1)))
        body.addView(buildPermissions(), LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(24) })
        root.addView(button("紧急停止", false, dangerButton = true) {
            safe { AgentAccessibilityService.latchEmergencyStop(this); updateDeviceStatus() }
        }.apply { id = R.id.emergency_stop }, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(12) })
        setContentView(root)
        selectConnection(selectedConnection)
        renderWireless(WirelessState.value)
        updateDeviceStatus()
    }

    private fun buildWirelessPanel() = column().apply {
        wirelessStatus = label("尚未连接电脑", 18f, ink, true).apply { id = R.id.wireless_status }
        addView(wirelessStatus)
        addView(label("连接同一 Wi-Fi，扫描电脑端二维码。", 13f, muted).apply { setPadding(0, dp(10), 0, dp(20)) })
        wirelessScan = button("扫描二维码", true, action = ::scanPairing).apply { id = R.id.wireless_scan; contentDescription = "扫描电脑二维码" }
        addView(wirelessScan, LinearLayout.LayoutParams(-1, dp(52)))
        addView(row().apply {
            wirelessConnect = button("连接电脑", false, action = ::connectWireless).apply { id = R.id.wireless_connect }
            wirelessDisconnect = button("断开连接", false) { WirelessService.disconnectActive() }.apply { id = R.id.wireless_disconnect }
            addView(wirelessConnect, LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginEnd = dp(8) })
            addView(wirelessDisconnect, LinearLayout.LayoutParams(0, dp(48), 1f))
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) })
        manualToggle = button("无法扫码？粘贴配对地址", false) {
            manualPairingVisible = !manualPairingVisible
            updateManualPairing()
        }.apply { id = R.id.wireless_manual; textSize = 12f; setTextColor(buttonTextColors(muted)); background = buttonBackground(false, navigation = true) }
        addView(manualToggle, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(4) })
        manualPairing = column().apply {
            pairingInput = input("电脑端配对地址").apply { id = R.id.wireless_pairing }
            addView(pairingInput)
        }
        addView(manualPairing)
        updateManualPairing()
    }

    private fun buildUsbPanel() = column().apply {
        addView(label("用数据线连接", 18f, ink, true))
        addView(label("开启 USB 调试并授权电脑，再在电脑端选择 USB 连接。", 13f, muted).apply { setPadding(0, dp(10), 0, dp(20)) })
        addView(button("打开开发者选项", false) { safe { startActivity(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)) } }.apply { id = R.id.usb_settings }, LinearLayout.LayoutParams(-1, dp(48)))
        addView(label("连接状态请在电脑端查看。", 12f, muted).apply { id = R.id.usb_status; setPadding(0, dp(12), 0, 0) })
    }

    private fun buildPermissions() = column().apply {
        addView(label("手机授权", 16f, ink, true))
        accessibilityStatus = label("未开启", 12f, muted)
        addView(permissionRow("无障碍服务", accessibilityStatus, button("开启服务", false) { safe { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) } }.apply { id = R.id.accessibility_settings }))
        addView(label("系统设置 → TapPilot 手机自动化", 12f, muted).apply { setPadding(0, dp(8), 0, dp(16)) })
        addView(divider(), LinearLayout.LayoutParams(-1, dp(1)))
        automationStatus = label("已停止", 12f, muted).apply { id = R.id.automation_status }
        addView(permissionRow("允许控制", automationStatus, button("允许 / 恢复", false) {
            safe {
                val service = AgentAccessibilityService.instance ?: throw AgentError("SERVICE_UNAVAILABLE", "请先开启无障碍服务，再允许控制")
                service.resumeLocally(); updateDeviceStatus()
            }
        }.apply { id = R.id.automation_resume }))
        addView(divider(), LinearLayout.LayoutParams(-1, dp(1)).apply { topMargin = dp(16) })
        notificationStatus = label("待允许", 12f, muted)
        addView(permissionRow("连接通知", notificationStatus, button("允许通知", false) { requestNotifications() }.apply { id = R.id.notification_settings }))
        addView(label("急停后，请在此手动恢复控制。", 12f, muted).apply { setPadding(0, dp(16), 0, 0) })
    }

    private fun selectConnection(index: Int) {
        if (index == 1 && (WirelessState.value.connecting || WirelessState.value.connected)) {
            toast("请先断开无线连接")
            selectConnection(0)
            return
        }
        selectedConnection = index
        wirelessPanel.visibility = if (index == 0) View.VISIBLE else View.GONE
        usbPanel.visibility = if (index == 1) View.VISIBLE else View.GONE
        listOf(wirelessChoice, usbChoice).forEachIndexed { i, choice ->
            choice.isSelected = i == index
            choice.setTextColor(buttonTextColors(if (i == index) ink else muted))
            choice.background = if (i == index) rounded(surface, 10, border) else buttonBackground(false, navigation = true)
        }
    }

    private fun updateManualPairing() {
        manualPairing.visibility = if (manualPairingVisible) View.VISIBLE else View.GONE
        manualToggle.text = if (manualPairingVisible) "收起配对地址" else "无法扫码？粘贴配对地址"
    }

    private fun toggleTheme() {
        // Pairing credentials remain in memory only when rebuilding the view for appearance changes.
        val draft = pairingInput.text.toString()
        val selectionStart = pairingInput.selectionStart
        val selectionEnd = pairingInput.selectionEnd
        val focusedId = currentFocus?.id
        val scrollY = (body.parent as ScrollView).scrollY
        darkTheme = !darkTheme
        getSharedPreferences("appearance", MODE_PRIVATE).edit().putBoolean("dark_theme", darkTheme).apply()
        setTheme(if (darkTheme) R.style.Theme_TapPilot else R.style.Theme_TapPilot_Light)
        buildContent()
        pairingInput.setText(draft)
        pairingInput.setSelection(selectionStart.coerceIn(0, draft.length), selectionEnd.coerceIn(0, draft.length))
        val newBody = body
        newBody.post {
            if (body === newBody && newBody.isAttachedToWindow) {
                if (focusedId == R.id.wireless_pairing) pairingInput.requestFocus()
                (newBody.parent as ScrollView).scrollTo(0, scrollY)
            }
        }
    }

    private fun scanPairing() = safe {
        if (WirelessState.value.connecting || WirelessState.value.connected) { toast("请先断开电脑，再扫描新的配对码"); return@safe }
        IntentIntegrator(this).setCaptureActivity(SecureScanActivity::class.java).setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
            .setPrompt("扫描 TapPilot 电脑端的无线配对二维码").setBeepEnabled(false).setBarcodeImageEnabled(false).setOrientationLocked(false)
            .addExtra(Intents.Scan.SHOW_MISSING_CAMERA_PERMISSION_DIALOG, false).initiateScan()
    }

    private fun connectWireless() = safe {
        if (WirelessState.value.connecting || WirelessState.value.connected) return@safe
        if (AutomationOwner.busy()) { toast("连接正在切换，请稍后重试"); return@safe }
        val entered = pairingInput.text.toString()
        if (entered.isNotBlank()) WirelessState.pairing = PairingInfo.parse(entered)
        if (WirelessState.pairing == null) { toast("先扫描或粘贴电脑端配对地址"); return@safe }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            waitingToConnect = true; requestNotifications(); return@safe
        }
        startForegroundService(Intent(this, WirelessService::class.java).setAction(WirelessService.CONNECT))
        pairingInput.setText("")
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (result != null) {
            if (data?.getBooleanExtra(Intents.Scan.MISSING_CAMERA_PERMISSION, false) == true) toast("请允许相机权限后再扫码")
            result.contents?.let { content -> safe {
                WirelessState.pairing = PairingInfo.parse(content)
                pairingInput.setText("")
                WirelessState.publish(WirelessViewState(status = "已扫码，点击连接电脑"))
                selectConnection(0)
            } }
        } else super.onActivityResult(requestCode, resultCode, data)
    }

    private fun renderWireless(state: WirelessViewState) {
        if (!::wirelessStatus.isInitialized) return
        wirelessStatus.text = state.status
        val active = state.connecting || state.connected
        if (active && selectedConnection == 1) selectConnection(0)
        wirelessScan.isEnabled = !active
        wirelessConnect.isEnabled = !active
        wirelessDisconnect.isEnabled = active
        pairingInput.isEnabled = !active
    }

    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 10)
        else toast("此系统无需单独授予通知权限")
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 10 && waitingToConnect) {
            waitingToConnect = false
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) connectWireless()
            else toast("请允许通知，便于随时断开电脑连接")
        }
        updateDeviceStatus()
    }
    private fun updateDeviceStatus() {
        if (!::accessibilityStatus.isInitialized) return
        val stopped = getSharedPreferences("safety", MODE_PRIVATE).getBoolean("stopped", true)
        val notifications = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        accessibilityStatus.text = if (AgentAccessibilityService.instance != null) "已开启" else "未开启"
        automationStatus.text = if (stopped) "已停止" else "已允许"
        notificationStatus.text = if (notifications) "已允许" else "待允许"
    }
    override fun onStart() { super.onStart(); WirelessState.observe(wirelessObserver) }
    override fun onStop() { WirelessState.remove(wirelessObserver); super.onStop() }
    override fun onResume() { super.onResume(); updateDeviceStatus() }
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        return protectedTouch.dispatch(event) { super.dispatchTouchEvent(it) }
    }
    private fun safe(action: () -> Unit) { try { action() } catch (error: Exception) { toast(if (error is AgentError) error.message else "操作未完成，请稍后重试") } }
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
    private fun divider() = View(this).apply { setBackgroundColor(border) }
    private fun permissionRow(title: String, state: TextView, action: Button) = row().apply {
        addView(column().apply {
            addView(label(title, 15f, ink, true))
            addView(state.apply { setPadding(0, dp(5), 0, 0) })
        }, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(8) })
        addView(action, LinearLayout.LayoutParams(dp(112), dp(48)))
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) }
    }
    private fun buttonTextColors(enabledColor: Int) = ColorStateList(
        arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
        intArrayOf(Color.argb(128, Color.red(enabledColor), Color.green(enabledColor), Color.blue(enabledColor)), enabledColor)
    )
    private fun buttonBackground(primaryButton: Boolean, dangerButton: Boolean = false, navigation: Boolean = false): Drawable {
        val fill = when { primaryButton -> primary; navigation -> Color.TRANSPARENT; else -> surface }
        val outline = when { primaryButton -> primary; navigation -> Color.TRANSPARENT; else -> border }
        return StateListDrawable().apply {
            addState(intArrayOf(-android.R.attr.state_enabled), rounded(fill, 12, outline).apply { alpha = 128 })
            addState(intArrayOf(android.R.attr.state_focused), rounded(fill, 12, if (dangerButton) danger else primary, 2))
            addState(intArrayOf(), rounded(fill, 12, outline))
        }
    }
    private fun button(value: String, primary: Boolean, dangerButton: Boolean = false, action: () -> Unit) = BeUiButton(this).apply {
        text = value; textSize = 14f; isAllCaps = false; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setTextColor(buttonTextColors(if (primary) primaryText else if (dangerButton) danger else ink)); background = buttonBackground(primary, dangerButton)
        filterTouchesWhenObscured = true; minHeight = 0; minWidth = 0; minimumHeight = 0; minimumWidth = 0
        elevation = 0f; stateListAnimator = null; includeFontPadding = false; setPadding(dp(12), 0, dp(12), 0)
        gravity = Gravity.CENTER
        setOnClickListener { action() }
    }
    private fun input(hintValue: String) = EditText(this).apply {
        hint = hintValue; textSize = 14f; setTextColor(ink); setHintTextColor(muted); isSaveEnabled = false
        typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        setSingleLine(); gravity = Gravity.CENTER_VERTICAL or Gravity.START
        setPadding(dp(14), dp(14), dp(14), dp(14)); minHeight = dp(52)
        background = StateListDrawable().apply {
            addState(intArrayOf(-android.R.attr.state_enabled), rounded(cardSurface, 12, border))
            addState(intArrayOf(android.R.attr.state_focused), rounded(surface, 12, primary))
            addState(intArrayOf(), rounded(surface, 12, border))
        }
        if (Build.VERSION.SDK_INT >= 26) importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) }
    }
}
