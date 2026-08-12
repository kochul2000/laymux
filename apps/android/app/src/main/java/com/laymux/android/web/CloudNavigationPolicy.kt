package com.laymux.android.web

import java.net.URI

/** Exact Cloud origin boundary for the login/dashboard-only WebView. */
class CloudNavigationPolicy(baseUrl: String) {
    private val origin: URI = parseOrigin(baseUrl)
    val originUrl: String = origin.toString().removeSuffix("/")
    val startUrl: String = "$originUrl/app/android"
    val dashboardUrl: String = "$originUrl/dashboard?client=android"
    val googleAuthUrl: String =
        "$originUrl/api/android/auth/google"

    fun isAllowed(rawUrl: String): Boolean = try {
        val candidate = URI(rawUrl)
        candidate.scheme.equals(origin.scheme, ignoreCase = true) &&
            candidate.host?.equals(origin.host, ignoreCase = true) == true &&
            effectivePort(candidate) == effectivePort(origin) &&
            candidate.userInfo == null
    } catch (_: Exception) {
        false
    }

    private fun parseOrigin(rawUrl: String): URI {
        val parsed = try {
            URI(rawUrl)
        } catch (error: Exception) {
            throw IllegalArgumentException("Cloud URL must be an HTTPS origin", error)
        }
        require(parsed.scheme.equals("https", ignoreCase = true)) {
            "Cloud URL must use HTTPS"
        }
        require(parsed.host != null && parsed.userInfo == null) {
            "Cloud URL must not contain credentials"
        }
        require(parsed.path.isNullOrEmpty() || parsed.path == "/") {
            "Cloud URL must not contain a path"
        }
        require(parsed.query == null && parsed.fragment == null) {
            "Cloud URL must not contain query or fragment"
        }
        val authority = if (parsed.port == -1 || parsed.port == 443) {
            parsed.host.lowercase()
        } else {
            "${parsed.host.lowercase()}:${parsed.port}"
        }
        return URI("https://$authority")
    }

    private fun effectivePort(uri: URI): Int = if (uri.port == -1) 443 else uri.port
}
