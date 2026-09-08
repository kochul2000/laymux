package com.laymux.android.web

sealed interface RemoteResourceLoadResult {
    data class Response(val value: RemoteResourceResponse) : RemoteResourceLoadResult

    data object Unavailable : RemoteResourceLoadResult

    data object Cancelled : RemoteResourceLoadResult
}

/** Decides when the native shell must replace an unavailable PC-owned document. */
internal object RemoteDocumentLoadPolicy {
    fun dashboardStatus(isMainFrame: Boolean, result: RemoteResourceLoadResult): Int? {
        if (!isMainFrame) return null
        return when (result) {
            is RemoteResourceLoadResult.Response -> result.value.status.takeIf { it in 400..599 }
            RemoteResourceLoadResult.Unavailable -> 503
            RemoteResourceLoadResult.Cancelled -> null
        }
    }
}
