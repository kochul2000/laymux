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

/** Allows signed APK assets only; remote HTML and scripts never enter this WebView. */
class LocalContentWebViewClient(
    private val assetLoader: WebViewAssetLoader,
) : WebViewClientCompat() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        !isLocalAsset(request.url)

    @Suppress("DEPRECATION")
    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
        !isLocalAsset(Uri.parse(url))

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse = intercept(request.url)

    @Suppress("DEPRECATION")
    override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse =
        intercept(Uri.parse(url))

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        if (!isLocalAsset(Uri.parse(url))) {
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
        return WebResourceResponse(
            "text/plain",
            "utf-8",
            403,
            "Blocked",
            emptyMap(),
            ByteArrayInputStream(ByteArray(0)),
        )
    }

    private fun isLocalAsset(uri: Uri): Boolean =
        uri.scheme == "https" &&
            uri.host == APP_ASSET_HOST &&
            uri.path?.startsWith(ASSET_PATH) == true &&
            uri.userInfo == null &&
            uri.port == -1

    companion object {
        const val APP_ASSET_HOST = "appassets.androidplatform.net"
        const val ASSET_PATH = "/assets/"
        const val START_URL = "https://$APP_ASSET_HOST${ASSET_PATH}index.html"
    }
}
