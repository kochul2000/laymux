package com.laymux.android.remote

import com.laymux.android.pairing.PairingMetadata
import com.laymux.android.pairing.StoredPairing
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Arrays
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.json.JSONObject

class E2eProtocolTest {
    @Test
    fun outputQueueAcceptsTheProtocolMaximumSnapshotPlusBoundedBacklog() {
        val maximumSnapshotRecord = 1 + 1024 * 1024 + (512 * 1024 + 1024 * 1024 + 2 * 4096)

        assertEquals(E2eOutputLimits.MAX_PLAINTEXT_RECORD_BYTES, maximumSnapshotRecord)
        assertEquals(
            maximumSnapshotRecord + 25,
            E2eOutputLimits.MAX_ENCRYPTED_RECORD_BYTES,
        )
        assertEquals(true, E2eOutputLimits.canDecrypt(maximumSnapshotRecord + 25))
        assertEquals(false, E2eOutputLimits.canDecrypt(maximumSnapshotRecord + 26))
        assertEquals(true, E2eOutputLimits.canEnqueue(0, maximumSnapshotRecord))
        assertEquals(true, E2eOutputLimits.canEnqueue(256, maximumSnapshotRecord))
        assertEquals(
            false,
            E2eOutputLimits.canEnqueue(0, maximumSnapshotRecord + 1),
        )
        assertEquals(
            false,
            E2eOutputLimits.canEnqueue(
                E2eOutputLimits.MAX_PENDING_BYTES - maximumSnapshotRecord + 1,
                maximumSnapshotRecord,
            ),
        )
    }

    @Test
    fun outputStreamReservationsBoundPendingAndActiveOpens() {
        val reservations = E2eOutputStreamReservations(maxStreams = 2)
        val first = requireNotNull(reservations.reserve("stream-1"))
        val second = requireNotNull(reservations.reserve("stream-2"))

        assertEquals(null, reservations.reserve("stream-3"))
        assertEquals(null, reservations.reserve("stream-1"))
        assertEquals(false, reservations.release("stream-1", first + 1))
        assertEquals(true, reservations.isCurrent("stream-1", first))
        assertEquals(true, reservations.release("stream-1", first))
        assertEquals(false, reservations.isCurrent("stream-1", first))
        assertEquals(true, reservations.reserve("stream-3") != null)
        assertEquals(true, reservations.release("stream-2", second))
    }

    @Test
    fun outputRecordsAreBinaryDirectionalAndBoundToTheStreamNonce() {
        val sessionKeys = E2eProtocol.deriveKeys(
            ByteArray(32) { 3 },
            arrayOf("p", "desktop-7", "c", "cs", "sn", "s"),
        )
        val streamNonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        val outputKeys = E2eOutputProtocol.deriveKeys(
            sessionKeys.first,
            sessionKeys.second,
            "desktop-7",
            "s",
            streamNonce,
        )
        assertEquals(
            "e5df689e823e95d6a84af57c73af53e006598abd39838cc04c1c4057b13939e5",
            outputKeys.first.toHex(),
        )
        assertEquals(
            "3ea5a2e48f7b8a53e1c6369b6f3b560bc0bfa47c1ef92e50eef2c0d6f7e5ec76",
            outputKeys.second.toHex(),
        )
        val responsePlaintext = byteArrayOf(E2eOutputProtocol.RECORD_BINARY, 4, 5, 6)
        val record = E2eOutputProtocol.encryptRecord(
            outputKeys.second,
            E2eOutputProtocol.D2A_AAD_DOMAIN,
            "desktop-7",
            "s",
            streamNonce,
            0,
            responsePlaintext,
        )

        assertEquals(E2eProtocol.VERSION.toByte(), record[0])
        assertArrayEquals(
            responsePlaintext,
            E2eOutputProtocol.decryptRecord(
                outputKeys.second,
                E2eOutputProtocol.D2A_AAD_DOMAIN,
                "desktop-7",
                "s",
                streamNonce,
                0,
                record,
            ),
        )
        assertThrows(E2eProtocolException::class.java) {
            E2eOutputProtocol.decryptRecord(
                outputKeys.second,
                E2eOutputProtocol.D2A_AAD_DOMAIN,
                "desktop-7",
                "s",
                "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
                0,
                record,
            )
        }
        Arrays.fill(sessionKeys.first, 0)
        Arrays.fill(sessionKeys.second, 0)
        Arrays.fill(outputKeys.first, 0)
        Arrays.fill(outputKeys.second, 0)
        Arrays.fill(responsePlaintext, 0)
        Arrays.fill(record, 0)
    }

