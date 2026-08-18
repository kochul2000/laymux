package com.laymux.android.web

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingBootstrapSurfaceTest {
    @Test
    fun pairingUsesNativeMaterialBottomSheetInsteadOfApkWebAssets() {
        val source = source("java/com/laymux/android/pairing/PairingBottomSheet.kt").readText()
        val dependencies = projectFile("build.gradle.kts").readText()

        assertTrue(source.contains("BottomSheetDialog"))
        assertTrue(source.contains("BottomSheetBehavior"))
        assertTrue(dependencies.contains("com.google.android.material:material:"))
        assertTrue(assetCandidates("index.html").none(File::exists))
        assertTrue(assetCandidates("app.js").none(File::exists))
        assertTrue(assetCandidates("styles.css").none(File::exists))
    }

    @Test
    fun nativeSheetKeepsOnlyConnectionActionsAndDoesNotEmbedSettingsOrWebView() {
        val layout = source("res/layout/pairing_bottom_sheet.xml").readText()

        assertTrue(layout.contains("pairing_connect_button"))
        assertTrue(layout.contains("pairing_scan_button"))
        assertTrue(layout.contains("pairing_cancel_button"))
        assertFalse(layout.contains("pairing_settings_button"))
        assertFalse(layout.contains("pairing_settings_content"))
        assertFalse(layout.contains("WebView"))
    }

    @Test
    fun connectionSettingsUseASeparateNativeMaterialDialog() {
        val dialogSource = source(
            "java/com/laymux/android/pairing/ConnectionSettingsDialog.kt",
        ).readText()
        val layout = source("res/layout/connection_settings_dialog.xml").readText()

        assertTrue(dialogSource.contains("MaterialAlertDialogBuilder"))
        assertTrue(layout.contains("connection_settings_biometric_switch"))
        assertTrue(layout.contains("connection_settings_pairing_actions"))
        assertFalse(layout.contains("pairing_connect_button"))
        assertFalse(layout.contains("WebView"))
    }

    @Test
    fun remoteWebViewClientHasNoPairingBootstrapOrigin() {
        val source = source(
            "java/com/laymux/android/web/LocalContentWebViewClient.kt",
        ).readText()

        assertFalse(source.contains("APP_ASSET_HOST"))
        assertFalse(source.contains("ASSET_PATH"))
        assertFalse(source.contains("const val START_URL"))
    }

    @Test
    fun remoteBridgeResourcesAndOutputAreBoundToTheInstalledDocumentGeneration() {
        val activity = source("java/com/laymux/android/MainActivity.kt").readText()
        val bridge = source("java/com/laymux/android/web/RemoteBridge.kt").readText()

        assertTrue(bridge.contains("private val documentGeneration: Long"))
        assertTrue(activity.contains("RemoteBridge(this@MainActivity, documentGeneration)"))
        assertTrue(activity.contains("loadRemoteResource(documentGeneration, path)"))
        assertTrue(activity.contains("remoteBridgeActionsEnabled(documentGeneration)"))
        assertTrue(activity.contains("replaceSecureWebView()"))
        assertTrue(activity.contains("fun cancelOauthRelay(documentGeneration: Long)"))
    }

    private fun projectFile(relative: String): File {
        val candidates = listOf(File(relative), File("app", relative))
        return candidates.firstOrNull(File::isFile)
            ?: error("Android project file not found: $relative")
    }

    private fun source(relative: String): File {
        val candidates = listOf(
            File("src/main", relative),
            File("app/src/main", relative),
        )
        return candidates.firstOrNull(File::isFile)
            ?: error("Android source not found: $relative")
    }

    private fun assetCandidates(name: String): List<File> = listOf(
        File("src/main/assets", name),
        File("app/src/main/assets", name),
    )
}
