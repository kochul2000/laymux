package com.laymux.android.web

import java.net.URI

internal enum class RemoteSurfaceResumeAction {
    NOTIFY_EXISTING_DOCUMENT,
    RELOAD_DOCUMENT,
}

/** Chooses whether foreground recovery can preserve the current Remote document runtime. */
internal object RemoteSurfaceResumePolicy {
    fun action(remoteSurfaceInstalled: Boolean, currentUrl: String?): RemoteSurfaceResumeAction {
        if (!remoteSurfaceInstalled || !isRemoteDocument(currentUrl)) {
            return RemoteSurfaceResumeAction.RELOAD_DOCUMENT
        }
        return RemoteSurfaceResumeAction.NOTIFY_EXISTING_DOCUMENT
    }

    private fun isRemoteDocument(value: String?): Boolean {
        val uri = value?.let { runCatching { URI(it) }.getOrNull() } ?: return false
        return uri.scheme.equals("https", ignoreCase = true) &&
            uri.host.equals(LocalContentWebViewClient.REMOTE_WRAPPER_HOST, ignoreCase = true) &&
            uri.port == -1 &&
            uri.userInfo == null &&
            uri.path?.startsWith(LocalContentWebViewClient.REMOTE_PATH) == true
    }
}
