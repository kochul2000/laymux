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
}

internal fun stringWebMessagePayload(
    messageType: Int,
    stringType: Int,
    readPayload: () -> String?,
): String? = if (messageType == stringType) readPayload() else null
