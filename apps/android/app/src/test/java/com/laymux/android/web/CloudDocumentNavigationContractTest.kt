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

    private fun source(relative: String): File {
        val candidates = listOf(
            File("src/main", relative),
            File("app/src/main", relative),
        )
        return candidates.firstOrNull(File::isFile)
            ?: error("Android source not found: $relative")
    }
}
