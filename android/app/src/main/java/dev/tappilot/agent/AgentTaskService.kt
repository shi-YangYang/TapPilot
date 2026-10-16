package dev.tappilot.agent

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
import android.os.SystemClock
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.Future

internal data class TaskViewState(val running: Boolean = false, val status: String = "准备就绪", val result: String = "", val events: List<RunEvent> = emptyList())
internal object TaskState {
    @Volatile var value = TaskViewState()
        private set
    private val observers = mutableSetOf<(TaskViewState) -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    fun observe(listener: (TaskViewState) -> Unit) { observers.add(listener); listener(value) }
    fun remove(listener: (TaskViewState) -> Unit) { observers.remove(listener) }
    fun publish(state: TaskViewState) {
        val update = { value = state; observers.toList().forEach { it(state) } }
        if (Looper.myLooper() == Looper.getMainLooper()) update() else main.post(update)
    }
}

/** A visible, user-started foreground task, never restarted automatically after process death. */
class AgentTaskService : Service() {
    companion object {
        private const val CHANNEL = "tappilot-tasks"
        private const val NOTIFICATION = 42
        const val ACTION_START = "dev.tappilot.agent.START_TASK"
        const val ACTION_STOP = "dev.tappilot.agent.STOP_TASK"
        const val ACTION_EMERGENCY = "dev.tappilot.agent.STOP_AUTOMATION"
        @Volatile private var active: AgentTaskService? = null
        fun cancelActive(reason: String = "任务已停止") { active?.cancel(reason) }
    }
    private val worker = Executors.newSingleThreadExecutor()
    private val owner = Any()
    private val main = Handler(Looper.getMainLooper())
    private var future: Future<*>? = null
    @Volatile private var runner: AgentRuntime? = null
    @Volatile private var cancelled = false
    private var events = emptyList<RunEvent>()
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "手机任务", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { cancel("任务已停止"); return START_NOT_STICKY }
            ACTION_EMERGENCY -> {
                cancel("已紧急停止")
                try { AgentAccessibilityService.latchEmergencyStop(this) }
                catch (error: AgentError) { TaskState.publish(TaskViewState(false, "急停保存失败", error.message, events)) }
                return START_NOT_STICKY
            }
            ACTION_START -> {
                if (future != null) return START_NOT_STICKY
                val notification = notification("任务准备中")
                if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
                else startForeground(NOTIFICATION, notification)
                if (!AutomationOwner.acquire(owner)) {
                    TaskState.publish(TaskViewState(false, "任务未启动", "请先断开电脑无线连接，再开始手机端任务。"))
                    stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY
                }
                active = this
                cancelled = false
                val task = intent.getStringExtra("task").orEmpty()
                TaskState.publish(TaskViewState(true, "正在切换到手机桌面"))
                future = worker.submit { execute(task) }
            }
            else -> stopSelf()
        }
        return START_NOT_STICKY
    }
    private fun execute(task: String) {
        try {
            val settings = SettingsStore(this).load() ?: throw AgentError("INVALID_CONFIG", "请先配置模型")
            val service = AgentAccessibilityService.instance ?: throw AgentError("SERVICE_UNAVAILABLE", "请先开启无障碍服务")
            val deadline = SystemClock.elapsedRealtime() + 4000
            while (true) {
                if (cancelled || Thread.currentThread().isInterrupted) throw AgentError("CANCELLED", "任务已停止")
                val current = service.dispatch("get_current_app", JSONObject())
                if (current.optString("packageName") != packageName) break
                if (SystemClock.elapsedRealtime() >= deadline) throw AgentError("PROTECTED_APP", "未能离开 TapPilot 控制页，请返回桌面后再试")
                service.dispatch("wait_for_ui_change", JSONObject().put("sinceRevision", current.getLong("revision")).put("timeoutMs", 500)) { !cancelled }
            }
            val loop = AgentRuntime(ModelClient(settings), PhoneExecutor { name, args, running ->
                service.dispatch(name, args) { !cancelled && running() }
            }, onEvent = { event ->
                if (!cancelled) {
                    events = (events + event).takeLast(128)
                    TaskState.publish(TaskViewState(true, event.label, events = events))
                    main.post { if (!cancelled) getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification(event.label)) }
                }
            })
            runner = loop
            if (cancelled) loop.cancel()
            val result = loop.run(task)
            if (!cancelled) TaskState.publish(TaskViewState(false, "任务结束", result, events))
        } catch (error: Exception) {
            if (!cancelled) TaskState.publish(TaskViewState(false, "任务已停止", if (error is AgentError) "${error.code}\n${error.message}" else "执行遇到问题，已停止。请检查网络与手机状态。", events))
        } finally {
            runner = null
            main.post { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
        }
    }
    private fun cancel(reason: String) {
        if (Looper.myLooper() != Looper.getMainLooper()) { main.post { cancel(reason) }; return }
        cancelled = true
        runner?.cancel()
        future?.cancel(true)
        TaskState.publish(TaskViewState(false, reason, "后续操作已取消。已交给 Android 的动作可能已经执行，请检查当前界面。", events))
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }
    private fun notification(status: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        fun action(value: String, id: Int) = PendingIntent.getService(this, id, Intent(this, AgentTaskService::class.java).setAction(value), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_compass).setContentTitle("TapPilot 正在运行")
            .setContentText(status).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(Notification.Action.Builder(null, "停止任务", action(ACTION_STOP, 1)).build())
            .addAction(Notification.Action.Builder(null, "紧急停止", action(ACTION_EMERGENCY, 2)).build()).build()
    }
    override fun onDestroy() {
        cancelled = true
        runner?.cancel()
        future?.cancel(true)
        worker.shutdownNow()
        AutomationOwner.release(owner)
        if (active === this) active = null
        if (TaskState.value.running) TaskState.publish(TaskViewState(false, "任务服务已结束", "任务没有自动恢复，请检查手机后重新开始。", events))
        super.onDestroy()
    }
}
