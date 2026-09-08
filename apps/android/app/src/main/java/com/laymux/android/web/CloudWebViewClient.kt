package com.laymux.android.web

import android.graphics.Bitmap
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.WebResourceErrorCompat
import androidx.webkit.WebViewClientCompat

internal class CloudWebViewClient(
    private val navigation: CloudNavigationPolicy,
    private val documentGeneration: Long,
    private val documentLoadState: CloudDocumentLoadState,
    private val onDocumentPresentationChanged: (CloudDocumentPresentation) -> Unit = {},
) : WebViewClientCompat() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        !navigation.isAllowed(request.url.toString())

    @Suppress("DEPRECATION")
    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
        !navigation.isAllowed(url)

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        if (!navigation.isAllowed(url)) {
            view.stopLoading()
            return
        }
        onDocumentPresentationChanged(documentLoadState.started(documentGeneration, url))
    }

    override fun onPageFinished(view: WebView, url: String) {
        documentLoadState.finished(documentGeneration, url)
            ?.let(onDocumentPresentationChanged)
    }

    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceErrorCompat,
    ) {
        documentLoadState.failed(
            documentGeneration,
            request.url.toString(),
            request.isForMainFrame,
        )?.let(onDocumentPresentationChanged)
    }

    override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest,
        errorResponse: WebResourceResponse,
    ) {
        documentLoadState.failed(
            documentGeneration,
            request.url.toString(),
            request.isForMainFrame,
        )?.let(onDocumentPresentationChanged)
    }

    @Suppress("DEPRECATION")
    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        handler.cancel()
        documentLoadState.failed(documentGeneration, error.url, isMainFrame = true)
            ?.let(onDocumentPresentationChanged)
    }
}
