package com.laymux.android.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingScannerFlowTest {
    @Test
    fun moduleProgressIsBoundedAndUnknownWithoutATotal() {
        assertEquals(null, pairingScannerProgressPercent(10, 0))
        assertEquals(25, pairingScannerProgressPercent(250, 1_000))
        assertEquals(100, pairingScannerProgressPercent(2_000, 1_000))
        assertEquals(0, pairingScannerProgressPercent(-1, 1_000))
    }

    @Test
    fun missingModuleInstallsAndLaunchesPrimaryScannerAfterCompletion() {
        val flow = PairingScannerFlow()
        val start = flow.start()

        assertEquals(PairingScannerCommand.CHECK_MODULE, start.command)
        assertEquals(
            PairingScannerCommand.INSTALL_MODULE,
            flow.onModuleAvailability(start.generation, available = false),
        )
        assertEquals(
            PairingScannerCommand.NONE,
            flow.onModuleInstallAccepted(start.generation, alreadyInstalled = false),
        )
        assertEquals(
            PairingScannerCommand.LAUNCH_PRIMARY,
            flow.onModuleInstallFinished(start.generation, succeeded = true),
        )
        assertTrue(flow.isBusy)
    }

    @Test
    fun alreadyInstalledModuleResponseLaunchesPrimaryWithoutWaitingForProgress() {
        val flow = PairingScannerFlow()
        val start = flow.start()
        flow.onModuleAvailability(start.generation, available = false)

        assertEquals(
            PairingScannerCommand.LAUNCH_PRIMARY,
            flow.onModuleInstallAccepted(start.generation, alreadyInstalled = true),
        )
        assertEquals(PairingScannerStage.PRIMARY, flow.stage)
        assertEquals(
            PairingScannerCommand.NONE,
            flow.onModuleInstallFinished(start.generation, succeeded = true),
        )
    }

    @Test
    fun moduleCheckFailureRequestsCameraPermissionForFallback() {
        val flow = PairingScannerFlow()
        val start = flow.start()

        assertEquals(
            PairingScannerCommand.REQUEST_CAMERA_PERMISSION,
            flow.onModuleCheckFailure(start.generation),
        )
        assertEquals(PairingScannerStage.WAITING_CAMERA_PERMISSION, flow.stage)
    }

    @Test
    fun moduleOrPrimaryFailureFallsBackOnlyAfterCameraPermission() {
        val flow = PairingScannerFlow()
        val first = flow.start()
        flow.onModuleAvailability(first.generation, available = false)

        assertEquals(
            PairingScannerCommand.REQUEST_CAMERA_PERMISSION,
            flow.onModuleInstallFinished(first.generation, succeeded = false),
        )
        assertEquals(
            PairingScannerCommand.LAUNCH_BUNDLED,
            flow.onCameraPermissionResult(first.generation, granted = true),
        )
        assertTrue(flow.complete(first.generation))
        assertFalse(flow.isBusy)

        val second = flow.start()
        flow.onModuleAvailability(second.generation, available = true)
        assertEquals(
            PairingScannerCommand.REQUEST_CAMERA_PERMISSION,
            flow.onPrimaryFailure(second.generation),
        )
        assertEquals(
            PairingScannerCommand.PERMISSION_DENIED,
            flow.onCameraPermissionResult(second.generation, granted = false),
        )
        assertFalse(flow.isBusy)
    }

    @Test
    fun staleCallbacksCannotAdvanceAReplacementAttempt() {
        val flow = PairingScannerFlow()
        val stale = flow.start()
        flow.cancel()
        val current = flow.start()

        assertEquals(
            PairingScannerCommand.NONE,
            flow.onModuleAvailability(stale.generation, available = true),
        )
        assertEquals(PairingScannerStage.CHECKING_MODULE, flow.stage)
        assertEquals(
            PairingScannerCommand.LAUNCH_PRIMARY,
            flow.onModuleAvailability(current.generation, available = true),
        )
        assertFalse(flow.complete(stale.generation))
        assertTrue(flow.complete(current.generation))
    }
}
