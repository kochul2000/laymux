package com.laymux.android.web

import android.os.SystemClock
import android.util.Base64
import org.json.JSONObject

/** Serial, bounded reads over the existing AEAD RPC; no key or capability enters app JavaScript. */
internal class LocalhostPreviewTransport(
    private val sessionId: String,
    private val leaseId: String,
    private val current: () -> Boolean,
    private val request: (String, JSONObject) -> JSONObject,
) {
    private var heartbeatAt = SystemClock.elapsedRealtime()
    fun read(path: String): PreviewResource {
        var offset = 0
        var bytes: ByteArray? = null
        var contentType = "application/octet-stream"
        var status = 200
        do {
            check(current()) { "Preview connection changed" }
            if (SystemClock.elapsedRealtime() - heartbeatAt >= 15_000) {
                request("/remote/v1/session/heartbeat", JSONObject().put("leaseId", leaseId))
                heartbeatAt = SystemClock.elapsedRealtime()
            }
            val chunk = request("/remote/v1/localhost-preview/resource", JSONObject()
                .put("sessionId", sessionId).put("leaseId", leaseId)
                .put("pathAndQuery", path).put("offset", offset))
            check(current())
            val total = chunk.getLong("totalBytes")
            check(total in 0..64L * 1024 * 1024)
            if (bytes == null) bytes = ByteArray(total.toInt())
            check(bytes.size == total.toInt() && chunk.getInt("offset") == offset)
            val decoded = Base64.decode(chunk.getString("body"), Base64.DEFAULT)
            val next = chunk.getInt("nextOffset")
            check(next == offset + decoded.size && next <= bytes.size && (next > offset || next == bytes.size))
            decoded.copyInto(bytes, offset)
            offset = next
            contentType = chunk.getString("contentType")
            status = chunk.getInt("status")
        } while (offset < bytes.size)
        return PreviewResource(status, contentType, bytes)
    }
}
