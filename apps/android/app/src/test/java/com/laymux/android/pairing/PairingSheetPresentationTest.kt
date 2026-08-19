package com.laymux.android.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingSheetPresentationTest {
    @Test
    fun confirmedPairingOffersSecureSessionAndExplicitRescan() {
        val presentation = presentPairingSheet(
            state(
                pairings = listOf(metadata(confirmed = true)),
                biometricAvailability = BiometricAvailability.AVAILABLE,
            ),
        )

        assertEquals(PairingStatusKind.CONFIRMED, presentation.status)
        assertEquals(PairingConnectAction.CONNECT, presentation.connectAction)
        assertEquals(PairingScanAction.RESCAN, presentation.scanAction)
        assertEquals(PairingScanEmphasis.NEUTRAL, presentation.scanEmphasis)
        assertTrue(presentation.connectEnabled)
    }

    @Test
    fun unavailableRequiredBiometricOpensProtectionSettingsAndBlocksConnect() {
        val presentation = presentPairingSheet(
            state(
                pairings = listOf(metadata(confirmed = true)),
                biometricAvailability = BiometricAvailability.NOT_ENROLLED,
            ),
        )

        assertEquals(PairingStatusKind.PROTECTION_REQUIRED, presentation.status)
        assertEquals(PairingScanAction.OPEN_SETTINGS, presentation.scanAction)
        assertEquals(PairingScanEmphasis.PRIMARY, presentation.scanEmphasis)
        assertFalse(presentation.connectEnabled)
    }

    @Test
    fun connectingAttemptTurnsPrimaryActionIntoCancelAndLocksRescan() {
        val presentation = presentPairingSheet(
            state(
                pairings = listOf(metadata(confirmed = true)),
                biometricAvailability = BiometricAvailability.AVAILABLE,
                remoteConnecting = true,
            ),
        )

        assertEquals(PairingConnectAction.CANCEL, presentation.connectAction)
        assertTrue(presentation.connectEnabled)
        assertFalse(presentation.scanEnabled)
    }

    @Test
    fun scannerPreparationKeepsTheScanActionDisabledAcrossRenders() {
        val presentation = presentPairingSheet(
            state(
                pairings = emptyList(),
                biometricAvailability = BiometricAvailability.AVAILABLE,
                scannerBusy = true,
            ),
        )

        assertEquals(PairingScanAction.SCAN, presentation.scanAction)
        assertFalse(presentation.scanEnabled)
    }

    private fun state(
        pairings: List<PairingSheetItem>,
        biometricAvailability: BiometricAvailability,
        remoteConnecting: Boolean = false,
        scannerBusy: Boolean = false,
    ): PairingSheetState = PairingSheetState(
        selectedInstanceId = "desktop-a",
        pairings = pairings,
        protectionPolicy = PairingProtectionPolicy.BIOMETRIC,
        biometricAvailability = biometricAvailability,
        remoteConnected = false,
        remoteConnecting = remoteConnecting,
        scannerBusy = scannerBusy,
        scannerProgressVisible = scannerBusy,
        scannerProgressPercent = null,
        error = null,
        notice = null,
    )

    private fun metadata(confirmed: Boolean): PairingSheetItem = PairingSheetItem(
        endpoint = "https://relay.example.test",
        instanceId = "desktop-a",
        confirmedAtEpochSeconds = if (confirmed) 1_800_000_000 else null,
        label = "개발 PC",
    )
}
