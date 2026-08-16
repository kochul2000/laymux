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
        assertEquals(
            "http://[fd7a:115c:a1e0::1234]:19281/remote/",
            ExternalUrlPolicy.browsableUrl("http://[fd7a:115c:a1e0::1234]:19281/remote/"),
        )
        // Intent scheme matching is case-sensitive; the rest of the URL is untouched.
        assertEquals(
            "https://example.test/A%20b",
            ExternalUrlPolicy.browsableUrl("HTTPS://example.test/A%20b"),
        )
    }

    @Test
    fun keepsCharactersTheWhatwgUrlParserLeavesUnescaped() {
        // `url.href` from the Remote page does not percent-encode these, and dropping such
        // links would leave the very bug this policy exists to fix.
        for (url in listOf(
            "https://api.example.test/v1?filter[]=1&filter[]=2",
            "https://example.test/search?q=a|b",
            "https://grafana.example.test/d/abc?var-x={a,b}^1",
            "https://example.test/path`tick",
        )) {
            assertEquals(url, ExternalUrlPolicy.browsableUrl(url))
        }
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
        assertNull(ExternalUrlPolicy.browsableUrl("https:/example.test/"))
    }

    @Test
    fun rejectsUrlsWithoutAHostOrWithEmbeddedCredentials() {
        assertNull(ExternalUrlPolicy.browsableUrl("https://user:pass@example.test/"))
        assertNull(ExternalUrlPolicy.browsableUrl("https://good.test@evil.test/"))
        assertNull(ExternalUrlPolicy.browsableUrl("https://a@b@evil.test/"))
        assertNull(ExternalUrlPolicy.browsableUrl("http:///nohost"))
        assertNull(ExternalUrlPolicy.browsableUrl("https://:8080/nohost"))
        assertNull(ExternalUrlPolicy.browsableUrl("/remote/v1/navigation"))
        assertNull(ExternalUrlPolicy.browsableUrl(""))
    }

    @Test
    fun rejectsWhitespaceAndControlCharacters() {
        assertNull(ExternalUrlPolicy.browsableUrl("https://exa mple.test/"))
        assertNull(ExternalUrlPolicy.browsableUrl("https://example.test/ "))
        assertNull(ExternalUrlPolicy.browsableUrl("https://example.test/a\nb"))
        assertNull(ExternalUrlPolicy.browsableUrl("https://example.test/\ttab"))
    }
}
