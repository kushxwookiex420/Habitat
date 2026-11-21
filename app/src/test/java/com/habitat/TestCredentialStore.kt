package com.habitat

/**
 * In-memory CredentialStore for JVM/Robolectric tests.
 *
 * Robolectric has no AndroidKeyStore provider, so the shipped KeystoreCredentialStore cannot run
 * there. Only tests use this type; the installed app always uses KeystoreCredentialStore.
 */
class InMemoryCredentialStore(private var token: String? = null) : CredentialStore {
    override fun read(): String? = token

    override fun write(token: String): Boolean {
        if (token.trim().length < 40) return false
        this.token = token.trim()
        return true
    }

    override fun clear() {
        token = null
    }
}
