package com.laymux.android.web

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudDocumentNavigationContractTest {
    @Test
    fun activityFunnelsEveryProgrammaticCloudLoadThroughTheLoadingGate() {
        val activity = source("java/com/laymux/android/MainActivity.kt").readText()

        assertEquals(
            1,
            Regex("cloudWebView[.]loadUrl[(]").findAll(activity).count(),
        )
        assertFalse(activity.contains("cloudWebView.reload("))
        assertTrue(activity.contains("navigate = { cloudWebView.loadUrl(url) }"))
        assertTrue(activity.contains("loadCloudDocument(retryUrl, replaceWebView = true)"))
        assertTrue(
            activity.contains(
                "loadCloudDocument(cloudNavigation.dashboardUrl, replaceWebView = true)",
            ),
        )
    }

    @Test
    fun foregroundReauthenticationIsNotCanceledByDashboardRecovery() {
        val activity = source("java/com/laymux/android/MainActivity.kt").readText()

        assertTrue(
            Regex(
                """if\s*\(\s*remoteSession == null &&\s*!remoteConnecting &&\s*webView[.]url""",
            ).containsMatchIn(activity),
        )
    }

    @Test
    fun timerExpiredSessionReauthenticatesFromTheRemoteSurface() {
        val activity = source("java/com/laymux/android/MainActivity.kt").readText()

        assertTrue(
            Regex(
                """remoteSession\s*\?:\s*run\s*\{\s*if\s*\(visibleWebSurface == VisibleWebSurface[.]REMOTE\)\s*\{\s*reauthenticateExpiredRemote\(\)""",
            ).containsMatchIn(activity),
        )
        assertEquals(
            3,
            Regex("expireRemoteSessionInBackground[(]session[)]").findAll(activity).count(),
        )
        assertTrue(
            Regex(
                """private fun expireRemoteSessionInBackground\(session: RemoteSession\)\s*\{\s*runOnUiThread\s*\{""",
            ).containsMatchIn(activity),
        )
    }

    private fun source(relative: String): File {
        val candidates = listOf(
            File("src/main", relative),
            File("app/src/main", relative),
        )
        return candidates.firstOrNull(File::isFile)
            ?: error("Android source not found: $relative")
    }
}
