package com.laymux.android.remote

import com.laymux.android.pairing.StoredPairing
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets
import java.util.Arrays
import org.json.JSONObject

internal class E2eRemoteClient(
    private val connectionFactory: (URI) -> HttpURLConnection = { uri ->
        uri.toURL().openConnection() as HttpURLConnection
    },
    private val nowEpochSeconds: () -> Long = { System.currentTimeMillis() / 1_000 },
    private val rpcRetryWait: () -> Unit = {
        try {
            Thread.sleep(RPC_RETRY_DELAY_MS)
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            throw E2eTransportException("보안 연결 재시도가 중단됐습니다.", cause = error)
        }
    },
) {
    fun open(
        pairing: StoredPairing,
        transport: E2eTransport = E2eTransport.cloud(pairing.metadata.endpoint),
        beforeAttempt: () -> Unit = {},
    ): RemoteSession {
        val metadata = pairing.metadata
        require(metadata.confirmedAtEpochSeconds != null) { "데스크톱 확인이 끝난 페어링이 필요합니다." }
        val seed = pairing.secretCopy()
        // A Tailscale Direct probe against a phone that is not on the tailnet
        // dies by connect timeout, and the user sits through every millisecond
        // of it before the cloud fallback fires — so the first direct contact
        // gets one short attempt. Once the challenge answered, the host is
        // reachable and establish keeps the lost-response retransmit.
        val direct = transport.kind == E2eTransportKind.TAILSCALE_DIRECT
        val connectTimeoutMs = if (direct) DIRECT_CONNECT_TIMEOUT_MS else CONNECT_TIMEOUT_MS
        try {
            val clientSessionNonce = E2eProtocol.newClientSessionNonce()
            val challengeRaw = postWithRetry(
                transport.httpUrl(E2eHttpOperation.CHALLENGE),
                "",
                E2eProtocol.challengeRequest(metadata, clientSessionNonce),
                HANDSHAKE_RESPONSE_LIMIT,
                if (direct) DIRECT_PROBE_ATTEMPTS else HANDSHAKE_ATTEMPTS,
                invalidatesSession = false,
                beforeAttempt = beforeAttempt,
                connectTimeoutMs = connectTimeoutMs,
            )
            val challenge = E2eProtocol.verifyChallenge(
                metadata,
                clientSessionNonce,
                seed,
                challengeRaw,
                nowEpochSeconds(),
            )
            val establishRaw = postWithRetry(
                transport.httpUrl(E2eHttpOperation.ESTABLISH),
                "",
                E2eProtocol.establishRequest(challenge, seed),
                HANDSHAKE_RESPONSE_LIMIT,
                HANDSHAKE_ATTEMPTS,
                invalidatesSession = false,
                beforeAttempt = beforeAttempt,
                connectTimeoutMs = connectTimeoutMs,
            )
            return E2eProtocol.verifyEstablished(
                challenge,
                seed,
                transport,
                establishRaw,
                nowEpochSeconds,
            )
        } finally {
            Arrays.fill(seed, 0)
        }
    }

    fun rpc(session: RemoteSession, plaintext: JSONObject): JSONObject {
        val pending = session.prepareRequest(plaintext.toString())
        return executePending(session, pending)
    }

    fun resumePending(session: RemoteSession): JSONObject? {
        val pending = session.pendingRequest() ?: return null
        return executePending(session, pending)
    }

    fun transitionBackgroundLease(session: RemoteSession, leaseId: String): JSONObject =
        rpc(
            session,
            JSONObject().put("kind", "backgroundTransition").put("leaseId", leaseId),
        )

    private fun executePending(session: RemoteSession, pending: PendingRpc): JSONObject {
        while (true) {
            session.requireTransportAllowed()
            val response = try {
                postWithRetry(
                    session.transport.httpUrl(E2eHttpOperation.RPC),
                    "",
                    pending.envelopeJson,
                    RPC_RESPONSE_LIMIT,
                    RPC_ATTEMPTS,
                    invalidatesSession = true,
                    beforeAttempt = session::requireTransportAllowed,
                )
            } catch (error: E2eTransportException) {
                if (!error.retryable || error.invalidatesSession) throw error
                if (E2eTransportPolicy.shouldFallbackActiveSession(
                        session.transport.kind,
                        error.failureKind,
                    )
                ) {
                    throw error
                }
                if (session.isSuspendedForBackground()) throw E2eSessionSuspendedException()
                if (session.isExpired()) {
                    throw E2eProtocolException("보안 세션이 비활성 상태로 만료됐습니다.", true)
                }
                rpcRetryWait()
                continue
            }
            if (session.isSuspendedForBackground()) throw E2eSessionSuspendedException()
            return JSONObject(session.completeRequest(pending, response))
        }
    }

    internal fun postWithRetry(
        endpoint: String,
        path: String,
        body: String,
        responseLimit: Int,
        attempts: Int,
        invalidatesSession: Boolean,
        beforeAttempt: (() -> Unit)? = null,
        connectTimeoutMs: Int = CONNECT_TIMEOUT_MS,
    ): String {
        var lastError: E2eTransportException? = null
        repeat(attempts) {
            beforeAttempt?.invoke()
            try {
                return post(endpoint, path, body, responseLimit, connectTimeoutMs)
            } catch (error: E2eTransportException) {
                if (!error.retryable) throw error
                lastError = error
            }
        }
        throw E2eTransportException(
            lastError?.message ?: "암호화 RPC에 실패했습니다.",
            retryable = lastError?.retryable ?: false,
            invalidatesSession = lastError?.invalidatesSession ?: invalidatesSession,
            failureKind = lastError?.failureKind ?: E2eTransportFailureKind.OTHER,
            cause = lastError,
        )
    }

    private fun post(
        endpoint: String,
        path: String,
        body: String,
        responseLimit: Int,
        connectTimeoutMs: Int = CONNECT_TIMEOUT_MS,
    ): String {
        val endpointUri = URI(endpoint)
        val connection = connectionFactory(
            if (path.isEmpty()) endpointUri else endpointUri.resolve(path),
        )
        return try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = READ_TIMEOUT_MS
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Accept", "application/json")
            connection.outputStream.use { output ->
                output.write(body.toByteArray(StandardCharsets.UTF_8))
            }
            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.close()
                throw E2eTransportException(
                    when (status) {
                        HttpURLConnection.HTTP_GONE -> "보안 세션이 만료됐습니다."
                        HttpURLConnection.HTTP_UNAUTHORIZED -> "보안 세션 인증에 실패했습니다."
                        HttpURLConnection.HTTP_CONFLICT -> "보안 세션 순서가 일치하지 않습니다."
                        HttpURLConnection.HTTP_UNAVAILABLE -> "데스크톱이 오프라인입니다."
                        else -> "보안 연결이 HTTP $status 응답을 반환했습니다."
                    },
                    retryable = status >= 500,
                    invalidatesSession = status in setOf(
                        HttpURLConnection.HTTP_GONE,
                        HttpURLConnection.HTTP_UNAUTHORIZED,
                        HttpURLConnection.HTTP_CONFLICT,
                    ),
                    failureKind = E2eTransportFailureKind.HTTP,
                )
            }
            readBounded(connection.inputStream, responseLimit)
        } catch (error: E2eTransportException) {
            throw error
        } catch (error: Exception) {
            throw E2eTransportException(
                "보안 연결에 실패했습니다.",
                retryable = true,
                failureKind = E2eTransportFailureKind.NETWORK,
                cause = error,
            )
        } finally {
            connection.disconnect()
        }
    }

    private fun readBounded(stream: InputStream, limit: Int): String = stream.use { input ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (output.size() + read > limit) {
                throw E2eTransportException("보안 응답이 허용 크기를 초과했습니다.")
            }
            output.write(buffer, 0, read)
        }
        output.toString(StandardCharsets.UTF_8.name())
    }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val READ_TIMEOUT_MS = 15_000
        private const val HANDSHAKE_RESPONSE_LIMIT = 8 * 1024
        private const val RPC_RESPONSE_LIMIT = 6 * 1024 * 1024
        private const val HANDSHAKE_ATTEMPTS = 2

        // First direct contact is a reachability probe: WireGuard-lan RTT fits
        // comfortably in 2.5s, and an off-tailnet phone should reach the cloud
        // fallback in seconds, not after 2 x 10s connect timeouts.
        internal const val DIRECT_CONNECT_TIMEOUT_MS = 2_500
        internal const val DIRECT_PROBE_ATTEMPTS = 1

        private const val RPC_ATTEMPTS = 2
        private const val RPC_RETRY_DELAY_MS = 1_000L
    }
}

internal class E2eTransportException(
    message: String,
    val retryable: Boolean = false,
    val invalidatesSession: Boolean = false,
    val failureKind: E2eTransportFailureKind = E2eTransportFailureKind.OTHER,
    cause: Throwable? = null,
) : Exception(message, cause)
