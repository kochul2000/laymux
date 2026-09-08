package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteDownloadPolicyTest {
    @Test
    fun `keeps an ordinary file name unchanged`() {
        assertEquals("notes.md", RemoteDownloadPolicy.safeDisplayName("notes.md"))
        assertEquals("한글 파일.txt", RemoteDownloadPolicy.safeDisplayName("한글 파일.txt"))
    }

    @Test
    fun `takes the last segment of a host path from either platform`() {
        assertEquals("main.rs", RemoteDownloadPolicy.safeDisplayName("C:\\work\\src\\main.rs"))
        assertEquals("main.rs", RemoteDownloadPolicy.safeDisplayName("/home/user/src/main.rs"))
    }

    @Test
    fun `replaces separators and reserved characters instead of failing`() {
        assertEquals("a_b.txt", RemoteDownloadPolicy.safeDisplayName("a:b.txt"))
        assertEquals("q_.txt", RemoteDownloadPolicy.safeDisplayName("q?.txt"))
        assertEquals("tab_here.txt", RemoteDownloadPolicy.safeDisplayName("tab\there.txt"))
    }

    @Test
    fun `falls back for names that address a directory rather than a file`() {
        assertEquals("laymux-download", RemoteDownloadPolicy.safeDisplayName(""))
        assertEquals("laymux-download", RemoteDownloadPolicy.safeDisplayName("."))
        assertEquals("laymux-download", RemoteDownloadPolicy.safeDisplayName(".."))
        assertEquals("laymux-download", RemoteDownloadPolicy.safeDisplayName("/tmp/"))
        assertEquals("laymux-download", RemoteDownloadPolicy.safeDisplayName("   "))
    }

    @Test
    fun `keeps the extension when a long name has to be trimmed`() {
        val name = "x".repeat(200) + ".png"
        val safe = RemoteDownloadPolicy.safeDisplayName(name)
        assertEquals(96, safe.length)
        assertTrue(safe.endsWith(".png"))
    }

    @Test
    fun `treats an over-long suffix as part of the stem`() {
        val name = "y".repeat(200) + ".thisisnotanextension"
        val safe = RemoteDownloadPolicy.safeDisplayName(name)
        assertEquals(96, safe.length)
        assertFalse(safe.contains('.'))
    }

    @Test
    fun `bounds the payload at the Remote transfer limit`() {
        assertEquals(2 * 1024 * 1024, RemoteDownloadPolicy.MAX_DOWNLOAD_BYTES)
        assertEquals(2_796_204, RemoteDownloadPolicy.MAX_ENCODED_DOWNLOAD_CHARS)
        assertTrue(
            RemoteDownloadPolicy.isEncodedPayloadWithinBound(
                RemoteDownloadPolicy.MAX_ENCODED_DOWNLOAD_CHARS,
            ),
        )
        assertFalse(
            RemoteDownloadPolicy.isEncodedPayloadWithinBound(
                RemoteDownloadPolicy.MAX_ENCODED_DOWNLOAD_CHARS + 1,
            ),
        )
        assertTrue(RemoteDownloadPolicy.isWithinBound(0))
        assertTrue(RemoteDownloadPolicy.isWithinBound(RemoteDownloadPolicy.MAX_DOWNLOAD_BYTES))
        assertFalse(RemoteDownloadPolicy.isWithinBound(RemoteDownloadPolicy.MAX_DOWNLOAD_BYTES + 1))
        assertFalse(RemoteDownloadPolicy.isWithinBound(-1))
    }
}
