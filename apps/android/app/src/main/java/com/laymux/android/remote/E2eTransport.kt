package com.laymux.android.remote

import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI

internal enum class E2eTransportKind {
    CLOUD_RELAY,
    TAILSCALE_DIRECT,
}

internal enum class E2eHttpOperation {
    CHALLENGE,
    ESTABLISH,
    RPC,
}

internal class E2eTransport private constructor(
    val kind: E2eTransportKind,
    val endpoint: String,
) {
    fun httpUrl(operation: E2eHttpOperation): String =
        URI(endpoint).resolve(httpPath(operation)).toASCIIString()

    fun outputUrl(instanceId: String, sessionId: String, streamNonce: String): String {
        val base = URI(endpoint)
        val scheme = when (base.scheme.lowercase()) {
            "https" -> "wss"
            "http" -> "ws"
            else -> throw E2eProtocolException("Secure output endpoint is invalid.", true)
        }
        return URI(
            scheme,
            base.rawAuthority,
            when (kind) {
                E2eTransportKind.CLOUD_RELAY -> "/api/android/e2e/output"
                E2eTransportKind.TAILSCALE_DIRECT -> "/remote/v1/e2e/output"
            },
            "instanceId=$instanceId&sessionId=$sessionId&streamNonce=$streamNonce",
            null,
        ).toASCIIString()
    }

    private fun httpPath(operation: E2eHttpOperation): String {
        val suffix = when (operation) {
            E2eHttpOperation.CHALLENGE -> "session/challenge"
            E2eHttpOperation.ESTABLISH -> "session/establish"
            E2eHttpOperation.RPC -> "rpc"
        }
        return when (kind) {
            E2eTransportKind.CLOUD_RELAY -> "/api/android/e2e/$suffix"
            E2eTransportKind.TAILSCALE_DIRECT -> "/remote/v1/e2e/$suffix"
        }
    }

    companion object {
        fun cloud(raw: String): E2eTransport {
            val uri = URI(raw)
            val host = uri.host?.removePrefix("[")?.removeSuffix("]")
            val loopbackHttp = uri.scheme.equals("http", ignoreCase = true) &&
                (host == "127.0.0.1" || host == "::1")
            require(
                (uri.scheme.equals("https", ignoreCase = true) || loopbackHttp) &&
                    !host.isNullOrBlank() &&
                    uri.rawUserInfo == null &&
                    uri.rawQuery == null &&
                    uri.rawFragment == null &&
                    (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/"),
            ) { "Cloud E2E endpoint is invalid" }
            val endpoint = URI(uri.scheme.lowercase(), null, host, uri.port, "/", null, null)
                .toASCIIString()
            return E2eTransport(E2eTransportKind.CLOUD_RELAY, endpoint)
        }

        fun tailscale(raw: String): E2eTransport = E2eTransport(
            E2eTransportKind.TAILSCALE_DIRECT,
            requireNotNull(TailscaleEndpoint.canonicalUrl(raw)) {
                "Tailscale Direct endpoint is invalid"
            },
        )
    }
}

internal object TailscaleEndpoint {
    fun canonicalUrl(raw: String): String? {
        if (raw.isBlank() || raw.length > MAX_URL_LENGTH) return null
        val uri = try {
            URI(raw)
        } catch (_: Exception) {
            return null
        }
        val host = uri.host?.removePrefix("[")?.removeSuffix("]") ?: return null
        if (!uri.scheme.equals("http", ignoreCase = true) ||
            uri.port !in ALLOWED_PORTS ||
            uri.rawUserInfo != null ||
            uri.rawPath != "/remote/" ||
            uri.rawQuery != null ||
            uri.rawFragment != null ||
            !isTailscaleLiteral(host)
        ) {
            return null
        }
        return try {
            URI("http", null, host.lowercase(), uri.port, "/remote/", null, null)
                .toASCIIString()
        } catch (_: Exception) {
            null
        }
    }

    private fun isTailscaleLiteral(host: String): Boolean =
        isTailscaleIpv4(host) || isTailscaleIpv6(host)

    private fun isTailscaleIpv4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4) return false
        val octets = parts.map { part ->
            if (part.isEmpty() || part.any { !it.isDigit() }) return false
            part.toIntOrNull()?.takeIf { it in 0..255 } ?: return false
        }
        return octets[0] == 100 && octets[1] in 64..127
    }

    private fun isTailscaleIpv6(host: String): Boolean {
        if (':' !in host || '%' in host || host.any { it !in IPV6_LITERAL_CHARS }) return false
        val address = try {
            InetAddress.getByName(host)
        } catch (_: Exception) {
            return false
        }
        val bytes = (address as? Inet6Address)?.address ?: return false
        return bytes[0] == 0xfd.toByte() &&
            bytes[1] == 0x7a.toByte() &&
            bytes[2] == 0x11.toByte() &&
            bytes[3] == 0x5c.toByte() &&
            bytes[4] == 0xa1.toByte() &&
            bytes[5] == 0xe0.toByte()
    }

    private const val MAX_URL_LENGTH = 512
    private val ALLOWED_PORTS = setOf(19_280, 19_281)
    private val IPV6_LITERAL_CHARS = "0123456789abcdefABCDEF:.".toSet()
}

enum class E2eTransportFailureKind {
    NETWORK,
    HTTP,
    OTHER,
}

internal object E2eTransportPolicy {
    fun shouldFallbackToCloud(error: Throwable): Boolean =
        error is E2eTransportException && error.failureKind == E2eTransportFailureKind.NETWORK

    fun <T> connectDirectFirst(
        direct: E2eTransport?,
        openDirect: (E2eTransport) -> T,
        beforeCloudFallback: () -> Unit = {},
        openCloud: () -> T,
    ): T {
        if (direct == null) return openCloud()
        return try {
            openDirect(direct)
        } catch (error: Throwable) {
            if (!shouldFallbackToCloud(error)) throw error
            beforeCloudFallback()
            openCloud()
        }
    }

    fun shouldFallbackActiveSession(
        transportKind: E2eTransportKind,
        failureKind: E2eTransportFailureKind,
    ): Boolean = transportKind == E2eTransportKind.TAILSCALE_DIRECT &&
        failureKind == E2eTransportFailureKind.NETWORK
}
