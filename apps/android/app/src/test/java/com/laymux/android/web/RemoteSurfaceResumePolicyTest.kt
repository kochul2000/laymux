package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Test

class RemoteSurfaceResumePolicyTest {
    @Test
    fun liveRemoteDocumentResumesInPlace() {
        assertEquals(
            RemoteSurfaceResumeAction.NOTIFY_EXISTING_DOCUMENT,
            RemoteSurfaceResumePolicy.action(
                remoteSurfaceInstalled = true,
                currentUrl = LocalContentWebViewClient.REMOTE_START_URL,
            ),
        )
    }

    @Test
    fun missingOrForeignDocumentReloadsFromTheAuthenticatedRemoteOrigin() {
        val unsafeUrls = listOf(
            null,
            "https://appassets.androidplatform.net/assets/index.html",
            "http://remote.laymux.invalid/remote/",
            "https://remote.laymux.invalid:443/remote/",
            "https://user@remote.laymux.invalid/remote/",
            "https://remote.laymux.invalid.evil/remote/",
        )
        for (url in unsafeUrls) {
            assertEquals(
                RemoteSurfaceResumeAction.RELOAD_DOCUMENT,
                RemoteSurfaceResumePolicy.action(remoteSurfaceInstalled = true, currentUrl = url),
            )
        }
        assertEquals(
            RemoteSurfaceResumeAction.RELOAD_DOCUMENT,
            RemoteSurfaceResumePolicy.action(
                remoteSurfaceInstalled = false,
                currentUrl = LocalContentWebViewClient.REMOTE_START_URL,
            ),
        )
    }
}
