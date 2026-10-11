package com.laymux.android.web

import org.junit.Assert.*
import org.junit.Test

class LocalhostPreviewPolicyTest {
    private val id = "00112233-4455-6677-8899-aabbccddeeff"
    @Test fun onlyTheRegisteredPreviewOriginCanRequestResources() {
        val start = LocalhostPreviewPolicy.startUrl(id, "http://localhost:8765/game/?v=1")!!
        assertEquals("/index.wasm?q=2", LocalhostPreviewPolicy.resourcePath(start,
            "https://preview-$id.laymux.invalid/index.wasm?q=2"))
        for (value in listOf("https://remote.laymux.invalid/remote/v1/navigation",
            "http://localhost:19280/api/v1/settings", "https://evil.test/index.wasm",
            "https://preview-$id.laymux.invalid:8443/index.wasm",
            "https://user@preview-$id.laymux.invalid/index.wasm")) {
            assertNull(LocalhostPreviewPolicy.resourcePath(start, value))
        }
    }
    @Test fun managementPortsAndRemoteTargetsCannotOpenAPreview() {
        for (value in listOf("http://localhost:19280/", "http://localhost:19281/",
            "http://example.org:8765/", "http://user@localhost:8765/", "https://localhost:8765/")) {
            assertNull(LocalhostPreviewPolicy.startUrl(id, value))
        }
        assertNull(LocalhostPreviewPolicy.startUrl("bad", "http://localhost:8765/"))
        assertNotNull(LocalhostPreviewPolicy.startUrl(id, "http://[::1]:8765/"))
    }
}
