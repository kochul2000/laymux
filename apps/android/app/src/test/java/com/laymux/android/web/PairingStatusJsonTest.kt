package com.laymux.android.web

import com.laymux.android.pairing.PairingMetadata
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingStatusJsonTest {
    @Test
    fun returnsAllMetadataButSelectsOnlyTheDashboardInstance() {
        val pending = metadata("desktop-a", confirmedAt = null)
        val confirmed = metadata("desktop-b", confirmedAt = 1_786_500_000)

        val result = JSONObject()
        appendPairingState(result, listOf(pending, confirmed), "desktop-b")

        assertEquals(2, result.getInt("pairingCount"))
        assertEquals("desktop-b", result.getString("selectedInstanceId"))
        assertEquals("desktop-b", result.getString("instanceId"))
        assertTrue(result.getBoolean("paired"))
        assertTrue(result.getBoolean("confirmed"))
        assertFalse(result.getBoolean("confirmationPending"))
        val pairings = result.getJSONArray("pairings")
        assertEquals("desktop-a", pairings.getJSONObject(0).getString("instanceId"))
        assertEquals("desktop-b", pairings.getJSONObject(1).getString("instanceId"))
        assertFalse(pairings.getJSONObject(1).has("pairingId"))
        assertFalse(pairings.getJSONObject(1).has("clientNonce"))
    }

    @Test
    fun doesNotSubstituteAnotherPairingWhenSelectedInstanceIsMissing() {
        val result = JSONObject()
        appendPairingState(result, listOf(metadata("desktop-a", 1_786_500_000)), "desktop-b")

        assertFalse(result.getBoolean("paired"))
        assertFalse(result.getBoolean("confirmed"))
        assertFalse(result.has("instanceId"))
        assertEquals(1, result.getJSONArray("pairings").length())
    }

    private fun metadata(instanceId: String, confirmedAt: Long?): PairingMetadata =
        PairingMetadata(
            endpoint = "https://app.laymux.com/",
            instanceId = instanceId,
            pairingId = "AAAAAAAAAAAAAAAAAAAAAA",
            expiresAtEpochSeconds = 4_102_444_800,
            clientNonce = "BBBBBBBBBBBBBBBBBBBBBB",
            confirmedAtEpochSeconds = confirmedAt,
            label = instanceId,
        )
}
