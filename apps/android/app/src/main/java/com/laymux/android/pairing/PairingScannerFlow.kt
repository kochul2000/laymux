package com.laymux.android.pairing

enum class PairingScannerStage {
    IDLE,
    CHECKING_MODULE,
    INSTALLING_MODULE,
    PRIMARY,
    WAITING_CAMERA_PERMISSION,
    BUNDLED,
}

enum class PairingScannerCommand {
    NONE,
    CHECK_MODULE,
    INSTALL_MODULE,
    LAUNCH_PRIMARY,
    REQUEST_CAMERA_PERMISSION,
    LAUNCH_BUNDLED,
    PERMISSION_DENIED,
}

data class PairingScannerStart(
    val generation: Long,
    val command: PairingScannerCommand,
)

fun pairingScannerProgressPercent(
    bytesDownloaded: Long,
    totalBytesToDownload: Long,
): Int? {
    if (totalBytesToDownload <= 0L) return null
    return (
        bytesDownloaded.coerceAtLeast(0L).toDouble() * 100.0 /
            totalBytesToDownload.toDouble()
        ).toInt().coerceIn(0, 100)
}

/** Pure generation-scoped transition owner for the two Android QR scanners. */
class PairingScannerFlow {
    var generation: Long = 0
        private set
    var stage: PairingScannerStage = PairingScannerStage.IDLE
        private set

    val isBusy: Boolean
        get() = stage != PairingScannerStage.IDLE

    fun start(): PairingScannerStart {
        generation += 1
        stage = PairingScannerStage.CHECKING_MODULE
        return PairingScannerStart(generation, PairingScannerCommand.CHECK_MODULE)
    }

    fun isCurrent(expectedGeneration: Long): Boolean =
        expectedGeneration == generation && isBusy

    fun onModuleAvailability(
        expectedGeneration: Long,
        available: Boolean,
    ): PairingScannerCommand {
        if (!matches(expectedGeneration, PairingScannerStage.CHECKING_MODULE)) {
            return PairingScannerCommand.NONE
        }
        return if (available) {
            stage = PairingScannerStage.PRIMARY
            PairingScannerCommand.LAUNCH_PRIMARY
        } else {
            stage = PairingScannerStage.INSTALLING_MODULE
            PairingScannerCommand.INSTALL_MODULE
        }
    }

    fun onModuleCheckFailure(expectedGeneration: Long): PairingScannerCommand =
        enterCameraPermission(expectedGeneration, PairingScannerStage.CHECKING_MODULE)

    fun onModuleInstallAccepted(
        expectedGeneration: Long,
        alreadyInstalled: Boolean,
    ): PairingScannerCommand {
        if (!matches(expectedGeneration, PairingScannerStage.INSTALLING_MODULE)) {
            return PairingScannerCommand.NONE
        }
        if (!alreadyInstalled) return PairingScannerCommand.NONE
        stage = PairingScannerStage.PRIMARY
        return PairingScannerCommand.LAUNCH_PRIMARY
    }

    fun onModuleInstallFinished(
        expectedGeneration: Long,
        succeeded: Boolean,
    ): PairingScannerCommand {
        if (!matches(expectedGeneration, PairingScannerStage.INSTALLING_MODULE)) {
            return PairingScannerCommand.NONE
        }
        return if (succeeded) {
            stage = PairingScannerStage.PRIMARY
            PairingScannerCommand.LAUNCH_PRIMARY
        } else {
            stage = PairingScannerStage.WAITING_CAMERA_PERMISSION
            PairingScannerCommand.REQUEST_CAMERA_PERMISSION
        }
    }

    fun onPrimaryFailure(expectedGeneration: Long): PairingScannerCommand =
        enterCameraPermission(expectedGeneration, PairingScannerStage.PRIMARY)

    fun onCameraPermissionResult(
        expectedGeneration: Long,
        granted: Boolean,
    ): PairingScannerCommand {
        if (!matches(expectedGeneration, PairingScannerStage.WAITING_CAMERA_PERMISSION)) {
            return PairingScannerCommand.NONE
        }
        return if (granted) {
            stage = PairingScannerStage.BUNDLED
            PairingScannerCommand.LAUNCH_BUNDLED
        } else {
            stage = PairingScannerStage.IDLE
            PairingScannerCommand.PERMISSION_DENIED
        }
    }

    fun complete(expectedGeneration: Long): Boolean {
        if (expectedGeneration != generation ||
            (stage != PairingScannerStage.PRIMARY && stage != PairingScannerStage.BUNDLED)
        ) {
            return false
        }
        stage = PairingScannerStage.IDLE
        return true
    }

    fun cancel() {
        generation += 1
        stage = PairingScannerStage.IDLE
    }

    private fun enterCameraPermission(
        expectedGeneration: Long,
        expectedStage: PairingScannerStage,
    ): PairingScannerCommand {
        if (!matches(expectedGeneration, expectedStage)) return PairingScannerCommand.NONE
        stage = PairingScannerStage.WAITING_CAMERA_PERMISSION
        return PairingScannerCommand.REQUEST_CAMERA_PERMISSION
    }

    private fun matches(
        expectedGeneration: Long,
        expectedStage: PairingScannerStage,
    ): Boolean = expectedGeneration == generation && stage == expectedStage
}
