package com.habitat

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Storage boundary for the paired phone credential.
 *
 * The production implementation keeps the token encrypted with a non-exportable Android Keystore
 * key. The interface exists so the bridge can be exercised end to end on a JVM under Robolectric,
 * where the AndroidKeyStore provider is not available, without weakening the shipped build.
 */
interface CredentialStore {
    fun read(): String?
    fun write(token: String): Boolean
    fun clear()
}

class KeystoreCredentialStore(context: Context) : CredentialStore {
    companion object {
        const val PREFS = "habitat_ax_device_bridge"
        private const val KEY_ALIAS = "habitat_ax_device_bridge_v1"
        private const val TOKEN_KEY = "encrypted_token"
    }

    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override fun read(): String? {
        val packedText = prefs.getString(TOKEN_KEY, null) ?: return null
        return try {
            val packed = Base64.decode(packedText, Base64.NO_WRAP)
            if (packed.size <= 12) return null
            val iv = packed.copyOfRange(0, 12)
            val ciphertext = packed.copyOfRange(12, packed.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    override fun write(token: String): Boolean {
        val clean = token.trim()
        if (clean.length < 40 || clean.length > 512) return false
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val encrypted = cipher.doFinal(clean.toByteArray(Charsets.UTF_8))
            val packed = cipher.iv + encrypted
            prefs.edit()
                .putString(TOKEN_KEY, Base64.encodeToString(packed, Base64.NO_WRAP))
                .commit()
        } catch (_: Exception) {
            false
        }
    }

    override fun clear() {
        prefs.edit().remove(TOKEN_KEY).commit()
    }

    private fun getOrCreateKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }
}
