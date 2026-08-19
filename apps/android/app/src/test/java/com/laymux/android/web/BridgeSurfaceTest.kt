package com.laymux.android.web

import android.webkit.JavascriptInterface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class BridgeSurfaceTest {
    @Test
    fun remoteBridgeExposesOnlyRemoteDocumentCapabilities() {
        assertEquals(
            setOf(
                "beginOauthRelay",
                "cancelOauthRelay",
                "cancelRemoteHttp",
                "requestRemoteHttp",
                "setRemoteLease",
                "disconnectRemote",
                "openExternalUrl",
                "supportsOutputHistoryBudget",
            ),
            javascriptMethods(RemoteBridge::class.java),
        )
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
}
