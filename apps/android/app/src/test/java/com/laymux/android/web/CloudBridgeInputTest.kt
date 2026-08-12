package com.laymux.android.web

import android.webkit.JavascriptInterface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudBridgeInputTest {
    @Test
    fun cloudJavascriptBridgeExposesOnlyLoginAndInstanceSelection() {
        val exposed = CloudBridge::class.java.declaredMethods
            .filter { it.getAnnotation(JavascriptInterface::class.java) != null }
            .map { it.name }
            .toSet()

        assertEquals(setOf("signInWithGoogle", "selectInstance"), exposed)
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
}
