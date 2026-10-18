package dev.tappilot.agent

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal class AgentError(val code: String, override val message: String, val retryable: Boolean = false, val reason: String? = null) : RuntimeException(message) {
    // Set only by the native node command before any mutation API is called.
    internal var nativeNotSent = false
    internal var nativeObservation: JSONObject? = null
    internal var nativeContextChange: NodeActionGuard.ContextChange? = null
    // A policy comparison alone does not prove where dispatch occurred. Only
    // visualGesture's direct pre-dispatch comparison catch sets visualNotSentComparison.
    internal var visualComparison: VisualTapPolicy.SceneComparison? = null
    internal var visualNotSentComparison: VisualTapPolicy.NotSentComparison? = null
    fun toJson(): JSONObject = JSONObject().put("code", code).put("message", message.take(2048)).put("retryable", retryable).also {
        val screenshotReason = ScreenshotErrorReason.allowed(code, reason)
        if (screenshotReason != null) {
            it.put("details", JSONObject().put("reason", screenshotReason))
        } else if (nativeNotSent) {
            val details = JSONObject().put("executor", NodeActionGuard.EXECUTOR).put("dispatchState", "not_sent")
            if (reason != null && reason in nativeReasons) details.put("reason", reason)
            if (code == "TARGET_CHANGED" && reason == "PAGE_CONTEXT_CHANGED") nativeContextChange?.let { evidence -> details.put("contextChange", evidence.toJson()) }
            it.put("details", details)
        } else if (code == "VISUAL_SCENE_CHANGED" && visualNotSentComparison != null) {
            it.put("details", JSONObject().put("executor", VisualTapPolicy.CONTRACT).put("dispatchState", "not_sent")
                .put("visualComparison", visualNotSentComparison!!.toJson()))
        } else if (code == "STALE_SNAPSHOT" && SnapshotStaleReason.entries.any { entry -> entry.name == reason }) {
            it.put("details", JSONObject().put("reason", reason))
        }
    }
    companion object {
        private val nativeReasons = SnapshotStaleReason.entries.map { it.name }.toSet() + setOf("TREE_INCOMPLETE", "SESSION_CHANGED", "WINDOW_CHANGED", "TARGET_IDENTITY_CHANGED", "TARGET_AMBIGUOUS", "PAGE_CONTEXT_CHANGED", "INVALID_HIERARCHY", "TARGET_DISABLED", "TARGET_HIDDEN", "SENSITIVE_TARGET", "NO_CLICKABLE_TARGET", "HIDDEN_ANCESTOR", "INVALID_BOUNDS", "TARGET_CLIPPED", "AMBIGUOUS_TOUCH_TARGET", "TOUCH_TARGET_MISMATCH", "WINDOW_OBSCURED", "OBSERVATION_SETTLING")
    }
}

