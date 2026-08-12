package com.laymux.android.web

import android.graphics.Bitmap
import android.net.Uri
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import java.io.ByteArrayInputStream

/** Serves the APK bootstrap and AEAD-authenticated Remote resources on separate local origins. */
class LocalContentWebViewClient(
    private val assetLoader: WebViewAssetLoader,
    private val remoteResourceLoader: (String) -> RemoteResourceResponse?,
) : WebViewClientCompat() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        !isAllowedOrigin(request.url)

    @Suppress("DEPRECATION")
    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
        !isAllowedOrigin(Uri.parse(url))

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse = intercept(request.url)

    @Suppress("DEPRECATION")
    override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse =
        intercept(Uri.parse(url))

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        if (!isAllowedOrigin(Uri.parse(url))) {
            view.stopLoading()
        }
    }

    @Suppress("DEPRECATION")
    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
        handler.cancel()
    }

    private fun intercept(uri: Uri): WebResourceResponse {
        if (isLocalAsset(uri)) {
            assetLoader.shouldInterceptRequest(uri)?.let { return it }
        }
        if (isRemoteWrapperResource(uri)) {
            val resource = remoteResourceLoader(requireNotNull(uri.encodedPath))
            if (resource != null) {
                return WebResourceResponse(
                    resource.mimeType,
                    resource.encoding,
                    resource.status,
                    reasonPhrase(resource.status),
                    resource.headers,
                    ByteArrayInputStream(resource.body),
                )
            }
            return blockedResponse(503, "E2E session unavailable")
        }
        return blockedResponse(403, "Blocked")
    }

    private fun blockedResponse(status: Int, reason: String): WebResourceResponse =
        WebResourceResponse(
            "text/plain",
            "utf-8",
            status,
            reason,
            emptyMap(),
            ByteArrayInputStream(ByteArray(0)),
        )

    private fun reasonPhrase(status: Int): String = when (status) {
        200 -> "OK"
        204 -> "No Content"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        410 -> "Gone"
        500 -> "Internal Server Error"
        503 -> "Service Unavailable"
        else -> "Remote Response"
    }

    private fun isLocalAsset(uri: Uri): Boolean =
        uri.scheme == "https" &&
            uri.host == APP_ASSET_HOST &&
            uri.path?.startsWith(ASSET_PATH) == true &&
            uri.userInfo == null &&
            uri.port == -1

    private fun isRemoteWrapperResource(uri: Uri): Boolean =
        uri.scheme == "https" &&
            uri.host == REMOTE_WRAPPER_HOST &&
            uri.path?.startsWith(REMOTE_PATH) == true &&
            uri.userInfo == null &&
            uri.port == -1

    private fun isAllowedOrigin(uri: Uri): Boolean =
        isLocalAsset(uri) || isRemoteWrapperResource(uri)

    companion object {
        const val APP_ASSET_HOST = "appassets.androidplatform.net"
        const val ASSET_PATH = "/assets/"
        const val START_URL = "https://$APP_ASSET_HOST${ASSET_PATH}index.html"
        const val REMOTE_WRAPPER_HOST = "remote.laymux.invalid"
        const val REMOTE_PATH = "/remote/"
        const val REMOTE_START_URL =
            "https://$REMOTE_WRAPPER_HOST${REMOTE_PATH}?androidE2e=1&autoConnect=1"
    }
}
