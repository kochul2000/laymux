package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Test

class RemoteLoadProgressTest {
    @Test
    fun startsWithABarePendingLine() {
        assertEquals("원격 UI 수신 중", RemoteLoadProgress().statusText())
    }

    @Test
    fun showsTheFileCurrentlyCrossingTheRelay() {
        val progress = RemoteLoadProgress().fetching("/remote/vendor/xterm.js")
        assertEquals("원격 UI 수신 중\nxterm.js", progress.statusText())
    }

    @Test
    fun accumulatesFetchedCountAndBytes() {
        val progress = RemoteLoadProgress()
            .fetching("/remote/")
            .fetched(200 * 1024)
            .fetching("/remote/font/a.ttf")
            .fetched(1_400 * 1024)

        assertEquals("원격 UI 수신 중 · 2개 · 1.6 MB", progress.statusText())
    }

    @Test
    fun reportsCacheHitsSeparately() {
        val progress = RemoteLoadProgress().cacheHit().cacheHit().fetching("/remote/")
        assertEquals("원격 UI 수신 중 · 캐시 2개\n원격 페이지", progress.statusText())
    }

    @Test
    fun aFailedFetchStopsNamingTheFile() {
        val progress = RemoteLoadProgress().fetching("/remote/pwa/icon-192.png").fetchFailed()
        assertEquals("원격 UI 수신 중", progress.statusText())
    }

    @Test
    fun formatsBytesForHumans() {
        assertEquals("512 B", RemoteLoadProgress.formatBytes(512))
        assertEquals("2 KB", RemoteLoadProgress.formatBytes(2_048))
        assertEquals("1.5 MB", RemoteLoadProgress.formatBytes(1_572_864))
    }

    @Test
    fun namesTheRootDocumentInKorean() {
        assertEquals("원격 페이지", RemoteLoadProgress.displayName("/remote/"))
        assertEquals("xterm.css", RemoteLoadProgress.displayName("/remote/vendor/xterm.css"))
    }
}