    @Test
    fun matchesTheDesktopCrossPlatformVector() {
        val seed = ByteArray(32) { it.toByte() }
        val pairingId = "AAECAwQFBgcICQoLDA0ODw"
        val instanceId = "desktop-7"
        val clientNonce = "EBESExQVFhcYGRobHB0eHw"
        val clientSessionNonce = "ICEiIyQlJicoKSorLC0uLw"
        val challengeId = "MDEyMzQ1Njc4OTo7PD0-Pw"
        val serverNonce = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8"
        val sessionId = "YGFiY2RlZmdoaWprbG1ubw"
        val challengeFields = arrayOf(
            pairingId,
            instanceId,
            clientNonce,
            clientSessionNonce,
            challengeId,
            serverNonce,
            "1786500060",
        )
        assertEquals(
            "wxWeT6f_QTcAE2z5QX5ZRJlbkekabc6q0w69JCQqMu8",
            E2eProtocol.proof(seed, E2eProtocol.CHALLENGE_RESPONSE_DOMAIN, challengeFields),
        )
        assertEquals(
            "RRAE-GKCcgI3wsHoCJm1CiDR_QOQueTsl8SkCsyp6KU",
            E2eProtocol.proof(seed, E2eProtocol.ESTABLISH_REQUEST_DOMAIN, challengeFields),
        )
        assertEquals(
            "P6F7cZb9EgEcr5aSv3Rjs2joBZ_2DKQePB2vAvjCiGg",
            E2eProtocol.proof(
                seed,
                E2eProtocol.ESTABLISH_RESPONSE_DOMAIN,
                arrayOf(
                    pairingId,
                    instanceId,
                    clientNonce,
                    clientSessionNonce,
                    challengeId,
                    serverNonce,
                    sessionId,
                    "1786500900",
                ),
            ),
        )

        val keys = E2eProtocol.deriveKeys(
            seed,
            arrayOf(
                pairingId,
                instanceId,
                clientNonce,
                clientSessionNonce,
                serverNonce,
                sessionId,
            ),
        )
        assertEquals(
            "79c2fc79d9701cb486b4c9210bd791dab19c98acd75e636aac50f732e96b9845",
            keys.first.toHex(),
        )
        assertEquals(
            "d950a4153cbf38c88f83a6137fb7a502c33decaa9f064d94cde70ae57de859e2",
            keys.second.toHex(),
        )

        val plaintext =
            "{\"kind\":\"http\",\"method\":\"GET\",\"path\":\"/remote/v1/terminals\",\"body\":null}"
        val encrypted = E2eProtocol.encrypt(
            keys.first,
            E2eProtocol.A2D_AAD_DOMAIN,
            instanceId,
            sessionId,
            0,
            plaintext.toByteArray(),
        )
        assertEquals(
            "6CTwoMBqwF3Hxw_Wl2PztwWSgH2AfeiT-NNpxoI1fjJz0wn0qLVsXbHwf98WpAjnFJOV9gQsr6pCaWMqCVlT7jGGLNwyAqv08KWyYuJVrAfzcd95fBkLOg",
            encrypted,
        )
        assertArrayEquals(
            plaintext.toByteArray(),
            E2eProtocol.decrypt(
                keys.first,
                E2eProtocol.A2D_AAD_DOMAIN,
                instanceId,
                sessionId,
                0,
                encrypted,
            ),
        )
        assertThrows(E2eProtocolException::class.java) {
            E2eProtocol.decrypt(
                keys.first,
                E2eProtocol.A2D_AAD_DOMAIN,
                "desktop-8",
                sessionId,
                0,
                encrypted,
            )
        }
        assertNotEquals(keys.first.toHex(), keys.second.toHex())
        Arrays.fill(seed, 0)
        Arrays.fill(keys.first, 0)
        Arrays.fill(keys.second, 0)
    }

