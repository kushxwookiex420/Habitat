package com.habitat

import java.net.URI

/**
 * Decides which backend a build may talk to.
 *
 * Revision 4.3 let any build point at any URL through -PhabitatBaseUrl, so a nonproduction APK
 * could silently be compiled against the production service. Every Android request now passes this
 * policy, and a nonproduction build refuses the production host at compile time (Gradle), at bridge
 * construction, and again when an endpoint is changed at runtime.
 */
object HabitatEndpointPolicy {
    const val PRODUCTION = "production"
    const val NONPRODUCTION = "nonproduction"

    const val PRODUCTION_HOST = "habitat-1-szzd.onrender.com"

    private val productionHosts = setOf(PRODUCTION_HOST)

    /** Parse an absolute http(s) URL without credentials, query, or fragment. */
    fun parse(raw: String?): URI? {
        val clean = raw?.trim().orEmpty()
        if (clean.isEmpty() || clean.any { it.isWhitespace() }) return null
        val uri = try {
            URI(clean)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (uri.host.isNullOrBlank()) return null
        if (uri.userInfo != null) return null
        if (uri.query != null || uri.fragment != null) return null
        if (uri.port != -1 && uri.port !in 1..65535) return null
        return uri
    }

    fun isProductionHost(host: String?): Boolean {
        val clean = host?.trim()?.trimEnd('.')?.lowercase() ?: return false
        return productionHosts.any { clean == it || clean.endsWith(".$it") }
    }

    fun isProductionEndpoint(url: String?): Boolean = isProductionHost(parse(url)?.host)

    /** Emulator host plus local loopback; the only cleartext targets a build may accept. */
    fun isLoopbackHost(host: String?): Boolean {
        val clean = host?.trim()?.trimEnd('.')?.lowercase() ?: return false
        return clean == "localhost" ||
            clean == "127.0.0.1" ||
            clean == "10.0.2.2" ||
            clean == "[::1]" ||
            clean == "::1"
    }

    /** Returns a human-readable refusal, or null when the endpoint is acceptable. */
    fun validate(url: String?, environment: String): String? {
        val uri = parse(url) ?: return "Backend endpoint is missing or is not a valid http(s) URL."
        val scheme = uri.scheme.lowercase()
        val host = uri.host.orEmpty()
        if (environment.trim().equals(NONPRODUCTION, ignoreCase = true)) {
            if (isProductionHost(host)) {
                return "This nonproduction build refuses the production endpoint ($host)."
            }
            if (scheme != "https" && !isLoopbackHost(host)) {
                return "A nonproduction backend must use https unless it is a loopback test address."
            }
        }
        if (scheme == "http" && !isLoopbackHost(host)) {
            return "Refusing cleartext http to $host."
        }
        return null
    }
}
