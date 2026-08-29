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

    private var activeUrl: String? = null
    private var activeLoadFailed = false

    fun started(url: String): CloudDocumentPresentation {
        activeUrl = url
        activeLoadFailed = false
        return setPresentation(CloudDocumentPresentation.LOADING)
    }

    fun failed(url: String, isMainFrame: Boolean): CloudDocumentPresentation? {
        if (!isMainFrame || url != activeUrl) return null
        activeLoadFailed = true
        return setPresentation(CloudDocumentPresentation.UNAVAILABLE)
    }

    fun finished(url: String): CloudDocumentPresentation? {
        if (url != activeUrl || activeLoadFailed) return null
        return setPresentation(CloudDocumentPresentation.READY)
    }

    private fun setPresentation(next: CloudDocumentPresentation): CloudDocumentPresentation {
        presentation = next
        return next
    }
}
