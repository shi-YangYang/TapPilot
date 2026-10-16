package dev.tappilot.agent

import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal interface ModelGateway {
    fun complete(messages: JSONArray, tools: JSONArray): JSONObject
    fun cancel()
}

/** OpenAI-compatible Chat Completions adapter. Never follows redirects with a user credential. */
internal class ModelClient(private val settings: ModelSettings, private val client: OkHttpClient = defaultClient) : ModelGateway {
    companion object {
        private val defaultClient = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(90, TimeUnit.SECONDS).callTimeout(100, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()
    }
    private val cancelled = AtomicBoolean(false)
    @Volatile private var active: Call? = null
    override fun cancel() { cancelled.set(true); active?.cancel() }
    override fun complete(messages: JSONArray, tools: JSONArray): JSONObject {
        if (cancelled.get()) throw AgentError("CANCELLED", "任务已停止")
        val body = JSONObject().put("model", settings.model).put("messages", messages).put("stream", false).put("max_tokens", 2048)
        if (tools.length() > 0) body.put("tools", tools).put("tool_choice", "auto").put("parallel_tool_calls", false)
        val encoded = body.toString()
        if (encoded.toByteArray(Charsets.UTF_8).size > 262_144) throw AgentError("CONTEXT_LIMIT", "模型请求超过 256 KiB，已停止；请缩小任务或当前界面内容")
        val request = Request.Builder().url(settings.endpoint()).post(encoded.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .header("Accept", "application/json")
        if (settings.apiKey.isNotBlank()) request.header("Authorization", "Bearer ${settings.apiKey}")
        val call = client.newCall(request.build())
        active = call
        try {
            if (cancelled.get()) { call.cancel(); throw AgentError("CANCELLED", "任务已停止") }
            call.execute().use { response ->
                if (!response.isSuccessful) throw AgentError("MODEL_HTTP_${response.code}", "模型服务返回 HTTP ${response.code}；请检查 API 地址、模型、额度或 Key。未自动重试。")
                val source = response.body?.source() ?: throw AgentError("MODEL_RESPONSE", "模型响应为空")
                if (source.request(512L * 1024 + 1)) throw AgentError("MODEL_RESPONSE", "模型响应超过 512 KiB 限制")
                val json = try { JSONObject(source.readUtf8()) } catch (_: Exception) { throw AgentError("MODEL_RESPONSE", "模型未返回有效 JSON") }
                val choice = json.optJSONArray("choices")?.optJSONObject(0)
                    ?: throw AgentError("MODEL_RESPONSE", "接口未返回 Chat Completions choice")
                if (choice.optString("finish_reason") == "length") throw AgentError("MODEL_TRUNCATED", "模型响应达到输出限制，未执行其中的工具动作")
                val message = choice.optJSONObject("message")
                    ?: throw AgentError("MODEL_RESPONSE", "接口未返回 Chat Completions message；请使用支持工具调用的兼容接口")
                if (message.optString("role") != "assistant") throw AgentError("MODEL_RESPONSE", "模型响应角色必须为 assistant")
                if (cancelled.get()) throw AgentError("CANCELLED", "任务已停止")
                return message
            }
        } catch (e: AgentError) { throw e }
        catch (_: Exception) { throw AgentError(if (cancelled.get()) "CANCELLED" else "MODEL_NETWORK", if (cancelled.get()) "任务已停止" else "模型请求失败或超时；请检查网络及 HTTPS 证书。未自动重试。") }
        finally { active = null }
    }
    fun testConnection(): String {
        val result = complete(JSONArray().put(JSONObject().put("role", "user").put("content", "Reply with OK only. Do not call tools.")), JSONArray())
        if (result.optString("content").isBlank()) throw AgentError("MODEL_RESPONSE", "连接成功，但没有收到文本响应")
        return "连接成功 · 文本响应正常；工具调用将在任务中验证"
    }
}
