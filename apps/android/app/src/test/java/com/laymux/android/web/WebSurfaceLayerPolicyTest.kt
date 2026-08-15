package com.laymux.android.web

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebSurfaceLayerPolicyTest {
    @Test
    fun pairingKeepsCloudVisibleButInertBelowTheSecureSurface() {
        val layers = WebSurfaceLayerPolicy.forSurface(VisibleWebSurface.PAIRING)

        assertTrue(layers.cloudVisible)
        assertTrue(layers.secureVisible)
        assertFalse(layers.cloudInteractive)
        assertFalse(layers.cloudAccessible)
        assertFalse(layers.cloudBridgeEnabled)
    }

    @Test
    fun cloudDashboardIsTheOnlyInteractiveSurfaceAfterDismissal() {
        val layers = WebSurfaceLayerPolicy.forSurface(VisibleWebSurface.CLOUD)

        assertTrue(layers.cloudVisible)
        assertFalse(layers.secureVisible)
        assertTrue(layers.cloudInteractive)
        assertTrue(layers.cloudAccessible)
        assertTrue(layers.cloudBridgeEnabled)
    }

    @Test
    fun remoteHidesTheCloudSurfaceAndKeepsItInert() {
        val layers = WebSurfaceLayerPolicy.forSurface(VisibleWebSurface.REMOTE)

        assertFalse(layers.cloudVisible)
        assertTrue(layers.secureVisible)
        assertFalse(layers.cloudInteractive)
        assertFalse(layers.cloudAccessible)
        assertFalse(layers.cloudBridgeEnabled)
    }
}
