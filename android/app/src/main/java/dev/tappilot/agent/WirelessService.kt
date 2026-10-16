package dev.tappilot.agent

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONObject
import java.util.UUID

internal data class WirelessViewState(val connecting: Boolean = false, val connected: Boolean = false, val status: String = "尚未连接电脑")
internal object WirelessState {
    @Volatile var value = WirelessViewState()
        private set
    // Deliberately memory-only. Neither URI nor token enters SharedPreferences or saved UI state.
    var pairing: PairingInfo? = null
    private val main = Handler(Looper.getMainLooper())
    private val observers = mutableSetOf<(WirelessViewState) -> Unit>()
    fun observe(listener: (WirelessViewState) -> Unit) { observers.add(listener); listener(value) }
    fun remove(listener: (WirelessViewState) -> Unit) { observers.remove(listener) }
    fun publish(state: WirelessViewState) {
        val update = { value = state; observers.toList().forEach { it(state) } }
        if (Looper.myLooper() == Looper.getMainLooper()) update() else main.post(update)
    }
}

/** Explicit foreground LAN session. No boot receiver, reconnect loop, or persisted pairing token. */
class WirelessService : Service() {
    companion object {
        const val CONNECT = "dev.tappilot.agent.WIRELESS_CONNECT"
        const val DISCONNECT = "dev.tappilot.agent.WIRELESS_DISCONNECT"
        const val EMERGENCY = "dev.tappilot.agent.WIRELESS_EMERGENCY"
        private const val CHANNEL = "tappilot-wireless"
        private const val NOTIFICATION = 43
        @Volatile private var active: WirelessService? = null
        fun disconnectActive() { active?.disconnect() }
        fun deviceId(context: android.content.Context): String {
            val preferences = context.getSharedPreferences("wireless_identity", MODE_PRIVATE)
            return preferences.getString("deviceId", null) ?: UUID.randomUUID().toString().also { preferences.edit().putString("deviceId", it).commit() }
        }
    }
    private val main = Handler(Looper.getMainLooper())
    private val owner = Any()
    private val sessionId = UUID.randomUUID().toString()
    private var connection: WirelessConnection? = null
    private var stopping = false
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "电脑无线连接", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            CONNECT -> {
                if (connection != null) return START_NOT_STICKY
                val notification = notification("正在建立加密连接")
                if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
                else startForeground(NOTIFICATION, notification)
                if (!AutomationOwner.acquire(owner)) { finish("手机正在执行其他任务，请先停止再连接电脑"); return START_NOT_STICKY }
                val pairing = WirelessState.pairing
                if (pairing == null) { finish("配对信息已失效，请重新扫码或粘贴"); return START_NOT_STICKY }
                active = this
                stopping = false
                WirelessState.publish(WirelessViewState(connecting = true, status = "正在验证电脑证书并连接…"))
                val name = "${Build.MANUFACTURER} ${Build.MODEL}".replace(Regex("[\\p{Cntrl}]"), "").take(128)
                connection = WirelessConnection(pairing, deviceId(this), name.ifBlank { "Android" }, PhoneExecutor { method, params, canContinue ->
                    if (!canContinue()) throw AgentError("CANCELLED", "无线连接已关闭")
                    val service = AgentAccessibilityService.instance
                    if (method == "emergency_stop" && service == null) {
                        AgentAccessibilityService.latchEmergencyStop(this)
                        JSONObject().put("stopped", true).put("revision", 0)
                    } else if (method == "get_device_info" && service == null) {
                        JSONObject().put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
                            .put("sdkInt", Build.VERSION.SDK_INT).put("androidVersion", Build.VERSION.RELEASE)
                            .put("serviceConnected", false).put("stopped", getSharedPreferences("safety", MODE_PRIVATE).getBoolean("stopped", true))
                            .put("revision", 0).put("locked", getSystemService(KeyguardManager::class.java).isKeyguardLocked)
                            .put("transport", "pinned-wss").put("protocolVersion", 1).put("sessionId", sessionId)
                    } else {
                        val controller = service ?: throw AgentError("SERVICE_UNAVAILABLE", "请先在手机手动开启 TapPilot 无障碍服务", true)
                        controller.dispatch(method, params, canContinue)
                    }
                }, { AgentAccessibilityService.latchEmergencyStop(this) }) { connected, message ->
                    main.post {
                        if (!stopping) {
                            if (connected && connection?.isConnected() == true) {
                                WirelessState.publish(WirelessViewState(connected = true, status = message))
                                getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification("已连接电脑，可从通知断开"))
                            } else if (!connected) finish(message)
                        }
                    }
                }
                connection?.start()
            }
            EMERGENCY -> {
                try { AgentAccessibilityService.latchEmergencyStop(this); disconnect() }
                catch (error: AgentError) { finish(error.message) }
            }
            DISCONNECT -> disconnect()
            else -> stopSelf()
        }
        return START_NOT_STICKY
    }
    private fun finish(message: String) {
        if (stopping) return
        stopping = true
        connection?.close(); connection = null
        AutomationOwner.release(owner)
        WirelessState.publish(WirelessViewState(status = message))
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }
    private fun disconnect() {
        if (Looper.myLooper() != Looper.getMainLooper()) main.post { disconnect() }
        else finish("已断开连接；已交给 Android 的动作可能已发生，请检查当前界面")
    }
    private fun notification(message: String): Notification {
        val open = PendingIntent.getActivity(this, 3, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        fun action(value: String, id: Int) = PendingIntent.getService(this, id, Intent(this, WirelessService::class.java).setAction(value), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_share).setContentTitle("TapPilot · 电脑无线连接")
            .setContentText(message).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(Notification.Action.Builder(null, "断开电脑", action(DISCONNECT, 4)).build())
            .addAction(Notification.Action.Builder(null, "紧急停止", action(EMERGENCY, 5)).build()).build()
    }
    override fun onDestroy() {
        stopping = true
        connection?.close(); connection = null
        AutomationOwner.release(owner)
        if (active === this) active = null
        if (WirelessState.value.connected || WirelessState.value.connecting) WirelessState.publish(WirelessViewState(status = "无线服务已结束，请手动重新连接"))
        super.onDestroy()
    }
}
