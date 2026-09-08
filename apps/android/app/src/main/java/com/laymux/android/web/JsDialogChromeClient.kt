package com.laymux.android.web

import android.app.Activity
import android.app.AlertDialog
import android.net.Uri
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView

/**
 * WebView ships no UI for `window.alert`/`window.confirm`: without a
 * WebChromeClient it auto-cancels them silently, so page flows gated behind
 * `confirm()` (e.g. the Remote page's PC update install) become dead buttons.
 * One instance serves one WebView — WebView pauses page JS while a JS dialog
 * is pending, so at most one dialog is active per instance.
 */
class JsDialogChromeClient(
    private val activity: Activity,
    private val showFileChooser: ((ValueCallback<Array<Uri>>, FileChooserParams) -> Unit)? = null,
) : WebChromeClient() {
    private var activeDialog: AlertDialog? = null

    override fun onJsAlert(
        view: WebView?,
        url: String?,
        message: String?,
        result: JsResult,
    ): Boolean = show(message, result, withCancel = false)

    override fun onJsConfirm(
        view: WebView?,
        url: String?,
        message: String?,
        result: JsResult,
    ): Boolean = show(message, result, withCancel = true)

    override fun onShowFileChooser(
        webView: WebView?,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams,
    ): Boolean {
        if (activity.isFinishing || activity.isDestroyed || showFileChooser == null) {
            filePathCallback.onReceiveValue(null)
            return true
        }
        showFileChooser.invoke(filePathCallback, fileChooserParams)
        return true
    }

    /** Dismiss a pending dialog so a destroyed activity does not leak its window. */
    fun dismissActive() {
        activeDialog?.dismiss()
        activeDialog = null
    }

    private fun show(message: String?, result: JsResult, withCancel: Boolean): Boolean {
        if (activity.isFinishing || activity.isDestroyed) {
            result.cancel()
            return true
        }
        // The JsResult must complete exactly once no matter how the dialog
        // closes (button, back gesture, dismissActive), or the WebView hangs.
        var completed = false
        fun complete(confirmed: Boolean) {
            if (completed) return
            completed = true
            if (confirmed) result.confirm() else result.cancel()
        }

        val builder = AlertDialog.Builder(activity)
            .setMessage(message.orEmpty())
            .setPositiveButton(android.R.string.ok) { _, _ -> complete(true) }
        if (withCancel) {
            builder.setNegativeButton(android.R.string.cancel) { _, _ -> complete(false) }
        }
        activeDialog = builder.create().apply {
            setOnDismissListener {
                activeDialog = null
                complete(false)
            }
            show()
        }
        return true
    }
}
