package com.laymux.android.web

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.util.Base64
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.util.UUID

/** Original bytes stay private; only the chosen viewer receives temporary read access. */
object RemoteFileOpener {
    private const val RETENTION_MILLIS = 24 * 60 * 60 * 1000L

    fun prepare(context: Context, name: String, mediaType: String, base64: String): Intent {
        require(RemoteDownloadPolicy.isEncodedPayloadWithinBound(base64.length)) { "파일이 전송 한도를 넘었습니다." }
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        require(RemoteDownloadPolicy.isWithinBound(bytes.size)) { "파일이 전송 한도를 넘었습니다." }
        val root = File(context.cacheDir, "remote-open")
        if (!root.isDirectory && !root.mkdirs()) throw IOException("Cannot create viewer cache")
        val cutoff = System.currentTimeMillis() - RETENTION_MILLIS
        root.listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.deleteRecursively() }
        val directory = File(root, UUID.randomUUID().toString())
        if (!directory.mkdir()) throw IOException("Cannot create file directory")
        try {
            val file = File(directory, RemoteDownloadPolicy.safeDisplayName(name))
            file.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.remote-files", file)
            return Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mediaType.ifBlank { "application/octet-stream" })
                clipData = ClipData.newRawUri(file.name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        } catch (error: Exception) {
            directory.deleteRecursively()
            throw error
        }
    }
}
