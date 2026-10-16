package dev.tappilot.agent

import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class WirelessConnectionTest {
    private fun fixture(block: (MockWebServer, PairingInfo) -> Unit) {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("127.0.0.1").build()
        val serverCerts = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val pin = MessageDigest.getInstance("SHA-256").digest(certificate.certificate.encoded).joinToString("") { "%02x".format(it) }
        MockWebServer().use { server ->
            server.useHttps(serverCerts.sslSocketFactory(), false); server.start()
            block(server, PairingInfo("127.0.0.1", server.port, pin, "t".repeat(43)))
        }
    }
    private fun listener(socket: AtomicReference<WebSocket>, replies: LinkedBlockingQueue<JSONObject>, hello: CountDownLatch) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) { socket.set(webSocket) }
        override fun onMessage(webSocket: WebSocket, text: String) {
            val value = JSONObject(text)
            if (value.optString("type") == "hello") {
                assertEquals("t".repeat(43), value.getString("token"))
                webSocket.send("{\"type\":\"ready\",\"version\":1}"); hello.countDown()
            } else replies.put(value)
        }
    }
    private fun request(id: String, method: String, args: JSONObject = JSONObject()) = JSONObject().put("id", id).put("method", method).put("params", args).toString()
    @Test fun pinnedWssHandshakeAndRpcUseStrictEnvelope() = fixture { server, pair ->
        val socket = AtomicReference<WebSocket>(); val replies = LinkedBlockingQueue<JSONObject>(); val hello = CountDownLatch(1); val ready = CountDownLatch(1)
        server.enqueue(MockResponse().withWebSocketUpgrade(listener(socket, replies, hello)))
        val count = AtomicInteger()
        WirelessConnection(pair, "fixture", "Test Android", PhoneExecutor { _, _, running -> assertTrue(running()); count.incrementAndGet(); JSONObject().put("value", "fixture") }, {}) { connected, _ -> if (connected) ready.countDown() }.use { connection ->
            connection.start(); assertTrue(ready.await(4, TimeUnit.SECONDS)); assertTrue(hello.await(1, TimeUnit.SECONDS))
            socket.get().send(request("read", "get_ui_tree"))
            val response = replies.poll(3, TimeUnit.SECONDS)!!
            assertEquals("read", response.getString("id")); assertTrue(response.getBoolean("ok")); assertTrue(response.getJSONObject("meta").getLong("durationMs") >= 0)
            assertEquals(1, count.get())
        }
    }
    @Test fun wrongPinNeverSendsPairingToken() = fixture { server, pair ->
        val opened = AtomicInteger(); val closed = CountDownLatch(1)
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { opened.incrementAndGet() }
        }))
        WirelessConnection(pair.copy(fingerprint = "0".repeat(64)), "fixture", "Test", PhoneExecutor { _, _, _ -> fail("request executed"); JSONObject() }, {}) { connected, _ -> if (!connected) closed.countDown() }.use { connection ->
            connection.start(); assertTrue(closed.await(4, TimeUnit.SECONDS)); assertEquals(0, opened.get()); assertEquals(0, server.requestCount)
        }
    }
    @Test fun invalidArgumentsDoNotReachExecutor() = fixture { server, pair ->
        val socket = AtomicReference<WebSocket>(); val replies = LinkedBlockingQueue<JSONObject>(); val hello = CountDownLatch(1); val ready = CountDownLatch(1)
        server.enqueue(MockResponse().withWebSocketUpgrade(listener(socket, replies, hello)))
        val count = AtomicInteger(); val latched = AtomicInteger()
        WirelessConnection(pair, "fixture", "Test", PhoneExecutor { _, _, _ -> count.incrementAndGet(); JSONObject() }, { latched.incrementAndGet() }) { connected, _ -> if (connected) ready.countDown() }.use { connection ->
            connection.start(); assertTrue(ready.await(4, TimeUnit.SECONDS))
            socket.get().send(request("bad", "act_and_observe", JSONObject().put("action", "click_element").put("arguments", JSONObject().put("snapshotId", "x").put("nodeId", "n").put("approved", true))))
            assertEquals("INVALID_ARGUMENT", replies.poll(3, TimeUnit.SECONDS)!!.getJSONObject("error").getString("code"))
            socket.get().send(request("shell", "shell"))
            assertEquals("UNKNOWN_TOOL", replies.poll(3, TimeUnit.SECONDS)!!.getJSONObject("error").getString("code"))
            socket.get().send(request("invalid-stop", "emergency_stop", JSONObject().put("approved", true)))
            assertEquals("INVALID_ARGUMENT", replies.poll(3, TimeUnit.SECONDS)!!.getJSONObject("error").getString("code"))
            assertEquals(0, count.get()); assertEquals(0, latched.get())
        }
    }
    @Test fun authenticatedEmergencyLatchesBeforeImmediateDisconnect() = fixture { server, pair ->
        val socket = AtomicReference<WebSocket>(); val replies = LinkedBlockingQueue<JSONObject>(); val hello = CountDownLatch(1); val ready = CountDownLatch(1)
        val stopped = AtomicBoolean(false); val latched = CountDownLatch(1); val dispatched = AtomicInteger()
        server.enqueue(MockResponse().withWebSocketUpgrade(listener(socket, replies, hello)))
        lateinit var connection: WirelessConnection
        connection = WirelessConnection(pair, "fixture", "Test", PhoneExecutor { _, _, _ -> dispatched.incrementAndGet(); JSONObject() }, {
            stopped.set(true) // Synthetic durable state, written by the mandatory production latch callback.
            connection.close() // Disconnect at the earliest boundary, before an emergency worker can run.
            latched.countDown()
        }) { connected, _ -> if (connected) ready.countDown() }
        connection.use {
            connection.start(); assertTrue(ready.await(4, TimeUnit.SECONDS))
            socket.get().send(request("stop-and-disconnect", "emergency_stop"))
            assertTrue(latched.await(3, TimeUnit.SECONDS)); assertTrue(stopped.get()); assertFalse(connection.isConnected())
            assertEquals(0, dispatched.get())
        }
    }
    @Test fun emergencyBeforeReadyCannotLatch() = fixture { server, pair ->
        val closed = CountDownLatch(1); val latched = AtomicInteger()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (JSONObject(text).optString("type") == "hello") webSocket.send(request("premature", "emergency_stop"))
            }
        }))
        WirelessConnection(pair, "fixture", "Test", PhoneExecutor { _, _, _ -> fail("unready request executed"); JSONObject() }, { latched.incrementAndGet() }) { connected, _ -> if (!connected) closed.countDown() }.use { connection ->
            connection.start(); assertTrue(closed.await(4, TimeUnit.SECONDS)); assertEquals(0, latched.get())
        }
    }
    @Test fun emergencyHasSeparateWorkerAndDisconnectDropsQueuedMutation() = fixture { server, pair ->
        val socket = AtomicReference<WebSocket>(); val replies = LinkedBlockingQueue<JSONObject>(); val hello = CountDownLatch(1); val ready = CountDownLatch(1)
        val readersStarted = CountDownLatch(3); val readersEnded = CountDownLatch(3); val block = CountDownLatch(1); val mutations = AtomicInteger()
        server.enqueue(MockResponse().withWebSocketUpgrade(listener(socket, replies, hello)))
        WirelessConnection(pair, "fixture", "Test", PhoneExecutor { method, _, running ->
            when (method) {
                "get_ui_tree" -> {
                    readersStarted.countDown()
                    try { block.await(5, TimeUnit.SECONDS) } catch (_: InterruptedException) {} finally { readersEnded.countDown() }
                    if (!running()) throw AgentError("CANCELLED", "fixture cancelled")
                    JSONObject()
                }
                "emergency_stop" -> JSONObject().put("stopped", true)
                else -> { mutations.incrementAndGet(); JSONObject() }
            }
        }, {}) { connected, _ -> if (connected) ready.countDown() }.use { connection ->
            connection.start(); assertTrue(ready.await(4, TimeUnit.SECONDS))
            repeat(3) { socket.get().send(request("read$it", "get_ui_tree")) }
            assertTrue(readersStarted.await(3, TimeUnit.SECONDS))
            socket.get().send(request("queued", "open_settings"))
            socket.get().send(request("stop", "emergency_stop"))
            val stop = replies.poll(3, TimeUnit.SECONDS)!!
            assertEquals("stop", stop.getString("id")); assertTrue(stop.getJSONObject("result").getBoolean("stopped"))
            connection.close()
            assertTrue(readersEnded.await(3, TimeUnit.SECONDS))
            assertEquals(0, mutations.get())
        }
    }
}