    @Test
    fun sessionExpiresAtTheExactDesktopBoundary() {
        val session = RemoteSession(
            "https://relay.example/",
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            200,
            ByteArray(32) { 1 },
            ByteArray(32) { 2 },
            nowEpochSeconds = { 200 },
        )
        assertThrows(E2eProtocolException::class.java) {
            session.prepareRequest("{\"kind\":\"test\"}")
        }
    }

    @Test
    fun closingSessionMakesItExpireImmediately() {
        val session = RemoteSession(
            "https://relay.example/",
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            1_000,
            ByteArray(32) { 1 },
            ByteArray(32) { 2 },
            nowEpochSeconds = { 100 },
        )
        session.close()
        assertEquals(true, session.isExpired())
    }

    @Test
    fun backgroundSuspendPreservesPendingRequestAndRejectsNewSequenceUntilResume() {
        val now = AtomicLong(100)
        val session = RemoteSession(
            "https://relay.example/",
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            1_000,
            ByteArray(32) { 1 },
            ByteArray(32) { 2 },
            nowEpochSeconds = now::get,
        )
        val pending = session.prepareRequest("{\"kind\":\"first\"}")

        session.suspendForBackground()
        assertThrows(E2eSessionSuspendedException::class.java) {
            session.prepareRequest("{\"kind\":\"second\"}")
        }
        assertThrows(E2eSessionSuspendedException::class.java) {
            session.completeRequest(pending, "{}")
        }
        assertEquals(pending, session.pendingRequest())
        assertEquals(true, session.resumeFromBackground())
        assertEquals(pending, session.pendingRequest())

        now.set(1_000)
        session.suspendForBackground()
        assertEquals(false, session.resumeFromBackground())
        session.close()
    }

    @Test
    fun sessionRejectsASecondInFlightRequestBeforeCompletion() {
        val session = RemoteSession(
            "https://relay.example/",
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            201,
            ByteArray(32) { 1 },
            ByteArray(32) { 2 },
            nowEpochSeconds = { 200 },
        )
        session.prepareRequest("{\"kind\":\"first\"}")

        assertThrows(E2eProtocolException::class.java) {
            session.prepareRequest("{\"kind\":\"second\"}")
        }
        session.close()
    }

    @Test
    fun authenticatedResponseRenewsTheLocalInactivityDeadline() {
        val now = AtomicLong(199)
        val responseKey = ByteArray(32) { 2 }
        val session = RemoteSession(
            "https://relay.example/",
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            200,
            ByteArray(32) { 1 },
            responseKey.copyOf(),
            nowEpochSeconds = now::get,
        )
        val pending = session.prepareRequest("{\"kind\":\"test\"}")
        val refreshedExpiry = 1_100L
        val encrypted = E2eProtocol.encrypt(
            responseKey,
            E2eProtocol.D2A_AAD_DOMAIN,
            session.instanceId,
            session.sessionId,
            pending.sequence,
            JSONObject()
                .put("version", E2eProtocol.VERSION)
                .put("expiresAt", refreshedExpiry)
                .put("response", JSONObject().put("kind", "ok"))
                .toString()
                .toByteArray(),
        )
        val responseEnvelope = JSONObject()
            .put("version", E2eProtocol.VERSION)
            .put("instanceId", session.instanceId)
            .put("sessionId", session.sessionId)
            .put("sequence", pending.sequence)
            .put("ciphertext", encrypted)
            .toString()

        now.set(200)
        assertEquals(
            "ok",
            JSONObject(session.completeRequest(pending, responseEnvelope)).getString("kind"),
        )
        assertEquals(refreshedExpiry, session.expiresAtEpochSeconds)
        now.set(refreshedExpiry - 1)
        assertEquals(false, session.isExpired())
        now.set(refreshedExpiry)
        assertEquals(true, session.isExpired())
        session.close()
        Arrays.fill(responseKey, 0)
    }

