package com.laymux.android.web

import android.webkit.JavascriptInterface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSurfaceTest {
    @Test
    fun remoteBridgeExposesOnlyTransportDisconnectAndLinkOpening() {
        assertEquals(
            setOf(
                "cancelRemoteHttp",
                "requestRemoteHttp",
                "setRemoteLease",
                "disconnectRemote",
                "openExternalUrl",
            ),
            javascriptMethods(RemoteBridge::class.java),
        )
    }

    @Test
    fun pairingBridgeDoesNotExposeRemoteTransportOrLinkOpening() {
        val methods = javascriptMethods(NativeBridge::class.java)

        assertTrue("pairing status must remain available", "getPairingStatus" in methods)
        assertTrue("per-instance deletion must remain available", "forgetPairing" in methods)
        assertTrue(methods.intersect(REMOTE_TRANSPORT_METHODS).isEmpty())
        assertFalse("openExternalUrl" in methods)
    }

    @Test
    fun binaryWebMessageDoesNotReadTheStringAccessor() {
        var stringAccessorRead = false

        val payload = stringWebMessagePayload(messageType = 1, stringType = 0) {
            stringAccessorRead = true
            "must-not-be-read"
        }

        assertNull(payload)
        assertFalse(stringAccessorRead)
    }

    private fun javascriptMethods(type: Class<*>): Set<String> = type.declaredMethods
        .filter { it.isAnnotationPresent(JavascriptInterface::class.java) }
        .mapTo(mutableSetOf()) { it.name }

    companion object {
        private val REMOTE_TRANSPORT_METHODS = setOf(
            "cancelRemoteHttp",
            "requestRemoteHttp",
        )
    }
}
