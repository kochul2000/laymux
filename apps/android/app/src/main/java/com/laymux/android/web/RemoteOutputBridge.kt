package com.laymux.android.web

import org.json.JSONObject

internal object RemoteOutputBridge {
    fun script(
        data: String,
        reset: Boolean,
        cols: Int,
        rows: Int,
        bracketedPaste: Boolean?,
    ): String {
        val mode = bracketedPaste?.toString() ?: "null"
        return "if (window.laymuxNative) window.laymuxNative.onRemoteOutput(" +
            "${JSONObject.quote(data)},$reset,$cols,$rows,$mode);"
    }
}
