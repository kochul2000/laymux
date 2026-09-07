package com.laymux.android.web

import java.io.File
import org.junit.Assert.assertTrue
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
        assertTrue(disconnect.contains("remoteDisconnectGeneration == documentGeneration"))
        assertTrue(disconnect.contains("targetWebView !== webView"))
        assertTrue(activity.contains("if (remoteLeaseId != null) remoteDisconnectGeneration = null"))
        val completion = activity.substringAfter("fun disconnectRemoteFromWeb")
            .substringBefore("/**")
        assertTrue(completion.contains(
            "if (remoteBridgeActionsEnabled(documentGeneration)) showCloudDashboard()",
        ))
    }
}
