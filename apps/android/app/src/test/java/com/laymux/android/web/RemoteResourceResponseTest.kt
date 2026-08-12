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
}
