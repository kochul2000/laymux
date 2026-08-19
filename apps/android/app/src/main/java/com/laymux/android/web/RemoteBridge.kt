package com.laymux.android.web

import android.webkit.JavascriptInterface
import com.laymux.android.MainActivity

/** PC-provided Remote documents receive transport access, never pairing-vault authority. */
class RemoteBridge(
    private val activity: MainActivity,
    private val documentGeneration: Long,
) {
    /**
     * Feature probe for scroll-top history expansion (ADR-0182). A Remote page
     * only adds `historyKib` to its output open record when this answers true,
     * because older connectors reject an open record with unknown fields.
     */
    @JavascriptInterface
    fun supportsOutputHistoryBudget(): Boolean = true

    @JavascriptInterface
    fun setRemoteLease(leaseId: String?) {
        activity.setRemoteLease(documentGeneration, leaseId)
    }

    @JavascriptInterface
    fun requestRemoteHttp(requestId: String, method: String, path: String, bodyJson: String?) {
        activity.requestRemoteHttp(documentGeneration, requestId, method, path, bodyJson)
    }

    @JavascriptInterface
    fun cancelRemoteHttp(requestId: String) {
        activity.cancelRemoteHttp(documentGeneration, requestId)
    }

    @JavascriptInterface
    fun disconnectRemote() {
        activity.disconnectRemoteFromWeb(documentGeneration)
    }

    @JavascriptInterface
    fun openExternalUrl(url: String?) {
        activity.openExternalUrl(documentGeneration, url ?: return)
    }

    // OAuth loopback relay (ADR-0175): catch the provider's localhost
    // redirect on this device and hand it back to the Remote document.
    @JavascriptInterface
    fun beginOauthRelay(sessionId: String?, port: String?, expectedPath: String?, authUrl: String?) {
        activity.beginOauthRelay(
            documentGeneration,
            sessionId ?: return,
            port ?: return,
            expectedPath ?: return,
            authUrl ?: return,
        )
    }

    @JavascriptInterface
    fun cancelOauthRelay() {
        activity.cancelOauthRelay(documentGeneration)
    }
}

internal fun stringWebMessagePayload(
    messageType: Int,
    stringType: Int,
    readPayload: () -> String?,
): String? = if (messageType == stringType) readPayload() else null
