package com.laymux.android.web

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

class RemoteDisconnectContractTest {
    @Test
    fun nativeLeaveUsesPageExitAndOnlyThePageCompletionClosesTheSession() {
        val activity = listOf(
            File("src/main/java/com/laymux/android/MainActivity.kt"),
            File("app/src/main/java/com/laymux/android/MainActivity.kt"),
        ).first(File::isFile).readText()
        val disconnect = activity.substringAfter("fun disconnectRemote() {")
            .substringBefore("fun disconnectRemoteFromWeb")
        assertTrue(disconnect.contains("evaluateJavascript(REMOTE_EXIT_SCRIPT)"))
        assertFalse(disconnect.contains("remoteDisconnectGeneration"))
        assertTrue(disconnect.contains("targetWebView !== webView"))
        val completion = activity.substringAfter("fun disconnectRemoteFromWeb")
            .substringBefore("/**")
        assertTrue(completion.contains(
            "if (remoteBridgeActionsEnabled(documentGeneration)) showCloudDashboard()",
        ))
    }
}
