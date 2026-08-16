package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExternalUrlPolicyTest {
    @Test
    fun acceptsWebUrlsTheRemoteTerminalCanLink() {
        assertEquals(
            "https://github.com/owner/repo/issues/123",
            ExternalUrlPolicy.browsableUrl("https://github.com/owner/repo/issues/123"),
        )
        assertEquals(
            "http://example.test:8080/path?q=1#frag",
            ExternalUrlPolicy.browsableUrl("http://example.test:8080/path?q=1#frag"),
        )
        // Intent scheme matching is case-sensitive; the rest of the URL is untouched.
        assertEquals(
            "https://example.test/A%20b",
            ExternalUrlPolicy.browsableUrl("HTTPS://example.test/A%20b"),
        )
    }

    @Test
    fun rejectsSchemesThatWouldLeaveTheBrowserBoundary() {
        assertNull(ExternalUrlPolicy.browsableUrl("javascript:alert(document.domain)"))
        assertNull(ExternalUrlPolicy.browsableUrl("file:///data/data/com.laymux.android/secret"))
        assertNull(
            ExternalUrlPolicy.browsableUrl(
                "intent://scan/#Intent;scheme=zxing;package=com.example;end",
            ),
        )
        assertNull(ExternalUrlPolicy.browsableUrl("content://com.laymux.android/pairing"))
        assertNull(ExternalUrlPolicy.browsableUrl("laymux://pair/v2?secret=leak"))
    }

    @Test
    fun rejectsUrlsWithoutAHostOrWithEmbeddedCredentials() {
        assertNull(ExternalUrlPolicy.browsableUrl("https://user:pass@example.test/"))
        assertNull(ExternalUrlPolicy.browsableUrl("http:///nohost"))
        assertNull(ExternalUrlPolicy.browsableUrl("/remote/v1/navigation"))
        assertNull(ExternalUrlPolicy.browsableUrl(""))
        assertNull(ExternalUrlPolicy.browsableUrl("https://exa mple.test/"))
    }
}
