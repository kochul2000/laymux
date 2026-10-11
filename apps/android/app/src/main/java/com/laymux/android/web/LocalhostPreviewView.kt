package com.laymux.android.web

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.io.ByteArrayInputStream

internal data class PreviewResource(val status: Int, val contentType: String, val bytes: ByteArray)

/** Untrusted web app: no JavaScriptInterface or message bridge is installed. */
@SuppressLint("SetJavaScriptEnabled")
internal class LocalhostPreviewView(context: Context, val sessionId: String, private val startUrl: String, title: String,
    load: (String) -> PreviewResource, close: () -> Unit,
) : LinearLayout(context) {
    val webView = WebView(context)
    init {
        orientation = VERTICAL
        isClickable = true
        val colors = context.obtainStyledAttributes(intArrayOf(android.R.attr.colorBackground))
        setBackgroundColor(colors.getColor(0, android.graphics.Color.parseColor("#181825")))
        colors.recycle()
        val bar = LinearLayout(context)
        bar.addView(TextView(context).apply { text = title; maxLines = 1 }, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(Button(context).apply { text = "닫기"; setOnClickListener { close() } })
        addView(bar, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            databaseEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                LocalhostPreviewPolicy.resourcePath(startUrl, request.url.toString()) == null
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val path = LocalhostPreviewPolicy.resourcePath(startUrl, request.url.toString())
                if (path == null || request.method != "GET") return blocked(403)
                return try {
                    val resource = load(path)
                    WebResourceResponse(resource.contentType.substringBefore(';'), "utf-8", resource.status,
                        "Preview", mapOf("Content-Security-Policy" to CSP,
                            "X-Content-Type-Options" to "nosniff", "Cache-Control" to "no-store"),
                        ByteArrayInputStream(resource.bytes))
                } catch (_: Exception) { blocked(503) }
            }
        }
        addView(webView, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
        webView.loadUrl(startUrl)
    }
    fun destroy() { webView.stopLoading(); webView.destroy() }
    private fun blocked(status: Int) = WebResourceResponse("text/plain", "utf-8", status,
        "Preview unavailable", emptyMap(), ByteArrayInputStream("웹 프리뷰 연결을 확인해 주세요.".toByteArray()))
    companion object {
        private const val CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'"
    }
}
