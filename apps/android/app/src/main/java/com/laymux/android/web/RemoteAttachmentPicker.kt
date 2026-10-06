package com.laymux.android.web

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.core.content.IntentCompat
import java.util.UUID

/** OS URI selection only; the PC-owned Remote page still owns validation/upload. */
class RemoteAttachmentPicker(
    private val activity: Activity,
    private val launch: (Intent) -> Unit,
) {
    private val pending = SinglePendingResult<Array<Uri>>()
    private var sharedUris = emptyList<Uri>()
    private var sharedId: String? = null

    data class SharedOffer(val id: String, val count: Int)

    fun sharedOffer(): SharedOffer? = sharedId?.let { SharedOffer(it, sharedUris.size) }

    fun discardSharedFiles(id: String) {
        if (sharedId != id) return
        sharedUris = emptyList()
        sharedId = null
    }

    fun deliverSharedFiles(id: String, callback: ValueCallback<Array<Uri>>): Boolean {
        if (sharedId != id || sharedUris.isEmpty()) return false
        val files = sharedUris.toTypedArray()
        discardSharedFiles(id)
        pending.replace(callback::onReceiveValue)
        pending.complete(files)
        return true
    }

    fun receiveShare(intent: Intent): Boolean {
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return false
        cancel()
        sharedUris = shareUris(intent)
        sharedId = if (sharedUris.isEmpty()) null else UUID.randomUUID().toString()
        return sharedUris.isNotEmpty()
    }

    /** Opens the system picker directly; its drawer lists galleries and other apps. */
    fun show(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams) {
        cancel()
        if (activity.isFinishing || activity.isDestroyed) {
            callback.onReceiveValue(null)
            return
        }
        pending.replace(callback::onReceiveValue)
        val mimeTypes = params.acceptTypes.flatMap { it.split(',') }
            .mapNotNull(::acceptMimeType).distinct()
        try {
            launch(selectionIntent(mimeTypes, params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE))
        } catch (_: ActivityNotFoundException) {
            pending.cancel()
        }
    }

    fun complete(resultCode: Int, intent: Intent?) {
        pending.complete(resultUris(resultCode, intent)?.toTypedArray())
    }

    fun setReady(ready: Boolean) = pending.setReady(ready)

    fun cancel() {
        pending.cancel()
    }

    companion object {
        private const val MAX_FILES = 64

        fun selectionIntent(mimeTypes: List<String>, multiple: Boolean): Intent =
            Intent(Intent.ACTION_GET_CONTENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = mimeTypes.singleOrNull() ?: "*/*"
                if (mimeTypes.size > 1 && "*/*" !in mimeTypes) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

        fun shareUris(intent: Intent): List<Uri> {
            if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return emptyList()
            return collectUris(intent, includeData = false)
        }

        fun resultUris(resultCode: Int, intent: Intent?): List<Uri>? {
            if (resultCode != Activity.RESULT_OK || intent == null) return null
            return collectUris(intent, includeData = true).takeIf { it.isNotEmpty() }
        }

        private fun collectUris(intent: Intent, includeData: Boolean): List<Uri> {
            val uris = linkedSetOf<Uri>()
            fun add(uri: Uri?) {
                if (uri?.scheme == "content" && uris.size < MAX_FILES) uris.add(uri)
            }
            if (includeData) add(intent.data)
            // Read the declared shape only: EXTRA_STREAM is a list for MULTIPLE.
            runCatching {
                if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
                    IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                        ?.take(MAX_FILES)?.forEach(::add)
                } else {
                    IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(::add)
                }
            }
            intent.clipData?.let { clip ->
                for (index in 0 until minOf(clip.itemCount, MAX_FILES)) add(clip.getItemAt(index).uri)
            }
            return uris.toList()
        }

        private fun acceptMimeType(value: String): String? {
            val trimmed = value.trim().lowercase(java.util.Locale.ROOT)
            if (trimmed.startsWith(".")) return MimeTypeMap.getSingleton()
                .getMimeTypeFromExtension(trimmed.removePrefix(".")) ?: "*/*"
            return trimmed.takeIf { it.contains('/') }
        }
    }
}