    @Test
    fun pendingResponseAfterBackgroundCannotExtendTheCapturedDeadline() {
        val now = AtomicLong(100)
        val responseKey = ByteArray(32) { 2 }
        val session = RemoteSession(
            "https://relay.example/",
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            200,
            ByteArray(32) { 1 },
            responseKey.copyOf(),
            nowEpochSeconds = now::get,
        )
        val pending = session.prepareRequest("{\"kind\":\"test\"}")
        session.suspendForBackground()
        now.set(150)
        assertEquals(true, session.resumeFromBackground())
        val responsePlaintext = JSONObject()
            .put("version", E2eProtocol.VERSION)
            .put("expiresAt", 1_050)
            .put("response", JSONObject().put("kind", "ok"))
            .toString()
            .toByteArray()
        val responseEnvelope = JSONObject()
            .put("version", E2eProtocol.VERSION)
            .put("instanceId", session.instanceId)
            .put("sessionId", session.sessionId)
            .put("sequence", pending.sequence)
            .put(
                "ciphertext",
                E2eProtocol.encrypt(
                    responseKey,
                    E2eProtocol.D2A_AAD_DOMAIN,
                    session.instanceId,
                    session.sessionId,
                    pending.sequence,
                    responsePlaintext,
                ),
            )
            .toString()

        assertEquals(
            "ok",
            JSONObject(session.completeRequest(pending, responseEnvelope)).getString("kind"),
        )
        assertEquals(200, session.expiresAtEpochSeconds)
        Arrays.fill(responsePlaintext, 0)
        session.close()
        Arrays.fill(responseKey, 0)
    }

    @Test
    fun transportRetryStopsBeforeASecondAttemptWhenBackgrounded() {
        val requestBodies = mutableListOf<String>()
        var attempts = 0
        lateinit var session: RemoteSession
        val client = E2eRemoteClient(
            connectionFactory = { uri ->
                attempts += 1
                RecordingConnection(
                    uri.toURL(),
                    requestBodies,
                    failResponse = true,
                    onResponseCode = { session.suspendForBackground() },
                )
            },
            rpcRetryWait = {},
        )
        session = RemoteSession(
            "https://relay.example/",
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            1_000,
            ByteArray(32) { 1 },
            ByteArray(32) { 2 },
            nowEpochSeconds = { 100 },
        )

        assertThrows(E2eSessionSuspendedException::class.java) {
            client.rpc(session, JSONObject().put("kind", "test"))
        }
        assertEquals(1, attempts)
        assertEquals(1, requestBodies.size)
        assertEquals(true, session.pendingRequest() != null)
        session.close()
    }

    @Test
    fun retryKeepsTheExactHandshakeBodyAfterATransportFailure() {
        val requestBodies = mutableListOf<String>()
        var attempts = 0
        val client = E2eRemoteClient(
            connectionFactory = { uri ->
                attempts += 1
                RecordingConnection(
                    uri.toURL(),
                    requestBodies,
                    failResponse = attempts == 1,
                )
            },
        )

        val response = client.postWithRetry(
            "https://relay.example/",
            "/api/android/e2e/session/challenge",
            "{\"exact\":true}",
            1024,
            attempts = 2,
            invalidatesSession = false,
        )

        assertEquals("{}", response)
        assertEquals(listOf("{\"exact\":true}", "{\"exact\":true}"), requestBodies)
    }

