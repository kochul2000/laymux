package com.laymux.android.web

internal enum class CloudDocumentPresentation {
    LOADING,
    READY,
    UNAVAILABLE,
}

/**
 * Keeps Chromium's terminal error-page callbacks from replacing the native
 * recovery surface. WebView reports onPageFinished even after some main-frame
 * failures, so a successful finish is only accepted for the active load when
 * that load has not already failed.
 */
internal class CloudDocumentLoadState {
    var presentation: CloudDocumentPresentation = CloudDocumentPresentation.LOADING
        private set

    private var activeGeneration: Long? = null
    private var activeUrl: String? = null
    private var activeLoadFailed = false

    fun started(generation: Long, url: String): CloudDocumentPresentation {
        activeGeneration = generation
        activeUrl = url
        activeLoadFailed = false
        return setPresentation(CloudDocumentPresentation.LOADING)
    }

    fun failed(
        generation: Long,
        url: String,
        isMainFrame: Boolean,
    ): CloudDocumentPresentation? {
        if (!isMainFrame || generation != activeGeneration || url != activeUrl) return null
        activeLoadFailed = true
        return setPresentation(CloudDocumentPresentation.UNAVAILABLE)
    }

    fun finished(generation: Long, url: String): CloudDocumentPresentation? {
        if (generation != activeGeneration || url != activeUrl || activeLoadFailed) return null
        return setPresentation(CloudDocumentPresentation.READY)
    }

    private fun setPresentation(next: CloudDocumentPresentation): CloudDocumentPresentation {
        presentation = next
        return next
    }
}

internal fun beginCloudDocumentNavigation(
    state: CloudDocumentLoadState,
    generation: Long,
    url: String,
    publish: (CloudDocumentPresentation) -> Unit,
    navigate: () -> Unit,
) {
    publish(state.started(generation, url))
    navigate()
}
