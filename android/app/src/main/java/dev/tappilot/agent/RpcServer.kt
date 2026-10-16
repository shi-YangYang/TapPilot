package dev.tappilot.agent

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.SystemClock
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal class AgentError(val code: String, override val message: String, val retryable: Boolean = false) : RuntimeException(message)

/** One bounded UTF-8 JSON request/response per ADB-forwarded Unix-socket connection. */
internal class RpcServer(private val service: AgentAccessibilityService) : AutoCloseable {
    private val server = LocalServerSocket("tappilot")
    private val clients = ConcurrentHashMap.newKeySet<LocalSocket>()
    private val workers = ThreadPoolExecutor(4, 4, 30, TimeUnit.SECONDS, ArrayBlockingQueue(8))
    @Volatile private var closed = false

    fun start() {
        Thread({
            while (!closed) {
                val socket = try { server.accept() } catch (_: Exception) { break }
                try {
                    // adbd is shell on production devices, root on certain development devices.
                    // Ordinary apps, including ones with INTERNET, are never accepted.
                    if (socket.peerCredentials.uid !in setOf(2000, 0)) { socket.close(); continue }
                    socket.soTimeout = 10_000
                    clients.add(socket)
                    workers.execute { handle(socket) }
                } catch (_: RejectedExecutionException) {
                    clients.remove(socket)
                    socket.close()
                } catch (_: Exception) {
                    clients.remove(socket)
                    runCatching { socket.close() }
                }
            }
        }, "tappilot-accept").apply { isDaemon = true; start() }
    }

    private fun handle(socket: LocalSocket) {
        val started = SystemClock.elapsedRealtime()
        var id: Any = JSONObject.NULL
        try {
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
            val result = service.dispatch(method, params) { !(method in ToolCatalog.actions || method == "act_and_observe") || !AutomationOwner.busy() }
            send(socket, JSONObject().put("id", id).put("ok", true).put("result", result), started)
        } catch (error: Exception) {
            val safe = if (error is AgentError) error else AgentError("INVALID_REQUEST", "Request could not be processed")
            runCatching {
                send(socket, JSONObject().put("id", id).put("ok", false).put("error", JSONObject()
                    .put("code", safe.code).put("message", safe.message).put("retryable", safe.retryable)), started)
            }
        } finally {
            clients.remove(socket)
            runCatching { socket.close() }
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

    override fun close() {
        closed = true
        runCatching { server.close() }
        clients.forEach { runCatching { it.close() } }
        clients.clear()
        workers.shutdownNow()
    }
}