/** One bounded UTF-8 JSON request/response per ADB-forwarded Unix-socket connection. */
internal class RpcServer(
    private val service: AgentAccessibilityService,
    private val socketName: String = "tappilot",
    private val onFailure: (RpcServer, String) -> Unit = { _, _ -> },
) : AutoCloseable {
    private val server = LocalServerSocket(socketName)
    private val clients = ConcurrentHashMap.newKeySet<LocalSocket>()
    private val workers = ThreadPoolExecutor(4, 4, 30, TimeUnit.SECONDS, ArrayBlockingQueue(8))
    private val lifecycle = Any()
    private val closeFinished = CountDownLatch(1)
    @Volatile private var closed = false
    private var started = false
    private val acceptThread = Thread({ acceptConnections() }, "$socketName-accept").apply { isDaemon = true }

    fun start() {
        synchronized(lifecycle) {
            check(!closed) { "RPC server is closed" }
            if (started) return
            started = true
            acceptThread.start()
        }
    }

    private fun acceptConnections() {
        try {
            while (!closed) {
                val socket = try { server.accept() } catch (error: Exception) {
                    if (!closed) {
                        Log.w("TapPilot.Rpc", "RPC_ACCEPT_FAILED", error)
                        runCatching { onFailure(this, "RPC_ACCEPT_FAILED") }
                    }
                    break
                }
                if (closed) { closeSocket(socket); break }
                try {
                    // adbd is shell on production devices, root on certain development devices.
                    // Ordinary apps, including ones with INTERNET, are never accepted.
                    if (socket.peerCredentials.uid !in setOf(2000, 0)) { closeSocket(socket); continue }
                    socket.soTimeout = 10_000
                    clients.add(socket)
                    // close() can run between accept() and insertion into the client set.
                    if (closed) { clients.remove(socket); closeSocket(socket); break }
                    workers.execute { handle(socket) }
                } catch (_: RejectedExecutionException) {
                    clients.remove(socket)
                    closeSocket(socket)
                } catch (_: Exception) {
                    clients.remove(socket)
                    closeSocket(socket)
                }
            }
        } finally {
            // An unexpected listener failure must not leave a bound but unserved socket.
            if (!closed) close()
        }
    }

    private fun handle(socket: LocalSocket) {
        val started = SystemClock.elapsedRealtime()
        var id: Any = JSONObject.NULL
        try {
            if (closed) return
            val request = JSONObject(readLine(socket))
            id = request.opt("id") ?: JSONObject.NULL
            if (id !is String || id.length > 128 || id.isBlank()) throw AgentError("INVALID_REQUEST", "id must be a non-empty string of at most 128 characters")
            val method = request.opt("method") as? String ?: throw AgentError("INVALID_REQUEST", "method must be a string")
            val params = when (val value = request.opt("params")) {
                null -> JSONObject()
                is JSONObject -> value
                else -> throw AgentError("INVALID_REQUEST", "params must be an object")
            }
            if (AutomationOwner.busy() && (method in ToolCatalog.actions || method == "act_and_observe"))
                throw AgentError("BUSY", "A wireless session owns automation. Disconnect it before using ADB actions.", true)
            val result = service.dispatch(method, params) {
                !closed && (!(method in ToolCatalog.actions || method == "act_and_observe") || !AutomationOwner.busy())
            }
            send(socket, JSONObject().put("id", id).put("ok", true).put("result", result), started)
        } catch (error: Exception) {
            val safe = if (error is AgentError) error else AgentError("INVALID_REQUEST", "Request could not be processed")
            runCatching {
                val reply = JSONObject().put("id", id).put("ok", false).put("error", safe.toJson())
                safe.nativeObservation?.let { reply.put("observation", it) }
                send(socket, reply, started)
            }
        } finally {
            clients.remove(socket)
            closeSocket(socket)
        }
    }

    private fun readLine(socket: LocalSocket): String {
        val output = ByteArrayOutputStream()
        val input = socket.inputStream
        val deadline = SystemClock.elapsedRealtime() + 10_000
        while (output.size() <= 262_144) {
            if (SystemClock.elapsedRealtime() >= deadline) throw AgentError("REQUEST_TIMEOUT", "Request read timed out", true)
            val next = input.read()
            if (next == -1) throw AgentError("INVALID_REQUEST", "Expected newline-terminated JSON")
            if (next == 10) return output.toString(Charsets.UTF_8.name())
            output.write(next)
        }
        throw AgentError("REQUEST_TOO_LARGE", "Request exceeds 256 KiB")
    }

    private fun send(socket: LocalSocket, response: JSONObject, started: Long) {
        response.put("meta", JSONObject().put("durationMs", SystemClock.elapsedRealtime() - started))
        socket.outputStream.write((response.toString() + "\n").toByteArray(Charsets.UTF_8))
        socket.outputStream.flush()
    }

    private fun closeSocket(socket: LocalSocket) {
        // LocalSocket.close() alone does not reliably wake a native blocking read on another thread.
        runCatching { Os.shutdown(socket.fileDescriptor, OsConstants.SHUT_RDWR) }
        runCatching { socket.close() }
    }

    override fun close() {
        val ownsClose = synchronized(lifecycle) {
            if (closed) false else { closed = true; true }
        }
        if (!ownsClose) {
            // The accept thread must not wait for the caller that is joining it.
            if (Thread.currentThread() !== acceptThread) try { closeFinished.await(1, TimeUnit.SECONDS) }
            catch (_: InterruptedException) { Thread.currentThread().interrupt() }
            return
        }
        try {
            // Linux accept() retains the listening socket while blocked. Wake it before close so
            // the abstract namespace is released before a reconnect binds the same name.
            runCatching { Os.shutdown(server.fileDescriptor, OsConstants.SHUT_RDWR) }
            runCatching { server.close() }
            clients.forEach(::closeSocket)
            clients.clear()
            workers.shutdownNow()
            if (started && Thread.currentThread() !== acceptThread) {
                try { acceptThread.join(1_000) }
                catch (_: InterruptedException) { Thread.currentThread().interrupt() }
                if (acceptThread.isAlive) {
                    Log.w("TapPilot.Rpc", "RPC_ACCEPT_STOP_TIMEOUT")
                    runCatching { onFailure(this, "RPC_ACCEPT_STOP_TIMEOUT") }
                }
            }
        } finally { closeFinished.countDown() }
    }
}
