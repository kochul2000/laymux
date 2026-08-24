package com.laymux.android.pairing

import com.laymux.android.update.UpdateState

data class ConnectionSettingsState(
    val instanceId: String,
    val pairing: PairingSheetItem?,
    val protectionPolicy: PairingProtectionPolicy,
    val biometricAvailability: BiometricAvailability,
    val error: String?,
    val notice: String?,
    /**
     * 앱 업데이트는 페어링별 상태가 아니지만, 이 다이얼로그가 앱의 유일한
     * 네이티브 설정 표면이므로 여기에 실어 보낸다 (ADR-0197).
     */
    val update: UpdateState,
)

enum class ConnectionPairingStatus {
    NOT_PAIRED,
    PENDING,
    CONFIRMED,
}

data class ConnectionSettingsPresentation(
    val status: ConnectionPairingStatus,
    val retryVisible: Boolean,
    val retryEnabled: Boolean,
    val verifyVisible: Boolean,
    val verifyEnabled: Boolean,
    val forgetVisible: Boolean,
)

fun presentConnectionSettings(
    state: ConnectionSettingsState,
): ConnectionSettingsPresentation {
    val status = when {
        state.pairing == null -> ConnectionPairingStatus.NOT_PAIRED
        state.pairing.confirmedAtEpochSeconds == null -> ConnectionPairingStatus.PENDING
        else -> ConnectionPairingStatus.CONFIRMED
    }
    val biometricReady = state.protectionPolicy != PairingProtectionPolicy.BIOMETRIC ||
        state.biometricAvailability == BiometricAvailability.AVAILABLE

    return ConnectionSettingsPresentation(
        status = status,
        retryVisible = status == ConnectionPairingStatus.PENDING,
        retryEnabled = status == ConnectionPairingStatus.PENDING && biometricReady,
        verifyVisible = state.pairing != null &&
            state.protectionPolicy == PairingProtectionPolicy.BIOMETRIC,
        verifyEnabled = state.pairing != null && biometricReady,
        forgetVisible = state.pairing != null,
    )
}
