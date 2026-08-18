package com.laymux.android.remote

import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Phone-side half of the OAuth loopback relay (ADR-0175).
 *
 * A desktop CLI runs the OAuth "installed app" flow and listens on the PC's
 * `localhost:{port}`. The provider, however, redirects the *phone's* browser
 * to `localhost:{port}` — this listener catches that redirect on the phone
 * and hands the path+query to [onCallback].
 *
 * The browser gets an immediate static "return to the app" page: while the
 * OS browser is frontmost this activity is stopped and the E2E session is
 * suspended (ADR-0146 stops new RPCs in the background), so the forward to
 * the PC happens only after the user returns to the app. Holding the socket
 * until then would just leave the browser spinning.
 *
 * One relay serves exactly one callback: the first request matching
 * [expectedPath] shuts the listener down; everything else (favicon probes,
 * retries) is answered locally without touching the PC. The listener binds
 * loopback only and dies at an absolute deadline [lifetimeMs] after start —
 * repeated unrelated requests must not be able to keep the port open, so the
 * deadline never resets.
 */
class OauthLoopbackRelay(
    private val port: Int,
    private val expectedPath: String,
    private val onCallback: (pathAndQuery: String) -> Unit,
    private val onError: (message: String) -> Unit,
    private val lifetimeMs: Long = DEFAULT_LIFETIME_MS,
) {
    private var serverSocket: ServerSocket? = null
    private val closed = AtomicBoolean(false)
    private val callbackTaken = AtomicBoolean(false)
    private var deadlineAtMs: Long = 0L

    fun start(): Boolean {
        val socket = try {
            ServerSocket().apply {
                bind(InetSocketAddress(InetAddress.getLoopbackAddress(), port), BACKLOG)
            }
        } catch (_: IOException) {
            return false
        }
        deadlineAtMs = System.currentTimeMillis() + lifetimeMs
        serverSocket = socket
        thread(name = "oauth-relay-$port", isDaemon = true) { acceptLoop(socket) }
        return true
    }

    fun stop() {
        if (!closed.compareAndSet(false, true)) return
        closeQuietly()
    }

    private fun acceptLoop(server: ServerSocket) {
        while (!closed.get()) {
            val remainingMs = deadlineAtMs - System.currentTimeMillis()
            if (remainingMs <= 0) {
                expire()
                return
            }
            // soTimeout bounds one accept() wait; computing it from the
            // absolute deadline each round is what makes the lifetime a hard
            // ceiling instead of an idle timeout.
            server.soTimeout = remainingMs.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
            val socket = try {
                server.accept()
            } catch (_: IOException) {
                // Closed by stop(), or this round's soTimeout fired.
                if (!closed.get() && System.currentTimeMillis() >= deadlineAtMs) expire()
                return
            }
            handleConnection(socket)
        }
        closeQuietly()
    }

    private fun expire() {
        if (closed.compareAndSet(false, true)) {
            onError("Sign-in timed out before the browser returned.")
        }
        closeQuietly()
    }

    private fun handleConnection(socket: Socket) {
        val requestTarget = try {
            socket.soTimeout = REQUEST_READ_TIMEOUT_MS
            readRequestTarget(socket.getInputStream())
        } catch (_: IOException) {
            null
        }
        if (requestTarget == null) {
            writeResponse(socket, 400, "Bad request.")
            return
        }
        val pathOnly = requestTarget.substringBefore('?')
        if (pathOnly != expectedPath) {
            writeResponse(socket, 404, "Not found.")
            return
        }
        if (!callbackTaken.compareAndSet(false, true)) {
            writeResponse(socket, 409, "The sign-in callback was already delivered.")
            return
        }
        writeResponse(
            socket,
            200,
            "Sign-in received. Returning you to the Laymux app to finish — " +
                "if it does not come forward, switch back to it manually.",
        )
        stop()
        onCallback(requestTarget)
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

    private fun writeResponse(socket: Socket, status: Int, body: String) {
        try {
            val payload = "<html><body>$body</body></html>".toByteArray(StandardCharsets.UTF_8)
            val statusText = if (status == 200) "OK" else "Status"
            val header = "HTTP/1.1 $status $statusText\r\n" +
                "content-type: text/html; charset=utf-8\r\n" +
                "content-length: ${payload.size}\r\n" +
                "connection: close\r\n\r\n"
            socket.getOutputStream().apply {
                write(header.toByteArray(StandardCharsets.US_ASCII))
                write(payload)
                flush()
            }
        } catch (_: IOException) {
        } finally {
            try {
                socket.close()
            } catch (_: IOException) {
            }
        }
    }

    private fun closeQuietly() {
        try {
            serverSocket?.close()
        } catch (_: IOException) {
        }
    }

    private companion object {
        /** Matches the desktop session TTL — a stale relay is pure attack surface. */
        const val DEFAULT_LIFETIME_MS = 10 * 60 * 1000L
        const val REQUEST_READ_TIMEOUT_MS = 5_000
        const val BACKLOG = 4
        /** Matches the desktop `MAX_PATH_AND_QUERY_LEN`. */
        const val MAX_TARGET_LENGTH = 4096
    }
}
