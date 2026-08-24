package com.laymux.android.pairing

import com.laymux.android.update.UpdateChannel
import com.laymux.android.update.UpdateState
import com.laymux.android.update.UpdateSurface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionSettingsPresentationTest {
    @Test
    fun confirmedPairingOffersVerificationAndRemovalButNotAckRetry() {
        val presentation = presentConnectionSettings(
            state(pairing = pairing(confirmed = true)),
        )

        assertEquals(ConnectionPairingStatus.CONFIRMED, presentation.status)
        assertFalse(presentation.retryVisible)
        assertTrue(presentation.verifyVisible)
        assertTrue(presentation.verifyEnabled)
        assertTrue(presentation.forgetVisible)
    }

    @Test
    fun pendingPairingOffersAckRetry() {
        val presentation = presentConnectionSettings(
            state(pairing = pairing(confirmed = false)),
        )

        assertEquals(ConnectionPairingStatus.PENDING, presentation.status)
        assertTrue(presentation.retryVisible)
        assertTrue(presentation.retryEnabled)
        assertTrue(presentation.forgetVisible)
    }

    @Test
    fun unavailableBiometricDisablesSecretUsingActions() {
        val presentation = presentConnectionSettings(
            state(
                pairing = pairing(confirmed = false),
                biometricAvailability = BiometricAvailability.NOT_ENROLLED,
            ),
        )

        assertFalse(presentation.retryEnabled)
        assertFalse(presentation.verifyEnabled)
    }

    @Test
    fun unpairedPcShowsNoPairingActions() {
        val presentation = presentConnectionSettings(state(pairing = null))

        assertEquals(ConnectionPairingStatus.NOT_PAIRED, presentation.status)
        assertFalse(presentation.retryVisible)
        assertFalse(presentation.verifyVisible)
        assertFalse(presentation.forgetVisible)
    }

    private fun state(
        pairing: PairingSheetItem?,
        biometricAvailability: BiometricAvailability = BiometricAvailability.AVAILABLE,
    ): ConnectionSettingsState = ConnectionSettingsState(
        instanceId = "desktop-a",
        pairing = pairing,
        protectionPolicy = PairingProtectionPolicy.BIOMETRIC,
        biometricAvailability = biometricAvailability,
        error = null,
        notice = null,
        update = UpdateState(
            enabled = true,
            currentVersion = "0.11.2",
            channel = UpdateChannel.STABLE,
            checking = false,
            lastCheckedAtEpochMillis = null,
            available = null,
            dismissedVersion = null,
            lastError = null,
            surface = UpdateSurface.OTHER,
        ),
    )

    private fun pairing(confirmed: Boolean): PairingSheetItem = PairingSheetItem(
        endpoint = "https://relay.example.test",
        instanceId = "desktop-a",
        confirmedAtEpochSeconds = if (confirmed) 1_800_000_000 else null,
        label = "개발 PC",
    )
}
