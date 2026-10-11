package com.laymux.android.web

import java.net.URI

internal object LocalhostPreviewPolicy {
    fun startUrl(sessionId: String, target: String): String? = runCatching {
        if (!sessionId.matches(Regex("[a-f0-9-]{36}"))) return null
        val url = URI(target)
        if (url.scheme != "http" || url.userInfo != null ||
            url.host !in setOf("localhost", "127.0.0.1", "[::1]") ||
            url.port < 1024 || url.port in setOf(19280, 19281)
        ) return null
        "https://preview-$sessionId.laymux.invalid${url.rawPath.ifEmpty { "/" }}" +
            (url.rawQuery?.let { "?$it" } ?: "") + (url.rawFragment?.let { "#$it" } ?: "")
    }.getOrNull()

    fun resourcePath(startUrl: String, value: String): String? = runCatching {
        val start = URI(startUrl)
        val url = URI(value)
        if (url.scheme != start.scheme || url.host != start.host ||
            url.port != -1 || url.userInfo != null
        ) return null
        url.rawPath.ifEmpty { "/" } + (url.rawQuery?.let { "?$it" } ?: "")
    }.getOrNull()
}
