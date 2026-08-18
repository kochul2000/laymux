package com.laymux.android.web

import android.webkit.JavascriptInterface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudBridgeInputTest {
    @Test
    fun cloudJavascriptBridgeExposesOnlyLoginInstanceSelectionAndSettingsEntry() {
        val exposed = CloudBridge::class.java.declaredMethods
            .filter { it.getAnnotation(JavascriptInterface::class.java) != null }
            .map { it.name }
            .toSet()

        assertEquals(
            setOf(
                "signInWithGoogle",
                "selectInstance",
                "selectInstanceRoute",
                "openConnectionSettings",
            ),
            exposed,
        )
    }

    @Test
    fun acceptsExactServerNonceAndCanonicalInstanceUuid() {
        assertTrue(CloudBridgeInput.isValidNonce("a".repeat(42) + "_"))
        assertTrue(CloudBridgeInput.isValidInstanceId("123e4567-e89b-12d3-a456-426614174000"))
    }

    @Test
    fun rejectsMalformedCloudInputs() {
        assertFalse(CloudBridgeInput.isValidNonce("a".repeat(42)))
        assertFalse(CloudBridgeInput.isValidNonce("a".repeat(42) + "+"))
        assertFalse(CloudBridgeInput.isValidInstanceId("123e4567-e89b-12d3-a456-42661417400Z"))
        assertFalse(CloudBridgeInput.isValidInstanceId("../remote"))
    }

    @Test
    fun selectedCloudPcMustMatchThePairingQr() {
        val selected = "123e4567-e89b-12d3-a456-426614174000"

        assertTrue(CloudBridgeInput.matchesSelectedInstance(selected, selected))
        assertFalse(
            CloudBridgeInput.matchesSelectedInstance(
                selected,
                "123e4567-e89b-12d3-a456-426614174001",
            ),
        )
        assertTrue(CloudBridgeInput.matchesSelectedInstance(null, selected))
    }

    @Test
    fun acceptsOnlyCanonicalTailscaleDirectUrls() {
        assertEquals(
            "http://100.100.10.20:19281/remote/",
            CloudBridgeInput.validTailscaleUrl("http://100.100.10.20:19281/remote/"),
        )
        assertEquals(
            "http://[fd7a:115c:a1e0::1234]:19280/remote/",
            CloudBridgeInput.validTailscaleUrl(
                "http://[fd7a:115c:a1e0::1234]:19280/remote/",
            ),
        )
        assertEquals(null, CloudBridgeInput.validTailscaleUrl(""))
        assertEquals(null, CloudBridgeInput.validTailscaleUrl("https://100.100.10.20/remote/"))
        assertEquals(null, CloudBridgeInput.validTailscaleUrl("http://192.168.1.2:19280/remote/"))
        assertEquals(null, CloudBridgeInput.validTailscaleUrl("http://100.100.10.20:3000/remote/"))
        assertEquals(null, CloudBridgeInput.validTailscaleUrl("http://100.100.10.20:19280/remote/?x=1"))
        assertEquals(null, CloudBridgeInput.validTailscaleUrl("http://user@100.100.10.20:19280/remote/"))
    }

    @Test
    fun distinguishesMissingTailscaleHintFromInvalidNonEmptyHint() {
        assertEquals(TailscaleRouteHint.Missing, CloudBridgeInput.tailscaleRouteHint(""))
        assertEquals(
            TailscaleRouteHint.Valid("http://100.64.0.2:19280/remote/"),
            CloudBridgeInput.tailscaleRouteHint("http://100.64.0.2:19280/remote/"),
        )
        assertEquals(
            TailscaleRouteHint.Invalid,
            CloudBridgeInput.tailscaleRouteHint("http://192.168.1.2:19280/remote/"),
        )
    }
}
