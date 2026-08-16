package com.laymux.android.web

import android.webkit.JavascriptInterface
import com.laymux.android.MainActivity

/** Login/dashboard bridge. It intentionally has no pairing-key or E2E transport methods. */
class CloudBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun signInWithGoogle(nonce: String) {
        if (!CloudBridgeInput.isValidNonce(nonce)) return
        activity.runOnUiThread { activity.signInWithGoogle(nonce) }
    }

    @JavascriptInterface
    fun selectInstance(instanceId: String) {
        if (!CloudBridgeInput.isValidInstanceId(instanceId)) return
        activity.runOnUiThread { activity.selectCloudInstance(instanceId, null) }
    }

    @JavascriptInterface
    fun selectInstanceRoute(instanceId: String, tailscaleUrl: String) {
        if (!CloudBridgeInput.isValidInstanceId(instanceId)) return
        val directUrl = when (val hint = CloudBridgeInput.tailscaleRouteHint(tailscaleUrl)) {
            TailscaleRouteHint.Missing -> null
            is TailscaleRouteHint.Valid -> hint.url
            TailscaleRouteHint.Invalid -> {
                activity.runOnUiThread { activity.rejectInvalidTailscaleRoute() }
                return
            }
        }
        activity.runOnUiThread { activity.selectCloudInstance(instanceId, directUrl) }
    }
}
