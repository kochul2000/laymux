package com.laymux.android.web

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingBootstrapSurfaceTest {
    @Test
    fun pairingEntryContainsOnlyTheSecureOverlayAndBottomSheet() {
        val html = asset("index.html").readText()

        assertFalse(html.contains(">Lx</div>"))
        assertTrue(html.contains("class=\"connection-stage\""))
        assertTrue(html.contains("id=\"dismissLayer\""))
        assertTrue(html.contains("id=\"connectionSheet\""))
        assertTrue(html.contains("class=\"sheet-handle\""))
        assertTrue(html.contains("class=\"status-heading\""))
        assertTrue(html.contains("class=\"primary-actions\""))
        assertTrue(html.contains("class=\"connection-settings\""))
        assertFalse(html.contains("class=\"dashboard-scene\""))
        assertFalse(html.contains("id=\"sceneDeviceName\""))
        assertFalse(html.contains("logo.svg"))
        assertFalse(html.contains("class=\"app-header\""))
        assertFalse(html.contains("class=\"security-note\""))
    }

    @Test
    fun pairingDocumentKeepsItsPageBackgroundTransparent() {
        val styles = asset("styles.css").readText()

        assertTrue(styles.contains("background: transparent"))
        assertFalse(styles.contains(".dashboard-scene"))
        assertFalse(styles.contains(".scene-device"))
    }

    @Test
    fun blockedBiometricFlowPointsToTheProtectionSetting() {
        val html = asset("index.html").readText()
        val script = asset("app.js").readText()

        assertTrue(html.contains("id=\"connectionSettings\""))
        assertTrue(
            script.contains(
                "status.biometricRequired === true && status.biometricAvailable === false",
            ),
        )
        assertTrue(script.contains("보호 설정 열기"))
        assertTrue(script.contains("connectionSettings.open = true"))
        assertTrue(script.contains("QR 스캔을 계속하려면"))
        assertTrue(script.contains("biometricToggle.focus()"))
    }

    private fun asset(name: String): File {
        val candidates = listOf(
            File("src/main/assets", name),
            File("app/src/main/assets", name),
        )
        return candidates.firstOrNull(File::isFile)
            ?: error("Android bootstrap asset not found: $name")
    }
}
