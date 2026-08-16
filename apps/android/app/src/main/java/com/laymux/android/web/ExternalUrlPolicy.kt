package com.laymux.android.web

import java.net.URI

/**
 * Links inside the Remote terminal are terminal-controlled text, so the URL that reaches
 * `Intent.ACTION_VIEW` is re-validated here instead of trusting the WebView's own check.
 * Only absolute `http`/`https` URLs with a host and no userinfo become browsable.
 */
object ExternalUrlPolicy {
    fun browsableUrl(rawUrl: String): String? {
        val parsed = try {
            URI(rawUrl)
        } catch (_: Exception) {
            return null
        }
        if (!parsed.isAbsolute || parsed.isOpaque) return null
        val scheme = parsed.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (parsed.host.isNullOrEmpty() || parsed.userInfo != null) return null
        // `Intent` scheme matching is case-sensitive, so only the scheme is rewritten in place;
        // the rest of the URL keeps the exact bytes the terminal produced.
        return scheme + rawUrl.substring(scheme.length)
    }
}
