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

    private fun startRelay(
        port: Int,
        expectedPath: String = "/",
        lifetimeMs: Long = 60_000,
        callbacks: LinkedBlockingQueue<String> = LinkedBlockingQueue(),
        errors: LinkedBlockingQueue<String> = LinkedBlockingQueue(),
    ): Triple<OauthLoopbackRelay, LinkedBlockingQueue<String>, LinkedBlockingQueue<String>> {
        val started = OauthLoopbackRelay(
            port = port,
            expectedPath = expectedPath,
            onCallback = { pathAndQuery -> callbacks.add(pathAndQuery) },
            onError = { message -> errors.add(message) },
            lifetimeMs = lifetimeMs,
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

    private fun connectionRefused(port: Int): Boolean = try {
        Socket(InetAddress.getLoopbackAddress(), port).close()
        false
    } catch (_: ConnectException) {
        true
    }

    @Test
    fun `matching callback answers the browser immediately and hands off the target`() {
        val port = freePort()
        val (_, callbacks, _) = startRelay(port)

        val (socket, reader) = request(port, "GET /?code=4%2Fabc&scope=openid HTTP/1.1")
        // The browser is answered right away — the forward to the PC happens
        // later, after the user returns to the app (ADR-0146).
        assertEquals("HTTP/1.1 200 OK", reader.readLine())
        var line = reader.readLine()
        while (!line.isNullOrEmpty()) line = reader.readLine()
        assertTrue(reader.readLine()!!.contains("Return to the Laymux app"))
        socket.close()

        assertEquals("/?code=4%2Fabc&scope=openid", callbacks.poll(5, TimeUnit.SECONDS))

        // The one callback shuts the listener down.
        assertTrue("listener should be closed after the callback", connectionRefused(port))
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
        assertEquals("HTTP/1.1 200 OK", secondReader.readLine())
        second.close()
        assertEquals("/cb?code=x", callbacks.poll(5, TimeUnit.SECONDS))
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
                onCallback = { },
                onError = { },
            )
            assertEquals(false, blocked.start())
        }
    }

    @Test
    fun `unrelated requests do not extend the absolute lifetime`() {
        val port = freePort()
        val (_, callbacks, errors) = startRelay(port, expectedPath = "/cb", lifetimeMs = 900)

        // Keep poking the listener with non-matching requests past the
        // deadline; each accept must not restart the lifetime window.
        val deadline = System.currentTimeMillis() + 2_500
        var refused = false
        while (System.currentTimeMillis() < deadline) {
            try {
                val (socket, reader) = request(port, "GET /other HTTP/1.1")
                reader.readLine()
                socket.close()
            } catch (_: Exception) {
                refused = true
                break
            }
            Thread.sleep(150)
        }
        assertTrue("listener should die at its absolute deadline", refused)
        assertNotNull("expiry should be reported", errors.poll(5, TimeUnit.SECONDS))
        assertNull(callbacks.poll(100, TimeUnit.MILLISECONDS))
    }
}
