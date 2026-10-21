package com.laymux.android.remote

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteHttpBodyLimitTest {
    @Test
    fun bridgeLimitMirrorsTheDesktop16MibAttachmentRequestBound() {
        // ADR-0353: desktop `remote_attachment_request_limit(16 MiB)` =
        // 22,369,624 base64 chars + 16 KiB slack.
        assertEquals(16 * 1024 * 1024, MAX_REMOTE_ATTACHMENT_BYTES)
        assertEquals(22_386_008, MAX_REMOTE_HTTP_BODY_CHARS)
    }

    @Test
    fun largestConfigurableAttachmentJsonFitsTheNativeBridgeLimit() {
        val encoded = Base64.getEncoder().encodeToString(ByteArray(MAX_REMOTE_ATTACHMENT_BYTES))
        val body =
            """{"leaseId":"lease","fileName":"attachment.txt","mimeType":"text/plain","data":"$encoded"}"""

        assertTrue(remoteHttpBodyWithinLimit(body))
    }

    @Test
    fun bodyAboveTheRouteLimitIsRejected() {
        assertFalse(remoteHttpBodyWithinLimit("x".repeat(MAX_REMOTE_HTTP_BODY_CHARS + 1)))
    }
}

class RemoteHttpRequestPlaintextTest {
    @Test
    fun spliceKeepsTheBodyBytesVerbatim() {
        val body = """{"leaseId":"lease","fileName":"a.pdf","mimeType":"application/pdf","data":"////++//"}"""
        val plaintext = remoteHttpRequestPlaintext("post", "/remote/v1/terminals/t/attachments", body)

        assertTrue(plaintext.contains(""""body":$body}"""))
        assertTrue(plaintext.startsWith("""{"kind":"http","method":"POST","path":"/remote/v1/terminals/t/attachments","body":"""))
        // Round-trips as JSON and grows only by the fixed wrapper, never by escaping.
        org.json.JSONObject(plaintext)
        val wrapper = remoteHttpRequestPlaintext("post", "/remote/v1/terminals/t/attachments", "{}").length - 2
        assertTrue(plaintext.length == body.length + wrapper)
    }

    @Test
    fun nullBodySerializesAsJsonNull() {
        val plaintext = remoteHttpRequestPlaintext("GET", "/remote/v1/navigation", null)
        assertTrue(plaintext.endsWith(""","body":null}"""))
        assertTrue(org.json.JSONObject(plaintext).isNull("body"))
    }
}
