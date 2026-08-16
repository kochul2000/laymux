package com.laymux.android.web

/**
 * Links inside the Remote terminal are terminal-controlled text, so the URL that reaches
 * `Intent.ACTION_VIEW` is re-validated here instead of trusting the WebView's own check.
 *
 * Only the scheme and the authority decide where the intent goes, so only those are parsed;
 * the path and query are passed through untouched. `java.net.URI` is deliberately not used:
 * it follows RFC 2396 and rejects `[]`, `{}`, `|` and other characters that the WHATWG URL
 * parser (and therefore `url.href` from the Remote page, and `android.net.Uri`) leaves
 * unescaped, which would silently drop ordinary links such as `?filter[]=1`.
 */
object ExternalUrlPolicy {
    private val WEB_URL = Regex("""^(https?)://([^/?#]*)([/?#].*)?$""", RegexOption.IGNORE_CASE)

    fun browsableUrl(rawUrl: String): String? {
        // Whitespace and control characters never appear in a `url.href` and are the usual
        // vehicle for confusing a downstream parser, so they fail closed before anything else.
        if (rawUrl.any { it.isWhitespace() || it.isISOControl() }) return null
        val match = WEB_URL.matchEntire(rawUrl) ?: return null
        val authority = match.groupValues[2]
        // No userinfo, and a non-empty host (`:8080/...` has none). The host itself is left to
        // the browser: a bad one cannot change which app the intent resolves to.
        if (authority.isEmpty() || authority.contains('@') || authority.startsWith(':')) {
            return null
        }
        // Intent scheme matching is case-sensitive, so only the scheme is rewritten in place;
        // the rest of the URL keeps the exact bytes the terminal produced.
        val scheme = match.groupValues[1].lowercase()
        return scheme + rawUrl.substring(scheme.length)
    }
}
