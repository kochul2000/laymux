package com.laymux.android.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class E2eTransportTest {
    @Test
    fun cloudAndTailscaleMapTheSameLogicalOperationsToTheirFixedRoutes() {
        val cloud = E2eTransport.cloud("https://app.laymux.com/")
        val direct = E2eTransport.tailscale("http://100.100.10.20:19281/remote/")

        assertEquals(
            "https://app.laymux.com/api/android/e2e/session/challenge",
            cloud.httpUrl(E2eHttpOperation.CHALLENGE),
        )
        assertEquals(
            "http://100.100.10.20:19281/remote/v1/e2e/session/challenge",
            direct.httpUrl(E2eHttpOperation.CHALLENGE),
        )
        assertEquals(
            "https://app.laymux.com/api/android/e2e/rpc",
            cloud.httpUrl(E2eHttpOperation.RPC),
        )
        assertEquals(
            "http://100.100.10.20:19281/remote/v1/e2e/rpc",
            direct.httpUrl(E2eHttpOperation.RPC),
        )
        assertEquals(
            "wss://app.laymux.com/api/android/e2e/output?instanceId=desktop-7&sessionId=session&streamNonce=nonce",
            cloud.outputUrl("desktop-7", "session", "nonce"),
        )
        assertEquals(
            "ws://100.100.10.20:19281/remote/v1/e2e/output?instanceId=desktop-7&sessionId=session&streamNonce=nonce",
            direct.outputUrl("desktop-7", "session", "nonce"),
        )
    }

    @Test
    fun fallbackIsLimitedToDirectNetworkFailures() {
        assertTrue(
            E2eTransportPolicy.shouldFallbackToCloud(
                E2eTransportException(
                    "unreachable",
                    failureKind = E2eTransportFailureKind.NETWORK,
                ),
            ),
        )
        assertFalse(
            E2eTransportPolicy.shouldFallbackToCloud(
                E2eTransportException(
                    "forbidden",
                    failureKind = E2eTransportFailureKind.HTTP,
                ),
            ),
        )
        assertFalse(
            E2eTransportPolicy.shouldFallbackToCloud(
                E2eProtocolException("bad proof", invalidatesSession = true),
            ),
        )
    }

    @Test
    fun directFirstOpensCloudOnlyWhenDirectHasANetworkFailure() {
        val direct = E2eTransport.tailscale("http://100.100.10.20:19281/remote/")
        val calls = mutableListOf<String>()

        val result = E2eTransportPolicy.connectDirectFirst(
            direct,
            openDirect = {
                calls += "direct"
                throw E2eTransportException(
                    "unreachable",
                    failureKind = E2eTransportFailureKind.NETWORK,
                )
            },
            openCloud = {
                calls += "cloud"
                "cloud-session"
            },
        )

        assertEquals("cloud-session", result)
        assertEquals(listOf("direct", "cloud"), calls)
    }

    @Test
    fun directFirstDoesNotDowngradeHttpOrProtocolFailures() {
        val direct = E2eTransport.tailscale("http://100.100.10.20:19281/remote/")
        var cloudOpened = false

        val error = runCatching {
            E2eTransportPolicy.connectDirectFirst(
                direct,
                openDirect = {
                    throw E2eTransportException(
                        "forbidden",
                        failureKind = E2eTransportFailureKind.HTTP,
                    )
                },
                openCloud = {
                    cloudOpened = true
                    "cloud-session"
                },
            )
        }.exceptionOrNull()

        assertTrue(error is E2eTransportException)
        assertFalse(cloudOpened)
    }

    @Test
    fun cancellationAfterDirectFailureStopsBeforeCloudFallback() {
        val direct = E2eTransport.tailscale("http://100.100.10.20:19281/remote/")
        var cloudOpened = false

        val error = runCatching {
            E2eTransportPolicy.connectDirectFirst(
                direct,
                openDirect = {
                    throw E2eTransportException(
                        "timeout",
                        failureKind = E2eTransportFailureKind.NETWORK,
                    )
                },
                beforeCloudFallback = { throw TestCancellationException() },
                openCloud = {
                    cloudOpened = true
                    "cloud-session"
                },
            )
        }.exceptionOrNull()

        assertTrue(error is TestCancellationException)
        assertFalse(cloudOpened)
    }

    @Test
    fun activeSessionFallbackRequiresDirectTransportAndNetworkFailure() {
        assertTrue(
            E2eTransportPolicy.shouldFallbackActiveSession(
                E2eTransportKind.TAILSCALE_DIRECT,
                E2eTransportFailureKind.NETWORK,
            ),
        )
        assertFalse(
            E2eTransportPolicy.shouldFallbackActiveSession(
                E2eTransportKind.CLOUD_RELAY,
                E2eTransportFailureKind.NETWORK,
            ),
        )
        assertFalse(
            E2eTransportPolicy.shouldFallbackActiveSession(
                E2eTransportKind.TAILSCALE_DIRECT,
                E2eTransportFailureKind.HTTP,
            ),
        )
    }

    private class TestCancellationException : RuntimeException()
}
