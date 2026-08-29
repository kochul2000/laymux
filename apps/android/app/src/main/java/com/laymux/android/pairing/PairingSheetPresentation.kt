package com.laymux.android.pairing

data class PairingSheetItem(
    val endpoint: String,
    val instanceId: String,
    val confirmedAtEpochSeconds: Long?,
    val label: String?,
)

data class PairingSheetState(
    val selectedInstanceId: String?,
    val pairings: List<PairingSheetItem>,
    val protectionPolicy: PairingProtectionPolicy,
    val biometricAvailability: BiometricAvailability,
    val remoteConnected: Boolean,
    val remoteConnecting: Boolean,
    // True while any pairing/connect operation is still running (scan, ACK,
    // biometric unwrap, session open). MainActivity already owns that
    // definition for its own re-entrancy guards, so the sheet takes it as a
    // raw input instead of re-deriving a second, drifting copy.
    val busy: Boolean,
    val error: String?,
    val notice: String?,
)

enum class PairingStatusKind {
    PROTECTION_REQUIRED,
    CONFIRMED,
    CONFIRMATION_PENDING,
    SAVED_PAIRINGS,
    PAIRING_REQUIRED,
}

enum class PairingDescriptionKind {
    PROTECTION_REQUIRED,
    CONFIRMED_BIOMETRIC,
    CONFIRMED_KEYSTORE_ONLY,
    CONFIRMATION_PENDING,
    SCAN_SELECTED,
    SAVED_PAIRINGS,
    SELECT_PC,
}

enum class PairingScanAction {
    HIDDEN,
    OPEN_SETTINGS,
    SCAN,
    RESCAN,
}

enum class PairingScanEmphasis {
    PRIMARY,
    NEUTRAL,
}

enum class PairingConnectAction {
    HIDDEN,
    CONNECT,
    CANCEL,
    DISCONNECT,
}

data class PairingSheetPresentation(
    val status: PairingStatusKind,
    val description: PairingDescriptionKind,
    val connectAction: PairingConnectAction,
    val connectEnabled: Boolean,
    val scanAction: PairingScanAction,
    val scanEmphasis: PairingScanEmphasis,
    val scanEnabled: Boolean,
    val busy: Boolean,
    val noticeVisible: Boolean,
)

fun presentPairingSheet(state: PairingSheetState): PairingSheetPresentation {
    val selected = state.pairings.firstOrNull { it.instanceId == state.selectedInstanceId }
    val confirmed = selected?.confirmedAtEpochSeconds != null
    val confirmationPending = selected != null && !confirmed
    val biometricRequired = state.protectionPolicy == PairingProtectionPolicy.BIOMETRIC
    val biometricBlocked = biometricRequired &&
        state.biometricAvailability != BiometricAvailability.AVAILABLE

    val status = when {
        biometricBlocked -> PairingStatusKind.PROTECTION_REQUIRED
        confirmed -> PairingStatusKind.CONFIRMED
        confirmationPending -> PairingStatusKind.CONFIRMATION_PENDING
        state.pairings.isNotEmpty() -> PairingStatusKind.SAVED_PAIRINGS
        else -> PairingStatusKind.PAIRING_REQUIRED
    }
    val description = when {
        biometricBlocked -> PairingDescriptionKind.PROTECTION_REQUIRED
        confirmed && biometricRequired -> PairingDescriptionKind.CONFIRMED_BIOMETRIC
        confirmed -> PairingDescriptionKind.CONFIRMED_KEYSTORE_ONLY
        confirmationPending -> PairingDescriptionKind.CONFIRMATION_PENDING
        state.selectedInstanceId != null -> PairingDescriptionKind.SCAN_SELECTED
        state.pairings.isNotEmpty() -> PairingDescriptionKind.SAVED_PAIRINGS
        else -> PairingDescriptionKind.SELECT_PC
    }
    val connectAction = when {
        !confirmed -> PairingConnectAction.HIDDEN
        state.remoteConnected -> PairingConnectAction.DISCONNECT
        state.remoteConnecting -> PairingConnectAction.CANCEL
        else -> PairingConnectAction.CONNECT
    }
    val scanAction = when {
        state.selectedInstanceId == null -> PairingScanAction.HIDDEN
        biometricBlocked -> PairingScanAction.OPEN_SETTINGS
        selected != null -> PairingScanAction.RESCAN
        else -> PairingScanAction.SCAN
    }

    return PairingSheetPresentation(
        status = status,
        description = description,
        connectAction = connectAction,
        connectEnabled = connectAction == PairingConnectAction.CANCEL ||
            connectAction == PairingConnectAction.DISCONNECT ||
            (connectAction == PairingConnectAction.CONNECT && !biometricBlocked),
        scanAction = scanAction,
        scanEmphasis = if (scanAction == PairingScanAction.RESCAN) {
            PairingScanEmphasis.NEUTRAL
        } else {
            PairingScanEmphasis.PRIMARY
        },
        scanEnabled = !state.remoteConnecting || biometricBlocked,
        busy = state.busy,
        // A refresh that carries no notice still happens mid-operation (most
        // notifyPairingChanged() callers pass neither text), so the row stays
        // up while busy — otherwise the spinner would blink out of an
        // operation that is still running.
        noticeVisible = state.busy || !state.notice.isNullOrBlank(),
    )
}
