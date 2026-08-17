package com.laymux.android.web

import com.laymux.android.pairing.Base64Url
import org.json.JSONObject

data class RemoteResourceResponse(
    val status: Int,
    val mimeType: String,
    val encoding: String?,
    val headers: Map<String, String>,
    val body: ByteArray,
) {
    companion object {
        private const val MAX_BODY_BYTES = 2 * 1024 * 1024

        // The wire cap stays 2 MiB (ADR-0146); this only bounds the local
        // gzip inflation. The desktop terminal font is the driving case —
        // ~2.7 MiB sfnt that only fits the wire compressed (ADR-0077 serving,
        // gzip ~0.9 MiB) — while still capping decompression bombs.
        private const val MAX_INFLATED_BYTES = 4 * 1024 * 1024
        internal const val MAX_ENCODED_BODY_LENGTH = (MAX_BODY_BYTES * 4 + 2) / 3
        private val FORWARDED_HEADERS = setOf(
            "cache-control",
            "content-encoding",
            "content-security-policy",
            "content-type",
            "referrer-policy",
            "x-content-type-options",
        )

        fun parse(value: JSONObject): RemoteResourceResponse {
            require(value.optString("kind") == "resource") { "resource response가 필요합니다" }
            val status = value.optInt("status", 0)
            require(status in 100..599) { "resource status가 올바르지 않습니다" }
            val rawHeaders = value.optJSONObject("headers")
                ?: throw IllegalArgumentException("resource headers가 필요합니다")
            val headers = buildMap {
                rawHeaders.keys().forEach { rawName ->
                    val name = rawName.lowercase()
                    if (name in FORWARDED_HEADERS) {
                        val headerValue = rawHeaders.opt(rawName) as? String
                            ?: throw IllegalArgumentException("resource header가 올바르지 않습니다")
                        put(name, headerValue)
                    }
                }
            }
            val contentType = headers["content-type"] ?: "application/octet-stream"
            val parts = contentType.split(';')
            val mimeType = parts.first().trim().lowercase()
            require(mimeType.matches(Regex("[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+"))) {
                "resource content type이 올바르지 않습니다"
            }
            val encoding = parts.drop(1)
                .map(String::trim)
                .firstOrNull { it.startsWith("charset=", ignoreCase = true) }
                ?.substringAfter('=')
                ?.trim()
                ?.trim('"')
                ?.takeIf(String::isNotEmpty)
            val encoded = value.opt("data") as? String
                ?: throw IllegalArgumentException("resource body가 필요합니다")
            require(encoded.length <= MAX_ENCODED_BODY_LENGTH) {
                "resource body가 너무 큽니다"
            }
            val expectedBytes = encoded.length * 6 / 8
            require(expectedBytes <= MAX_BODY_BYTES) { "resource body가 너무 큽니다" }
            val rawBody = Base64Url.decodeExact(encoded, expectedBytes)
                ?: throw IllegalArgumentException("resource body가 올바르지 않습니다")
            // The desktop compresses static resources before AEAD (ADR-0169);
            // the WebView never decodes intercepted responses itself, so the
            // body is inflated here and the header dropped. Unknown codings
            // fail closed.
            val body = when (headers["content-encoding"]?.trim()?.lowercase()) {
                null, "", "identity" -> rawBody
                "gzip" -> gunzipBounded(rawBody)
                else -> throw IllegalArgumentException("resource encoding이 지원되지 않습니다")
            }
            return RemoteResourceResponse(
                status,
                mimeType,
                encoding,
                headers - "content-encoding",
                body,
            )
        }

        private fun gunzipBounded(compressed: ByteArray): ByteArray {
            val output = java.io.ByteArrayOutputStream()
            try {
                java.util.zip.GZIPInputStream(compressed.inputStream()).use { input ->
                    val buffer = ByteArray(8 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        // Bounded before writing: a decompression bomb must not
                        // allocate past the inflated-body limit.
                        if (output.size() + read > MAX_INFLATED_BYTES) {
                            throw IllegalArgumentException("resource body가 너무 큽니다")
                        }
                        output.write(buffer, 0, read)
                    }
                }
            } catch (error: java.io.IOException) {
                throw IllegalArgumentException("resource body 압축 해제에 실패했습니다", error)
            }
            return output.toByteArray()
        }

        fun error(status: Int, message: String): RemoteResourceResponse =
            RemoteResourceResponse(
                status = status,
                mimeType = "text/plain",
                encoding = "utf-8",
                headers = mapOf("cache-control" to "no-store"),
                body = message.toByteArray(Charsets.UTF_8),
            )
    }
}
