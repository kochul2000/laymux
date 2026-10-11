package com.laymux.android.web

import org.junit.Assert.*
import org.junit.Test

class LocalhostPreviewTransportTest {
    @Test fun everyNativeChunkCarriesTheOwnersEncryptedCapability() {
        for (offset in listOf(0, 512 * 1024)) {
            val body = previewResourceRequest("preview-id", "owner-lease", "secret-token", "/game.wasm", offset)
            assertEquals(offset, body.getInt("offset"))
            assertEquals("/game.wasm", body.getString("pathAndQuery"))
            val proof = body.getJSONObject("fileViewerAuthorization")
            assertEquals(body.getString("leaseId"), proof.getString("leaseId"))
            assertEquals("secret-token", proof.getString("fileViewerToken"))
            assertEquals(2, proof.length())
            assertFalse(body.has("authorization"))
            assertFalse(body.has("cookie"))
        }
    }
}
