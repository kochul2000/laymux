package com.laymux.android.remote

import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Phone-side half of the OAuth loopback relay (ADR-0175).
 *
 * A desktop CLI runs the OAuth "installed app" flow and listens on the PC's
 * `localhost:{port}`. The provider, however, redirects the *phone's* browser
 * to `localhost:{port}` — this listener catches that redirect on the phone,
 * hands the path+query to the Remote document (which forwards it to the PC
 * over the authenticated transport), and serves the PC tool's response back
 * to the browser.
 *
 * One relay serves exactly one callback: the first request matching
 * [expectedPath] is handed off, everything else (favicon probes, retries) is
 * answered locally without touching the PC. The listener binds loopback only
 * and dies after [LIFETIME_MS] — it is never a lingering open port.
 */
class OauthLoopbackRelay(
    private val port: Int,
    private val expectedPath: String,
    private val onCallback: (requestId: String, pathAndQuery: String) -> Unit,
    private val onError: (message: String) -> Unit,
) {
    private var serverSocket: ServerSocket? = null
    private val closed = AtomicBoolean(false)
    private val callbackTaken = AtomicBoolean(false)
    private val pending = ConcurrentHashMap<String, Socket>()

    fun start(): Boolean {
        val socket = try {
            ServerSocket().apply {
                soTimeout = LIFETIME_MS
                bind(InetSocketAddress(InetAddress.getLoopbackAddress(), port), BACKLOG)
            }
        } catch (_: IOException) {
            return false
        }
        serverSocket = socket
        thread(name = "oauth-relay-$port", isDaemon = true) { acceptLoop(socket) }
        return true
    }

    /** Serve the PC tool's response to the browser connection [requestId] and shut down. */
    fun complete(requestId: String, status: Int, contentType: String, body: String) {
        val socket = pending.remove(requestId) ?: return
        writeResponse(socket, status, contentType, body)
        stop()
    }

    fun stop() {
        if (!closed.compareAndSet(false, true)) return
        try {
            serverSocket?.close()
        } catch (_: IOException) {
        }
        for (socket in pending.values) {
            closeQuietly(socket)
        }
        pending.clear()
    }

    private fun acceptLoop(server: ServerSocket) {
        while (!closed.get()) {
            val socket = try {
                server.accept()
            } catch (_: IOException) {
                // Closed by stop(), or the lifetime soTimeout elapsed. Either
                // way this relay is done; only the timeout is worth surfacing.
                if (closed.compareAndSet(false, true)) {
                    onError("Sign-in timed out before the browser returned.")
                    stopAfterTimeout(server)
                }
                return
            }
            handleConnection(socket)
        }
        closeQuietly(server)
    }

    private fun stopAfterTimeout(server: ServerSocket) {
        closeQuietly(server)
        for (socket in pending.values) {
            closeQuietly(socket)
        }
        pending.clear()
    }

    private fun handleConnection(socket: Socket) {
        val requestTarget = try {
            socket.soTimeout = REQUEST_READ_TIMEOUT_MS
            readRequestTarget(socket.getInputStream())
        } catch (_: IOException) {
            null
        }
        if (requestTarget == null) {
            writeResponse(socket, 400, "text/plain", "Bad request.")
            return
        }
        val pathOnly = requestTarget.substringBefore('?')
        if (pathOnly != expectedPath) {
            writeResponse(socket, 404, "text/plain", "Not found.")
            return
        }
        if (!callbackTaken.compareAndSet(false, true)) {
            writeResponse(socket, 409, "text/plain", "The sign-in callback was already delivered.")
            return
        }
        val requestId = UUID.randomUUID().toString()
        pending[requestId] = socket
        onCallback(requestId, requestTarget)
    }

    /** Parse `GET <target> HTTP/1.1` from the request line; null for anything else. */
    private fun readRequestTarget(input: InputStream): String? {
        val line = readLine(input) ?: return null
        val parts = line.split(' ')
        if (parts.size < 3 || parts[0] != "GET") return null
        val target = parts[1]
        if (target.length > MAX_TARGET_LENGTH || !target.startsWith('/')) return null
        return target
    }

    private fun readLine(input: InputStream): String? {
        val buffer = StringBuilder()
        while (buffer.length <= MAX_TARGET_LENGTH + 64) {
            val byte = input.read()
            if (byte == -1) return null
            if (byte == '\n'.code) break
            if (byte != '\r'.code) buffer.append(byte.toChar())
        }
        return buffer.toString()
    }

    private fun writeResponse(socket: Socket, status: Int, contentType: String, body: String) {
        try {
            val payload = body.toByteArray(StandardCharsets.UTF_8)
            val statusText = if (status == 200) "OK" else "Status"
            val header = "HTTP/1.1 $status $statusText\r\n" +
                "content-type: $contentType; charset=utf-8\r\n" +
                "content-length: ${payload.size}\r\n" +
                "connection: close\r\n\r\n"
            socket.getOutputStream().apply {
                write(header.toByteArray(StandardCharsets.US_ASCII))
                write(payload)
                flush()
            }
        } catch (_: IOException) {
        } finally {
            closeQuietly(socket)
        }
    }

    private fun closeQuietly(socket: Socket) {
        try {
            socket.close()
        } catch (_: IOException) {
        }
    }

    private fun closeQuietly(server: ServerSocket) {
        try {
            server.close()
        } catch (_: IOException) {
        }
    }

    private companion object {
        /** Matches the desktop session TTL — a stale relay is pure attack surface. */
        const val LIFETIME_MS = 10 * 60 * 1000
        const val REQUEST_READ_TIMEOUT_MS = 5_000
        const val BACKLOG = 4
        /** Matches the desktop `MAX_PATH_AND_QUERY_LEN`. */
        const val MAX_TARGET_LENGTH = 4096
    }
}
