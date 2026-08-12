package com.laymux.android.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingHandshakeTest {
    private val seed = ByteArray(32) { it.toByte() }
    private val pairingId = "EBESExQVFhcYGRobHB0eHw"
    private val clientNonce = "ICEiIyQlJicoKSorLC0uLw"

    @Test
    fun matchesTheRustHmacTestVector() {
        assertEquals(
            "VCLjMKeN3kuPYo0PZv1B_5u-reuVTjOjVBW9AFmZbD0",
            PairingHandshake.clientProof(seed, pairingId, "desktop-7", clientNonce),
        )
        assertTrue(
            PairingHandshake.verifyServerProof(
                secret = seed,
                pairingId = pairingId,
                instanceId = "desktop-7",
                clientNonce = clientNonce,
                confirmedAtEpochSeconds = 1_786_500_000,
                encodedProof = "uPqJodeWKRiXPi08V_o8JQznMtxtHZF6ZQNEKB0oL_g",
            ),
        )
        assertFalse(
            PairingHandshake.verifyServerProof(
                secret = seed,
                pairingId = pairingId,
                instanceId = "desktop-7",
                clientNonce = clientNonce,
                confirmedAtEpochSeconds = 1_786_500_001,
                encodedProof = "uPqJodeWKRiXPi08V_o8JQznMtxtHZF6ZQNEKB0oL_g",
            ),
        )
    }

    @Test
    fun pendingAckExpiresAtTheExactQrBoundary() {
        val payload = PairingPayload.parse(
            "laymux://pair/v2?endpoint=https%3A%2F%2Fapp.laymux.com" +
                "&instance=desktop-7&pairing=$pairingId&expires=1786500300" +
                "&secret=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
            nowEpochSeconds = 1_786_500_000,
        )
        payload.use {
            PairingHandshake.createSession(it, clientNonce).use { session ->
                assertFalse(session.isExpired(1_786_500_299))
                assertTrue(session.isExpired(1_786_500_300))
            }
        }
    }
}
