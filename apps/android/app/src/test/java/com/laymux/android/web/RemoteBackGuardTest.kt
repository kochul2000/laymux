package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Test

class RemoteBackGuardTest {
    @Test
    fun firstPressWarnsAndASecondInsideTheWindowLeaves() {
        val guard = RemoteBackGuard(windowMillis = 2_000)

        assertEquals(RemoteBackGuard.Action.WARN, guard.onBackPressed(10_000))
        assertEquals(RemoteBackGuard.Action.LEAVE, guard.onBackPressed(11_999))
        // The pair is consumed: the next press starts a fresh warning.
        assertEquals(RemoteBackGuard.Action.WARN, guard.onBackPressed(12_100))
    }

    @Test
    fun anExpiredWarningOnlyWarnsAgain() {
        val guard = RemoteBackGuard(windowMillis = 2_000)

        assertEquals(RemoteBackGuard.Action.WARN, guard.onBackPressed(10_000))
        assertEquals(RemoteBackGuard.Action.WARN, guard.onBackPressed(12_001))
        assertEquals(RemoteBackGuard.Action.LEAVE, guard.onBackPressed(13_000))
    }

    @Test
    fun resetDiscardsThePendingWarning() {
        val guard = RemoteBackGuard(windowMillis = 2_000)

        assertEquals(RemoteBackGuard.Action.WARN, guard.onBackPressed(10_000))
        guard.reset()
        assertEquals(RemoteBackGuard.Action.WARN, guard.onBackPressed(10_500))
    }

    @Test
    fun aDismissedRemoteLayerConsumesBackAndDisarmsAnEarlierWarning() {
        val guard = RemoteBackGuard(windowMillis = 2_000)

        assertEquals(RemoteBackGuard.Action.WARN, guard.onBackPressed(10_000))
        assertEquals(
            RemoteBackGuard.Action.DISMISS,
            guard.onBackPressed(10_500, remoteLayerDismissed = true),
        )
        assertEquals(RemoteBackGuard.Action.WARN, guard.onBackPressed(10_600))
    }
}
