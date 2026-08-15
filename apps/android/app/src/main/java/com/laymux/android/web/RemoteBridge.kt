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
    fun openRemoteOutput(streamId: String, terminalId: String, leaseId: String) {
        activity.openRemoteOutput(streamId, terminalId, leaseId)
    }

    @JavascriptInterface
    fun closeRemoteOutput(streamId: String) {
        activity.closeRemoteOutput(streamId)
    }

    @JavascriptInterface
    fun disconnectRemote() {
        activity.runOnUiThread(activity::disconnectRemote)
    }
}
