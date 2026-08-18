package com.laymux.android.web

import android.webkit.JavascriptInterface
import com.laymux.android.MainActivity

/** PC-provided Remote documents receive transport access, never pairing-vault authority. */
class RemoteBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun setRemoteLease(leaseId: String?) {
        activity.setRemoteLease(leaseId)
    }

    @JavascriptInterface
    fun requestRemoteHttp(requestId: String, method: String, path: String, bodyJson: String?) {
        activity.requestRemoteHttp(requestId, method, path, bodyJson)
    }

    @JavascriptInterface
    fun cancelRemoteHttp(requestId: String) {
        activity.cancelRemoteHttp(requestId)
    }

    @JavascriptInterface
    fun disconnectRemote() {
        activity.runOnUiThread(activity::disconnectRemote)
    }

    @JavascriptInterface
    fun openExternalUrl(url: String?) {
        activity.openExternalUrl(url ?: return)
    }

    // OAuth loopback relay (ADR-0175): catch the provider's localhost
    // redirect on this device and hand it back to the Remote document.
    @JavascriptInterface
    fun beginOauthRelay(sessionId: String?, port: String?, expectedPath: String?, authUrl: String?) {
        activity.beginOauthRelay(
            sessionId ?: return,
            port ?: return,
            expectedPath ?: return,
            authUrl ?: return,
        )
    }

    @JavascriptInterface
    fun completeOauthRelay(requestId: String?, status: String?, contentType: String?, body: String?) {
        activity.completeOauthRelay(
            requestId ?: return,
            status ?: return,
            contentType ?: return,
            body ?: return,
        )
    }

    @JavascriptInterface
    fun cancelOauthRelay() {
        activity.cancelOauthRelay()
    }
}

internal fun stringWebMessagePayload(
    messageType: Int,
    stringType: Int,
    readPayload: () -> String?,
): String? = if (messageType == stringType) readPayload() else null
