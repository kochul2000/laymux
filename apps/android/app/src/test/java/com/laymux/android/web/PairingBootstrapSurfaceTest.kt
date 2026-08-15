package com.laymux.android.web

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingBootstrapSurfaceTest {
    @Test
    fun pairingEntryUsesTheAppLogoAndASectionedConnectionLayout() {
        val html = asset("index.html").readText()

        assertTrue(html.contains("src=\"logo.svg\""))
        assertFalse(html.contains(">Lx</div>"))
        assertTrue(html.contains("class=\"app-header\""))
        assertTrue(html.contains("class=\"status-heading\""))
        assertTrue(html.contains("class=\"primary-actions\""))
        assertTrue(html.contains("class=\"security-note\""))
    }

    @Test
    fun bundledLogoMatchesTheLauncherMarkInsteadOfATextPlaceholder() {
        val logo = asset("logo.svg").readText()

        assertTrue(logo.contains("viewBox=\"0 0 120 120\""))
        assertTrue(logo.contains("#f50a3c"))
        assertTrue(logo.contains("#0af1f5"))
        assertTrue(logo.contains("#ffffff"))
        assertFalse(logo.contains("<text"))
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
