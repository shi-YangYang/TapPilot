package dev.tappilot.agent

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** One ephemeral, authenticated connection. It never reconnects or replays commands by itself. */
internal class WirelessConnection(private val pairing: PairingInfo, private val deviceId: String, private val deviceName: String,
    private val execute: PhoneExecutor, private val latchEmergency: () -> Unit, private val onState: (Boolean, String) -> Unit) : AutoCloseable {
    private val live = AtomicBoolean(true)
    private val ready = AtomicBoolean(false)
    private val started = AtomicBoolean(false)
    private val mutationBusy = AtomicBoolean(false)
    private val seen = ConcurrentHashMap.newKeySet<String>()
    private val workers = ThreadPoolExecutor(3, 3, 30, TimeUnit.SECONDS, ArrayBlockingQueue(8))
    private val emergency = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, ArrayBlockingQueue(1))
    private val timer = Executors.newSingleThreadScheduledExecutor()
    private val trust = PairedTrustManager(pairing.fingerprint)
    private val http = OkHttpClient.Builder().sslSocketFactory(trust.context().socketFactory, trust)
        .hostnameVerifier { hostname, session ->
            // TLS already checked the DER pin. Check again here and restrict the requested hostname.
            hostname == pairing.host && runCatching {
                trust.checkServerTrusted(arrayOf(session.peerCertificates[0] as java.security.cert.X509Certificate), "RSA"); true
            }.getOrDefault(false)
        }.connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).writeTimeout(10, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()
    @Volatile private var socket: WebSocket? = null

    fun isConnected(): Boolean = live.get() && ready.get()

    fun start() {
        if (!started.compareAndSet(false, true) || !live.get()) return
        timer.schedule({ if (!ready.get()) finish("握手超时，请确认电脑配对仍有效后手动重连") }, 12, TimeUnit.SECONDS)
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                socket = webSocket
                if (!live.get()) { webSocket.cancel(); return }
                // The TLS pin has been verified before this callback; never send the token earlier.
                val hello = JSONObject().put("type", "hello").put("version", 1).put("token", pairing.token)
                    .put("deviceId", deviceId).put("deviceName", deviceName)
                if (!webSocket.send(hello.toString())) finish("无线握手发送失败")
            }
            override fun onMessage(webSocket: WebSocket, text: String) { receive(text) }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { finish("拒绝非文本无线消息") }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { finish("电脑已断开连接；未自动重放操作") }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { finish("无线连接已关闭") }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { finish("无线连接失败：请检查同一 Wi-Fi、配对有效期和证书；未自动重试") }
        }
        val ws = http.newWebSocket(Request.Builder().url(pairing.socketUrl).build(), listener)
        socket = ws
        if (!live.get()) ws.cancel()
    }
    private fun receive(text: String) {
        if (!live.get()) return
        val bytes = text.toByteArray(Charsets.UTF_8).size
        if (bytes > 4 * 1024 * 1024) { finish("无线消息超过大小限制"); return }
        val value = try { JSONObject(text) } catch (_: Exception) { finish("收到无效无线消息，连接已关闭"); return }
        if (!ready.get()) {
            if (value.keys().asSequence().toSet() != setOf("type", "version") || value.optString("type") != "ready" || value.opt("version") != 1) {
                finish("无线握手格式错误，连接已关闭"); return
            }
            ready.set(true); timer.shutdownNow(); notifyState(true, "已安全连接 ${pairing.host}:${pairing.port}")
            return
        }
        if (bytes > 262_144 || value.keys().asSequence().toSet() != setOf("id", "method", "params")) { finish("无线请求超过限制或格式无效"); return }
        val id = value.opt("id") as? String
        val method = value.opt("method") as? String
        val args = value.opt("params") as? JSONObject
        if (id == null || id.isBlank() || id.length > 128 || method == null || args == null || seen.size >= 2048 || !seen.add(id)) {
            finish("无线请求编号或格式无效，请重新连接"); return
        }
        val received = now()
        try { ToolCatalog.validateRpc(method, args) }
        catch (error: AgentError) { respond(id, null, error, received); return }
        val isEmergency = method == "emergency_stop"
        if (isEmergency) {
            // This callback is deliberately outside the cancellable queues and live-session guard.
            // Authentication (ready) and exact request/schema validation have already succeeded.
            try { latchEmergency() }
            catch (_: Exception) { respond(id, null, AgentError("STOP_PERSISTENCE_FAILED", "当前急停状态未能持久化，请在手机上确认，暂勿重启服务"), received); return }
        }
        val mutation = method == "act_and_observe" || method in ToolCatalog.actions
        if (mutation && !mutationBusy.compareAndSet(false, true)) { respond(id, null, AgentError("BUSY", "另一动作尚未完成；未排队或重试", true), received); return }
        val executor = if (isEmergency) emergency else workers
        try {
            executor.execute {
                try {
                    if (!live.get() || !ready.get()) return@execute
                    if (!isEmergency && now() - received > 2000) throw AgentError("COMMAND_TIMEOUT", "请求排队超时，未执行；请读取手机状态", false)
                    val deadline = now() + if (method == "wait_for_ui_change") args.optLong("timeoutMs", 10000) + 8000 else 10000
                    val result = execute.execute(method, args) { live.get() && ready.get() && now() < deadline && !Thread.currentThread().isInterrupted }
                    respond(id, result, null, received)
                } catch (error: Exception) {
                    respond(id, null, if (error is AgentError) error else AgentError("ANDROID_ERROR", "手机未完成此请求，请检查当前界面"), received)
                } finally { if (mutation) mutationBusy.set(false) }
            }
        } catch (_: RejectedExecutionException) {
            if (mutation) mutationBusy.set(false)
            respond(id, null, AgentError("BUSY", "手机请求队列已满；未执行或重试", true), received)
        }
    }
    private fun respond(id: String, result: JSONObject?, error: AgentError?, startedAt: Long) {
        if (!live.get() || !ready.get()) return
        val reply = JSONObject().put("id", id).put("ok", error == null).put("meta", JSONObject().put("durationMs", now() - startedAt))
        if (error == null) reply.put("result", result ?: JSONObject.NULL)
        else reply.put("error", JSONObject().put("code", error.code).put("message", error.message.take(2048)).put("retryable", error.retryable))
        val encoded = reply.toString()
        if (encoded.toByteArray().size > 4 * 1024 * 1024 || (socket?.queueSize() ?: 0) > 4 * 1024 * 1024 || socket?.send(encoded) != true)
            finish("无线发送失败或队列超过限制，连接已关闭")
    }
    private fun notifyState(connected: Boolean, message: String) { runCatching { onState(connected, message) } }
    private fun now() = System.nanoTime() / 1_000_000
    private fun finish(message: String) {
        if (!live.compareAndSet(true, false)) return
        ready.set(false)
        socket?.cancel()
        workers.shutdownNow(); emergency.shutdownNow(); timer.shutdownNow()
        http.dispatcher.executorService.shutdown(); http.connectionPool.evictAll()
        notifyState(false, message)
    }
    override fun close() { finish("已断开无线连接；后续操作已取消") }
}
