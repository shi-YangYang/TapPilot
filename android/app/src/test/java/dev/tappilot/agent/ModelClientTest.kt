package dev.tappilot.agent

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ModelClientTest {
    private fun withTls(block: (MockWebServer, OkHttpClient) -> Unit) {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverCerts = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        MockWebServer().use { server ->
            server.useHttps(serverCerts.sslSocketFactory(), false)
            server.start()
            val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager)
                .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).callTimeout(5, TimeUnit.SECONDS).build()
            block(server, client)
        }
    }
    @Test fun sendsCompatibleRequestAndReadsToolResponse() = withTls { server, http ->
        server.enqueue(MockResponse().setBody("{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"OK\"}}]}"))
        val gateway = ModelClient(ModelSettings(server.url("/v1").toString(), "fixture-token", "fixture-model"), http)
        assertTrue(gateway.testConnection().contains("连接成功"))
        val request = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("/v1/chat/completions", request.path)
        assertEquals("Bearer fixture-token", request.getHeader("Authorization"))
        assertEquals("fixture-model", JSONObject(request.body.readUtf8()).getString("model"))
    }
    @Test fun truncatedReplyAndWrongRoleAreRejected() = withTls { server, http ->
        for ((body, expected) in listOf(
            "{\"choices\":[{\"finish_reason\":\"length\",\"message\":{\"role\":\"assistant\",\"content\":\"partial\"}}]}" to "MODEL_TRUNCATED",
            "{\"choices\":[{\"message\":{\"role\":\"user\",\"content\":\"bad role\"}}]}" to "MODEL_RESPONSE")) {
            server.enqueue(MockResponse().setBody(body))
            try { ModelClient(ModelSettings(server.url("/v1").toString(), "", "fixture"), http).testConnection(); fail("unsafe response accepted") }
            catch (error: AgentError) { assertEquals(expected, error.code) }
        }
    }
    @Test fun requestBudgetStopsBeforeNetwork() = withTls { server, http ->
        val gateway = ModelClient(ModelSettings(server.url("/v1").toString(), "", "fixture"), http)
        try { gateway.complete(JSONArray().put(JSONObject().put("role", "user").put("content", "x".repeat(262_144))), JSONArray()); fail("oversize request accepted") }
        catch (error: AgentError) { assertEquals("CONTEXT_LIMIT", error.code) }
        assertEquals(0, server.requestCount)
    }
    @Test fun redirectIsNotFollowed() = withTls { server, http ->
        server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", server.url("/untrusted")))
        val gateway = ModelClient(ModelSettings(server.url("/v1").toString(), "fixture-token", "fixture-model"), http)
        try { gateway.testConnection(); fail("redirect followed") } catch (error: AgentError) { assertEquals("MODEL_HTTP_302", error.code) }
        assertEquals(1, server.requestCount)
    }
    @Test fun cancellationAbortsInFlightModelRequest() = withTls { server, http ->
        server.enqueue(MockResponse().setBody("{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"OK\"}}]}").setBodyDelay(3, TimeUnit.SECONDS))
        val gateway = ModelClient(ModelSettings(server.url("/v1").toString(), "fixture-token", "fixture-model"), http)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val future = executor.submit<String> {
                try { gateway.complete(JSONArray(), JSONArray()); "unexpected" } catch (error: AgentError) { error.code }
            }
            assertNotNull(server.takeRequest(1, TimeUnit.SECONDS))
            gateway.cancel()
            assertEquals("CANCELLED", future.get(2, TimeUnit.SECONDS))
        } finally { executor.shutdownNow() }
    }
}
