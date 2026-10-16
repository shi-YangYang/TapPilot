package dev.tappilot.agent

import android.content.Context
import java.security.KeyStore

/** v0.3.7 retires phone-side model configuration without reading its old credentials. */
internal object LegacyModelSettings {
    fun remove(context: Context, namespace: String = "model_settings") {
        val cleared = context.deleteSharedPreferences(namespace)
        val keyRemoved = runCatching {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                .deleteEntry("tappilot.$namespace.v1")
        }.isSuccess
        if (!cleared || !keyRemoved) throw AgentError("LEGACY_CONFIG_CLEANUP_FAILED", "旧模型配置清理失败，请重新打开 TapPilot 重试")
    }
}
