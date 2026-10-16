package dev.tappilot.agent

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import javax.crypto.KeyGenerator

@RunWith(AndroidJUnit4::class)
class LegacyModelCleanupInstrumentedTest {
    @Test fun removesOnlyRetiredSettingsAndKeyWithoutDecrypting() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val namespace = "fixture_retired_model"
        val alias = "tappilot.$namespace.v1"
        val unrelated = context.getSharedPreferences("fixture_appearance", Context.MODE_PRIVATE)
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        try {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            }.generateKey()
            assertTrue(context.getSharedPreferences(namespace, Context.MODE_PRIVATE)
                .edit().putString("sealed", "synthetic-unreadable-retired-config").commit())
            assertTrue(unrelated.edit().putBoolean("dark_theme", false).commit())
            LegacyModelSettings.remove(context, namespace)
            assertTrue(context.getSharedPreferences(namespace, Context.MODE_PRIVATE).all.isEmpty())
            assertFalse(store.containsAlias(alias))
            assertFalse(unrelated.getBoolean("dark_theme", true))
            LegacyModelSettings.remove(context, namespace)
        } finally {
            context.deleteSharedPreferences(namespace)
            context.deleteSharedPreferences("fixture_appearance")
            store.deleteEntry(alias)
        }
    }
}
