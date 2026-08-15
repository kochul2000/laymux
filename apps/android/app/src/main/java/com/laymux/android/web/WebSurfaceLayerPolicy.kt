package com.laymux.android.web

internal enum class VisibleWebSurface {
    CLOUD,
    PAIRING,
    REMOTE,
}

internal data class WebSurfaceLayers(
    val cloudVisible: Boolean,
    val secureVisible: Boolean,
    val cloudInteractive: Boolean,
    val cloudAccessible: Boolean,
    val cloudBridgeEnabled: Boolean,
)

internal object WebSurfaceLayerPolicy {
    fun forSurface(surface: VisibleWebSurface): WebSurfaceLayers = when (surface) {
        VisibleWebSurface.CLOUD -> WebSurfaceLayers(
            cloudVisible = true,
            secureVisible = false,
            cloudInteractive = true,
            cloudAccessible = true,
            cloudBridgeEnabled = true,
        )
        VisibleWebSurface.PAIRING -> WebSurfaceLayers(
            cloudVisible = true,
            secureVisible = true,
            cloudInteractive = false,
            cloudAccessible = false,
            cloudBridgeEnabled = false,
        )
        VisibleWebSurface.REMOTE -> WebSurfaceLayers(
            cloudVisible = false,
            secureVisible = true,
            cloudInteractive = false,
            cloudAccessible = false,
            cloudBridgeEnabled = false,
        )
    }
}