    @Test
    fun directHandshakeUsesFixedRoutesAndCloudFallbackStartsWithAFreshNonce() {
        val seed = ByteArray(32) { it.toByte() }
        val metadata = PairingMetadata(
            endpoint = "https://relay.example/",
            instanceId = "desktop-7",
            pairingId = "AAECAwQFBgcICQoLDA0ODw",
            expiresAtEpochSeconds = 2_000,
            clientNonce = "EBESExQVFhcYGRobHB0eHw",
            confirmedAtEpochSeconds = 900,
            label = null,
        )
        val observed = mutableListOf<Pair<String, String>>()
        val directAttempts = mutableListOf<String>()
        var cloudClientSessionNonce: String? = null
        val client = E2eRemoteClient(
            connectionFactory = { uri ->
                if (uri.host == "100.100.10.20") {
                    RecordingConnection(
                        uri.toURL(),
                        mutableListOf(),
                        failResponse = true,
                        requestObserver = { body ->
                            directAttempts += body
                            observed += uri.toString() to body
                        },
                    )
                } else {
                    HandshakeConnection(uri.toURL()) { body ->
                        observed += uri.toString() to body
                        val request = JSONObject(body)
                        when {
                            uri.path.endsWith("/session/challenge") -> {
                                val nonce = request.getString("clientSessionNonce")
                                cloudClientSessionNonce = nonce
                                challengeResponse(metadata, seed, nonce)
                            }
                            uri.path.endsWith("/session/establish") -> {
                                establishResponse(
                                    metadata,
                                    seed,
                                    requireNotNull(cloudClientSessionNonce),
                                )
                            }
                            else -> error("unexpected handshake route: $uri")
                        }
                    }
                }
            },
            nowEpochSeconds = { 1_000 },
        )
        val direct = E2eTransport.tailscale("http://100.100.10.20:19281/remote/")

        val session = StoredPairing(metadata, seed.copyOf()).use { pairing ->
            E2eTransportPolicy.connectDirectFirst(
                direct,
                openDirect = { transport -> client.open(pairing, transport) },
                openCloud = { client.open(pairing) },
            )
        }

        assertEquals(2, directAttempts.size)
        assertEquals(1, directAttempts.distinct().size)
        assertNotEquals(
            JSONObject(directAttempts.first()).getString("clientSessionNonce"),
            requireNotNull(cloudClientSessionNonce),
        )
        assertEquals(
            listOf(
                "http://100.100.10.20:19281/remote/v1/e2e/session/challenge",
                "http://100.100.10.20:19281/remote/v1/e2e/session/challenge",
                "https://relay.example/api/android/e2e/session/challenge",
                "https://relay.example/api/android/e2e/session/establish",
            ),
            observed.map { it.first },
        )
        assertEquals(E2eTransportKind.CLOUD_RELAY, session.transport.kind)
        session.close()
        Arrays.fill(seed, 0)
    }

    @Test
    fun rpcKeepsRetryingTheExactCiphertextUntilAnAuthenticatedResponseArrives() {
        val requestBodies = mutableListOf<String>()
        val now = AtomicLong(100)
        val responseKey = ByteArray(32) { 2 }
        val responsePlaintext = JSONObject()
            .put("version", E2eProtocol.VERSION)
            .put("expiresAt", 1_000)
            .put("response", JSONObject().put("kind", "ok"))
            .toString()
            .toByteArray()
        val responseCiphertext = E2eProtocol.encrypt(
            responseKey,
            E2eProtocol.D2A_AAD_DOMAIN,
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            0,
            responsePlaintext,
        )
        Arrays.fill(responsePlaintext, 0)
        val responseEnvelope = JSONObject()
            .put("version", E2eProtocol.VERSION)
            .put("instanceId", "desktop-7")
            .put("sessionId", "YGFiY2RlZmdoaWprbG1ubw")
            .put("sequence", 0)
            .put("ciphertext", responseCiphertext)
            .toString()
        var attempts = 0
        val client = E2eRemoteClient(
            connectionFactory = { uri ->
                attempts += 1
                RecordingConnection(
                    uri.toURL(),
                    requestBodies,
                    failResponse = attempts <= 2,
                    responseBody = responseEnvelope,
                )
            },
            nowEpochSeconds = now::get,
            rpcRetryWait = {},
        )
        val session = RemoteSession(
            "https://relay.example/",
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            1_000,
            ByteArray(32) { 1 },
            responseKey.copyOf(),
            nowEpochSeconds = now::get,
        )

        assertEquals("ok", client.rpc(session, JSONObject().put("kind", "test")).getString("kind"))
        assertEquals(3, requestBodies.size)
        assertEquals(1, requestBodies.distinct().size)
        session.close()
        Arrays.fill(responseKey, 0)
    }

