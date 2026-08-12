package com.laymux.android.web

import android.graphics.Bitmap
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.webkit.WebViewClientCompat

class CloudWebViewClient(private val navigation: CloudNavigationPolicy) : WebViewClientCompat() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        !navigation.isAllowed(request.url.toString())

    @Suppress("DEPRECATION")
    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
        !navigation.isAllowed(url)

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        if (!navigation.isAllowed(url)) view.stopLoading()
    }

    @Suppress("DEPRECATION")
    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        handler.cancel()
    }
}
