package com.laymux.android.remote

import java.util.Base64
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteHttpBodyLimitTest {
    @Test
    fun oneMibAttachmentJsonFitsTheNativeBridgeLimit() {
        val encoded = Base64.getEncoder().encodeToString(ByteArray(1024 * 1024))
        val body =
            """{"leaseId":"lease","fileName":"attachment.txt","mimeType":"text/plain","data":"$encoded"}"""

        assertTrue(remoteHttpBodyWithinLimit(body))
    }

    @Test
    fun bodyAboveTheRouteLimitIsRejected() {
        assertFalse(remoteHttpBodyWithinLimit("x".repeat(MAX_REMOTE_HTTP_BODY_CHARS + 1)))
    }
}
