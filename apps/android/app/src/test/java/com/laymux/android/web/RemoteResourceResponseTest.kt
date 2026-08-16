package com.laymux.android.web

import com.laymux.android.pairing.Base64Url
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RemoteResourceResponseTest {
    @Test
    fun parsesAuthenticatedDesktopHtmlAndSecurityHeaders() {
        val body = "<title>PC Laymux</title>".toByteArray()
        val response = RemoteResourceResponse.parse(
            JSONObject()
                .put("kind", "resource")
                .put("status", 200)
                .put(
                    "headers",
                    JSONObject()
                        .put("content-type", "text/html; charset=utf-8")
                        .put("content-security-policy", "default-src 'none'"),
                )
                .put("data", Base64Url.encode(body)),
        )

        assertEquals(200, response.status)
        assertEquals("text/html", response.mimeType)
        assertEquals("utf-8", response.encoding)
        assertEquals(
            "default-src 'none'",
            response.headers["content-security-policy"],
        )
        assertArrayEquals(body, response.body)
    }

    @Test
    fun rejectsNonResourceMalformedAndOversizedBodies() {
        assertThrows(IllegalArgumentException::class.java) {
            RemoteResourceResponse.parse(JSONObject().put("kind", "http"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            RemoteResourceResponse.parse(
                JSONObject()
                    .put("kind", "resource")
                    .put("status", 200)
                    .put("headers", JSONObject().put("content-type", "text/html"))
                    .put("data", "***"),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            RemoteResourceResponse.parse(
                JSONObject()
                    .put("kind", "resource")
                    .put("status", 200)
                    .put("headers", JSONObject().put("content-type", "text/html"))
                    .put("data", "A".repeat(RemoteResourceResponse.MAX_ENCODED_BODY_LENGTH + 1)),
            )
        }
    }

    @Test
    fun inflatesGzipBodiesAndDropsTheEncodingHeader() {
        val plain = "console.log(\"remote app\");".repeat(64).toByteArray()
        val compressed = java.io.ByteArrayOutputStream().also { buffer ->
            java.util.zip.GZIPOutputStream(buffer).use { it.write(plain) }
        }.toByteArray()

        val response = RemoteResourceResponse.parse(
            JSONObject()
                .put("kind", "resource")
                .put("status", 200)
                .put(
                    "headers",
                    JSONObject()
                        .put("content-type", "application/javascript")
                        .put("content-encoding", "gzip"),
                )
                .put("data", Base64Url.encode(compressed)),
        )

        assertArrayEquals(plain, response.body)
        assertEquals(null, response.headers["content-encoding"])
    }

    @Test
    fun rejectsUnknownEncodingsCorruptGzipAndDecompressionBombs() {
        fun resource(encoding: String, data: ByteArray) = JSONObject()
            .put("kind", "resource")
            .put("status", 200)
            .put(
                "headers",
                JSONObject()
                    .put("content-type", "text/plain")
                    .put("content-encoding", encoding),
            )
            .put("data", Base64Url.encode(data))

        assertThrows(IllegalArgumentException::class.java) {
            RemoteResourceResponse.parse(resource("br", ByteArray(4)))
        }
        assertThrows(IllegalArgumentException::class.java) {
            RemoteResourceResponse.parse(resource("gzip", ByteArray(16)))
        }
        // 2 MiB of zeros compresses to ~2 KiB; the decompressed size must
        // still be capped at the plain-body limit plus nothing.
        val bomb = java.io.ByteArrayOutputStream().also { buffer ->
            java.util.zip.GZIPOutputStream(buffer).use {
                val zeros = ByteArray(64 * 1024)
                repeat(33) { _ -> it.write(zeros) }
            }
        }.toByteArray()
        assertThrows(IllegalArgumentException::class.java) {
            RemoteResourceResponse.parse(resource("gzip", bomb))
        }
    }
}
