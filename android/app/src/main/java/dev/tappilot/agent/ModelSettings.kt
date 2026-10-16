package dev.tappilot.agent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.URI
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class ModelSettings(val baseUrl: String, val apiKey: String, val model: String) {
    fun endpoint(): String {
        val uri = try { URI(baseUrl.trim()) } catch (_: Exception) { throw AgentError("INVALID_CONFIG", "请输入有效的 HTTPS API 地址") }
        if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null)
            throw AgentError("INVALID_CONFIG", "API 地址须为 HTTPS，不能包含用户名、查询参数或片段")
        if (apiKey.length > 8192 || apiKey.any { it == '\r' || it == '\n' } || model.isBlank() || model.length > 256)
            throw AgentError("INVALID_CONFIG", "请检查模型名称和 API Key 格式")
        val base = baseUrl.trim().trimEnd('/')
        return if (base.endsWith("/chat/completions")) base else "$base/chat/completions"
    }
}

/** Only encrypted settings persist. Task text, UI trees and model replies stay in memory. */
internal class SettingsStore(context: Context, namespace: String = "model_settings") {
    private val preferences = context.getSharedPreferences(namespace, Context.MODE_PRIVATE)
    private val alias = "tappilot.$namespace.v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    fun load(): ModelSettings? {
        val stored = preferences.getString("sealed", null) ?: return null
        try {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            require(bytes.size > 28)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            val value = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
            return ModelSettings(value.getString("baseUrl"), value.getString("apiKey"), value.getString("model"))
        } catch (_: Exception) { throw AgentError("CONFIG_UNAVAILABLE", "无法解密模型配置，请重新填写并保存") }
    }
    fun save(settings: ModelSettings) {
        settings.endpoint()
        try {
            val bytes = JSONObject().put("baseUrl", settings.baseUrl.trim()).put("apiKey", settings.apiKey).put("model", settings.model.trim()).toString().toByteArray()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val sealed = Base64.encodeToString(cipher.iv + cipher.doFinal(bytes), Base64.NO_WRAP)
            if (!preferences.edit().putString("sealed", sealed).commit()) throw IllegalStateException()
        } catch (_: Exception) { throw AgentError("CONFIG_SAVE_FAILED", "配置未保存，请检查手机存储和安全设置") }
    }
    fun clear() { preferences.edit().clear().commit() }
}
