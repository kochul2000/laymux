package com.laymux.android.remote

import java.net.URI
import java.security.SecureRandom
import java.util.ArrayDeque
import java.util.Arrays
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

interface E2eOutputSocketCallbacks {
    fun onOpen(socket: E2eOutputSocket, streamId: String)
    fun onRecord(socket: E2eOutputSocket, streamId: String, plaintext: ByteArray)
    fun onClose(socket: E2eOutputSocket, streamId: String, reason: String, isError: Boolean)
}

class E2eOutputSocket internal constructor(
    private val streamId: String,
    private val terminalId: String,
    private val leaseId: String,
    private val session: RemoteSession,
    private val client: OkHttpClient,
    private val callbacks: E2eOutputSocketCallbacks,
    random: SecureRandom = SecureRandom(),
) : WebSocketListener() {
    private val streamNonce = ByteArray(E2eOutputProtocol.STREAM_NONCE_BYTES)
        .also(random::nextBytes)
        .let { bytes ->
            try {
                E2eProtocol.encode(bytes)
            } finally {
                Arrays.fill(bytes, 0)
            }
        }
    private val cipher = session.openOutputCipher(streamNonce)
    private val closed = AtomicBoolean(false)
    private val pending = ArrayDeque<ByteArray>()
    private var pendingBytes = 0
    private var awaitingAck = false
    @Volatile private var webSocket: WebSocket? = null

    fun connect() {
        try {
            session.requireTransportAllowed()
            webSocket = client.newWebSocket(Request.Builder().url(outputUrl()).build(), this)
        } catch (error: Throwable) {
            disconnect()
            throw error
        }
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        if (closed.get()) {
            webSocket.close(1000, null)
            return
        }
        val open = cipher.encryptOpen(terminalId, leaseId)
        try {
            if (!webSocket.send(open.toByteString())) {
                fail("Secure output OPEN could not be sent.")
                return
            }
        } finally {
            Arrays.fill(open, 0)
        }
        callbacks.onOpen(this, streamId)
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        val encrypted = bytes.toByteArray()
        val plaintext = try {
            cipher.decryptResponse(encrypted)
        } catch (error: Throwable) {
            Arrays.fill(encrypted, 0)
            fail(error.message ?: "Secure output authentication failed.")
            return
        }
        Arrays.fill(encrypted, 0)
        var overflow = false
        val dispatch = synchronized(this) {
            if (closed.get()) {
                Arrays.fill(plaintext, 0)
                null
            } else if (pendingBytes > MAX_PENDING_BYTES - plaintext.size) {
                Arrays.fill(plaintext, 0)
                overflow = true
                null
            } else {
                pending.addLast(plaintext)
                pendingBytes += plaintext.size
                nextRecordLocked()
            }
        }
        if (dispatch != null) {
            callbacks.onRecord(this, streamId, dispatch)
        } else if (overflow) {
            fail("Secure output bridge backpressure limit was exceeded.")
        }
    }

    fun acknowledge() {
        val dispatch = synchronized(this) {
            if (!awaitingAck || pending.isEmpty()) return
            val completed = pending.removeFirst()
            pendingBytes -= completed.size
            Arrays.fill(completed, 0)
            awaitingAck = false
            nextRecordLocked()
        }
        if (dispatch != null) callbacks.onRecord(this, streamId, dispatch)
    }

    fun disconnect() {
        if (closed.compareAndSet(false, true)) {
            webSocket?.close(1000, null)
            clearSecrets()
        }
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        finish(reason.ifBlank { "Secure output closed." }, false)
    }

    override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
        fail(error.message ?: "Secure output transport failed.")
    }

    private fun fail(reason: String) {
        webSocket?.cancel()
        finish(reason, true)
    }

    private fun finish(reason: String, isError: Boolean) {
        if (!closed.compareAndSet(false, true)) return
        clearSecrets()
        callbacks.onClose(this, streamId, reason, isError)
    }

    @Synchronized
    private fun clearSecrets() {
        while (pending.isNotEmpty()) Arrays.fill(pending.removeFirst(), 0)
        pendingBytes = 0
        awaitingAck = false
        cipher.close()
    }

    private fun nextRecordLocked(): ByteArray? {
        if (awaitingAck || pending.isEmpty()) return null
        awaitingAck = true
        return pending.first()
    }

    private fun outputUrl(): String {
        val endpoint = URI(session.endpoint)
        val scheme = when (endpoint.scheme.lowercase()) {
            "https" -> "wss"
            "http" -> "ws"
            else -> throw E2eProtocolException("Secure output endpoint is invalid.", true)
        }
        return URI(
            scheme,
            endpoint.rawAuthority,
            "/api/android/e2e/output",
            "instanceId=${session.instanceId}&sessionId=${session.sessionId}&streamNonce=$streamNonce",
            null,
        ).toASCIIString()
    }

    companion object {
        private const val MAX_PENDING_BYTES = 2 * 1024 * 1024
    }
}
