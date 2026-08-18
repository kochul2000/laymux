package com.laymux.android.web

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebSurfaceLayerPolicyTest {
    @Test
    fun pairingKeepsCloudVisibleButInertBelowTheNativeSheet() {
        val layers = WebSurfaceLayerPolicy.forSurface(VisibleWebSurface.PAIRING)

        assertTrue(layers.cloudVisible)
        assertFalse(layers.secureVisible)
        assertFalse(layers.cloudInteractive)
        assertFalse(layers.cloudAccessible)
        assertFalse(layers.cloudBridgeEnabled)
        assertFalse(layers.remoteBridgeEnabled)
    }

    @Test
    fun cloudDashboardIsTheOnlyInteractiveSurfaceAfterDismissal() {
        val layers = WebSurfaceLayerPolicy.forSurface(VisibleWebSurface.CLOUD)

        assertTrue(layers.cloudVisible)
        assertFalse(layers.secureVisible)
        assertTrue(layers.cloudInteractive)
        assertTrue(layers.cloudAccessible)
        assertTrue(layers.cloudBridgeEnabled)
        assertFalse(layers.remoteBridgeEnabled)
    }

    @Test
    fun remoteHidesTheCloudSurfaceAndKeepsItInert() {
        val layers = WebSurfaceLayerPolicy.forSurface(VisibleWebSurface.REMOTE)

        assertFalse(layers.cloudVisible)
        assertTrue(layers.secureVisible)
        assertFalse(layers.cloudInteractive)
        assertFalse(layers.cloudAccessible)
        assertFalse(layers.cloudBridgeEnabled)
        assertTrue(layers.remoteBridgeEnabled)
    }

    @Test
    fun connectionSettingsKeepDashboardVisibleButBlockBothBridges() {
        val layers = WebSurfaceLayerPolicy.forSurface(VisibleWebSurface.CONNECTION_SETTINGS)

        assertTrue(layers.cloudVisible)
        assertFalse(layers.secureVisible)
        assertFalse(layers.cloudInteractive)
        assertFalse(layers.cloudAccessible)
        assertFalse(layers.cloudBridgeEnabled)
        assertFalse(layers.remoteBridgeEnabled)
    }
}