    @Test
    fun directRpcNetworkFailureEscapesAfterOneRetryBatchForCloudFallback() {
        val requestBodies = mutableListOf<String>()
        val now = AtomicLong(100)
        val transport = E2eTransport.tailscale("http://100.64.0.1:19280/remote/")
        val client = E2eRemoteClient(
            connectionFactory = { uri ->
                RecordingConnection(uri.toURL(), requestBodies, failResponse = true)
            },
            nowEpochSeconds = now::get,
            rpcRetryWait = { now.set(1_000) },
        )
        val session = RemoteSession(
            transport.endpoint,
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            1_000,
            ByteArray(32) { 1 },
            ByteArray(32) { 2 },
            nowEpochSeconds = now::get,
            transport = transport,
        )

        val error = assertThrows(E2eTransportException::class.java) {
            client.rpc(session, JSONObject().put("kind", "test"))
        }

        assertEquals(E2eTransportFailureKind.NETWORK, error.failureKind)
        assertEquals(2, requestBodies.size)
        assertEquals(100, now.get())
        session.close()
    }

    @Test
    fun suspendedTransportRetryCanResumeTheSamePendingCiphertext() {
        val requestBodies = mutableListOf<String>()
        val now = AtomicLong(100)
        val responseKey = ByteArray(32) { 2 }
        lateinit var session: RemoteSession
        val failingClient = E2eRemoteClient(
            connectionFactory = { uri ->
                RecordingConnection(uri.toURL(), requestBodies, failResponse = true)
            },
            nowEpochSeconds = now::get,
            rpcRetryWait = { session.suspendForBackground() },
        )
        session = RemoteSession(
            "https://relay.example/",
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            1_000,
            ByteArray(32) { 1 },
            responseKey.copyOf(),
            nowEpochSeconds = now::get,
        )

        assertThrows(E2eSessionSuspendedException::class.java) {
            failingClient.rpc(session, JSONObject().put("kind", "test"))
        }
        val pending = requireNotNull(session.pendingRequest())
        assertEquals(true, session.resumeFromBackground())

        val responsePlaintext = JSONObject()
            .put("version", E2eProtocol.VERSION)
            .put("expiresAt", 1_000)
            .put("response", JSONObject().put("kind", "ok"))
            .toString()
            .toByteArray()
        val responseEnvelope = JSONObject()
            .put("version", E2eProtocol.VERSION)
            .put("instanceId", session.instanceId)
            .put("sessionId", session.sessionId)
            .put("sequence", pending.sequence)
            .put(
                "ciphertext",
                E2eProtocol.encrypt(
                    responseKey,
                    E2eProtocol.D2A_AAD_DOMAIN,
                    session.instanceId,
                    session.sessionId,
                    pending.sequence,
                    responsePlaintext,
                ),
            )
            .toString()
        Arrays.fill(responsePlaintext, 0)
        val resumedClient = E2eRemoteClient(
            connectionFactory = { uri ->
                RecordingConnection(
                    uri.toURL(),
                    requestBodies,
                    failResponse = false,
                    responseBody = responseEnvelope,
                )
            },
            nowEpochSeconds = now::get,
            rpcRetryWait = {},
        )

        assertEquals("ok", resumedClient.resumePending(session)?.getString("kind"))
        assertEquals(1, requestBodies.distinct().size)
        session.close()
        Arrays.fill(responseKey, 0)
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    private fun challengeResponse(
        metadata: PairingMetadata,
        seed: ByteArray,
        clientSessionNonce: String,
    ): String {
        val challengeId = "MDEyMzQ1Njc4OTo7PD0-Pw"
        val serverNonce = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8"
        val expiresAt = 1_060L
        val fields = arrayOf(
            metadata.pairingId,
            metadata.instanceId,
            metadata.clientNonce,
            clientSessionNonce,
            challengeId,
            serverNonce,
            expiresAt.toString(),
        )
        return JSONObject()
            .put("version", E2eProtocol.VERSION)
            .put("instanceId", metadata.instanceId)
            .put("pairingId", metadata.pairingId)
            .put("clientNonce", metadata.clientNonce)
            .put("clientSessionNonce", clientSessionNonce)
            .put("challengeId", challengeId)
            .put("serverNonce", serverNonce)
            .put("challengeExpiresAt", expiresAt)
            .put(
                "serverProof",
                E2eProtocol.proof(seed, E2eProtocol.CHALLENGE_RESPONSE_DOMAIN, fields),
            )
            .toString()
    }

    private fun establishResponse(
        metadata: PairingMetadata,
        seed: ByteArray,
        clientSessionNonce: String,
    ): String {
        val challengeId = "MDEyMzQ1Njc4OTo7PD0-Pw"
        val serverNonce = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8"
        val sessionId = "YGFiY2RlZmdoaWprbG1ubw"
        val expiresAt = 1_900L
        val fields = arrayOf(
            metadata.pairingId,
            metadata.instanceId,
            metadata.clientNonce,
            clientSessionNonce,
            challengeId,
            serverNonce,
            sessionId,
            expiresAt.toString(),
        )
        return JSONObject()
            .put("version", E2eProtocol.VERSION)
            .put("instanceId", metadata.instanceId)
            .put("pairingId", metadata.pairingId)
            .put("clientNonce", metadata.clientNonce)
            .put("clientSessionNonce", clientSessionNonce)
            .put("challengeId", challengeId)
            .put("serverNonce", serverNonce)
            .put("sessionId", sessionId)
            .put("expiresAt", expiresAt)
            .put(
                "serverProof",
                E2eProtocol.proof(seed, E2eProtocol.ESTABLISH_RESPONSE_DOMAIN, fields),
            )
            .toString()
    }

    private class HandshakeConnection(
        url: URL,
        private val responseProvider: (String) -> String,
    ) : HttpURLConnection(url) {
        private val request = ByteArrayOutputStream()
        private var responseBody = ""

        override fun getOutputStream(): ByteArrayOutputStream = request

        override fun getResponseCode(): Int {
            responseBody = responseProvider(request.toString(Charsets.UTF_8.name()))
            return HTTP_OK
        }

        override fun getInputStream(): ByteArrayInputStream =
            ByteArrayInputStream(responseBody.toByteArray())

        override fun connect() = Unit

        override fun disconnect() = Unit

        override fun usingProxy(): Boolean = false
    }

    private class RecordingConnection(
        url: URL,
        private val requestBodies: MutableList<String>,
        private val failResponse: Boolean,
        private val responseBody: String = "{}",
        private val onResponseCode: () -> Unit = {},
        private val requestObserver: ((String) -> Unit)? = null,
    ) : HttpURLConnection(url) {
        private val request = ByteArrayOutputStream()

        override fun getOutputStream(): ByteArrayOutputStream = request

        override fun getResponseCode(): Int {
            val body = request.toString(Charsets.UTF_8.name())
            requestBodies += body
            requestObserver?.invoke(body)
            onResponseCode()
            if (failResponse) throw IOException("simulated response loss")
            return HTTP_OK
        }

        override fun getInputStream(): ByteArrayInputStream =
            ByteArrayInputStream(responseBody.toByteArray())

        override fun connect() = Unit

        override fun disconnect() = Unit

        override fun usingProxy(): Boolean = false
    }
}
