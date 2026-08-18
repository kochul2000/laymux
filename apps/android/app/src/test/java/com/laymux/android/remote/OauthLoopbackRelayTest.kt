package com.laymux.android.remote

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ConnectException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class OauthLoopbackRelayTest {
    private var relay: OauthLoopbackRelay? = null

    @After
    fun tearDown() {
        relay?.stop()
        relay = null
    }

    private fun freePort(): Int = ServerSocket(0).use { it.localPort }

    private data class Callback(val requestId: String, val pathAndQuery: String)

    private fun startRelay(
        port: Int,
        expectedPath: String = "/",
        callbacks: LinkedBlockingQueue<Callback> = LinkedBlockingQueue(),
        errors: LinkedBlockingQueue<String> = LinkedBlockingQueue(),
    ): Triple<OauthLoopbackRelay, LinkedBlockingQueue<Callback>, LinkedBlockingQueue<String>> {
        val started = OauthLoopbackRelay(
            port = port,
            expectedPath = expectedPath,
            onCallback = { requestId, pathAndQuery ->
                callbacks.add(Callback(requestId, pathAndQuery))
            },
            onError = { message -> errors.add(message) },
        )
        assertTrue("relay should bind $port", started.start())
        relay = started
        return Triple(started, callbacks, errors)
    }

    private fun request(port: Int, requestLine: String): Pair<Socket, BufferedReader> {
        val socket = Socket(InetAddress.getLoopbackAddress(), port)
        socket.soTimeout = 5_000
        socket.getOutputStream().write(
            "$requestLine\r\nhost: localhost:$port\r\n\r\n".toByteArray(StandardCharsets.US_ASCII),
        )
        socket.getOutputStream().flush()
        return socket to BufferedReader(InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))
    }

    @Test
    fun `matching callback is handed off and completed response reaches the browser`() {
        val port = freePort()
        val (started, callbacks, _) = startRelay(port)

        val (socket, reader) = request(port, "GET /?code=4%2Fabc&scope=openid HTTP/1.1")
        val callback = callbacks.poll(5, TimeUnit.SECONDS)
        assertNotNull("callback should be delivered", callback)
        assertEquals("/?code=4%2Fabc&scope=openid", callback!!.pathAndQuery)

        started.complete(callback.requestId, 200, "text/plain", "done")

        val statusLine = reader.readLine()
        assertEquals("HTTP/1.1 200 OK", statusLine)
        var line = reader.readLine()
        while (!line.isNullOrEmpty()) line = reader.readLine()
        assertEquals("done", reader.readLine())
        socket.close()

        // Completing the one callback shuts the listener down.
        var refused = false
        try {
            Socket(InetAddress.getLoopbackAddress(), port).close()
        } catch (_: ConnectException) {
            refused = true
        }
        assertTrue("listener should be closed after completion", refused)
    }

    @Test
    fun `non matching path is answered locally without a callback`() {
        val port = freePort()
        val (_, callbacks, _) = startRelay(port, expectedPath = "/cb")

        val (socket, reader) = request(port, "GET /favicon.ico HTTP/1.1")
        assertEquals("HTTP/1.1 404 Status", reader.readLine())
        socket.close()
        assertNull(callbacks.poll(300, TimeUnit.MILLISECONDS))

        // The relay keeps listening for the real callback afterwards.
        val (second, secondReader) = request(port, "GET /cb?code=x HTTP/1.1")
        val callback = callbacks.poll(5, TimeUnit.SECONDS)
        assertNotNull(callback)
        assertEquals("/cb?code=x", callback!!.pathAndQuery)
        relay?.complete(callback.requestId, 200, "text/plain", "ok")
        assertEquals("HTTP/1.1 200 OK", secondReader.readLine())
        second.close()
    }

    @Test
    fun `second matching request while pending is rejected as already delivered`() {
        val port = freePort()
        val (_, callbacks, _) = startRelay(port)

        val (first, _) = request(port, "GET /?code=first HTTP/1.1")
        val callback = callbacks.poll(5, TimeUnit.SECONDS)
        assertNotNull(callback)

        val (second, secondReader) = request(port, "GET /?code=second HTTP/1.1")
        assertEquals("HTTP/1.1 409 Status", secondReader.readLine())
        second.close()
        assertNull(callbacks.poll(300, TimeUnit.MILLISECONDS))
        first.close()
    }

    @Test
    fun `non get request is a bad request`() {
        val port = freePort()
        startRelay(port)

        val (socket, reader) = request(port, "POST / HTTP/1.1")
        assertEquals("HTTP/1.1 400 Status", reader.readLine())
        socket.close()
    }

    @Test
    fun `start fails when the port is taken`() {
        ServerSocket(0).use { taken ->
            val blocked = OauthLoopbackRelay(
                port = taken.localPort,
                expectedPath = "/",
                onCallback = { _, _ -> },
                onError = { },
            )
            assertEquals(false, blocked.start())
        }
    }
}
