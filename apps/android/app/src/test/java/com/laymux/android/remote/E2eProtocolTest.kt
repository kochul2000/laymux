package com.laymux.android.remote

import com.laymux.android.pairing.PairingMetadata
import com.laymux.android.pairing.StoredPairing
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Arrays
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
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
            E2eHttpBody.json("{\"exact\":true}"),
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

        // An off-tailnet phone pays the direct connect timeout in full before
        // the cloud fallback, so the first direct contact is a single short
        // probe instead of the cloud handshake's two attempts.
        assertEquals(1, directAttempts.size)
        assertNotEquals(
            JSONObject(directAttempts.first()).getString("clientSessionNonce"),
            requireNotNull(cloudClientSessionNonce),
        )
        assertEquals(
            listOf(
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
    fun directProbeUsesAShortConnectTimeoutAndCloudKeepsTheDefault() {
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
        val created = mutableListOf<java.net.HttpURLConnection>()
        var cloudClientSessionNonce: String? = null
        val client = E2eRemoteClient(
            connectionFactory = { uri ->
                if (uri.host == "100.100.10.20") {
                    RecordingConnection(
                        uri.toURL(),
                        mutableListOf(),
                        failResponse = true,
                    )
                } else {
                    HandshakeConnection(uri.toURL()) { body ->
                        val request = JSONObject(body)
                        when {
                            uri.path.endsWith("/session/challenge") -> {
                                val nonce = request.getString("clientSessionNonce")
                                cloudClientSessionNonce = nonce
                                challengeResponse(metadata, seed, nonce)
                            }
                            uri.path.endsWith("/session/establish") -> establishResponse(
                                metadata,
                                seed,
                                requireNotNull(cloudClientSessionNonce),
                            )
                            else -> error("unexpected handshake route: $uri")
                        }
                    }
                }.also(created::add)
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

        assertEquals(
            listOf(
                "100.100.10.20" to E2eRemoteClient.DIRECT_CONNECT_TIMEOUT_MS,
                "relay.example" to 10_000,
                "relay.example" to 10_000,
            ),
            created.map { it.url.host to it.connectTimeout },
        )
        session.close()
        Arrays.fill(seed, 0)
    }

    /**
     * 같은-릴리즈 계약의 호환 게이트 (ADR-0172): challenge 응답의
     * compatVersion이 앱과 다르면 방향에 맞는 안내로 연결을 접는다.
     * 필드 부재(버저닝 도입 전 데스크톱)는 PC 구버전으로 취급한다.
     */
    @Test
    fun compatVersionMismatchFailsClosedWithDirectionalGuidance() {
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

        fun openAgainst(compatVersion: Int): Exception? = try {
            var clientSessionNonce: String? = null
            val client = E2eRemoteClient(
                connectionFactory = { uri ->
                    HandshakeConnection(uri.toURL()) { body ->
                        val request = JSONObject(body)
                        when {
                            uri.path.endsWith("/session/challenge") -> {
                                val nonce = request.getString("clientSessionNonce")
                                clientSessionNonce = nonce
                                challengeResponse(
                                    metadata,
                                    seed,
                                    nonce,
                                    compatVersion = compatVersion,
                                )
                            }
                            uri.path.endsWith("/session/establish") -> establishResponse(
                                metadata,
                                seed,
                                requireNotNull(clientSessionNonce),
                            )
                            else -> error("unexpected handshake route: $uri")
                        }
                    }
                },
                nowEpochSeconds = { 1_000 },
            )
            StoredPairing(metadata, seed.copyOf()).use { pairing ->
                client.open(pairing).close()
            }
            null
        } catch (error: Exception) {
            error
        }

        val older = openAgainst(0)
        assertTrue("actual: $older", older is E2eProtocolException)
        assertTrue("msg: ${older?.message}", requireNotNull(older?.message).contains("PC Laymux가 구버전"))

        val newer = openAgainst(E2eProtocol.COMPAT_VERSION + 1)
        assertTrue("actual: $newer", newer is E2eProtocolException)
        assertTrue("msg: ${newer?.message}", requireNotNull(newer?.message).contains("앱이 구버전"))

        // 일치하면 게이트를 그대로 통과해 세션이 열린다.
        val matched = openAgainst(E2eProtocol.COMPAT_VERSION)
        assertTrue("actual: $matched", matched == null)

        Arrays.fill(seed, 0)
    }

    /**
     * desktop의 android_e2e/mod.rs COMPAT_VERSION과 항상 같은 값이어야 한다
     * (ADR-0172). 양쪽 리포지터리가 언어가 달라 공유 상수를 둘 수 없으므로,
     * 각자 리터럴로 핀해 비호환 변경 PR이 두 파일을 모두 건드리게 만든다 —
     * Rust 쪽 동일 핀은 android_e2e::state_tests에 있다.
     */
    @Test
    fun compatVersionIsPinnedToTheSharedContractNumber() {
        // 2: RPC 요청 binary envelope (ADR-0351).
        assertEquals(2, E2eProtocol.COMPAT_VERSION)
    }

    @Test
    fun rpcRequestEnvelopeIsTheBinaryLayoutAroundAnUnchangedAead() {
        val requestKey = ByteArray(32) { 1 }
        val session = RemoteSession(
            "https://relay.example/",
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            1_000,
            requestKey.copyOf(),
            ByteArray(32) { 2 },
            nowEpochSeconds = { 100 },
        )
        val plaintext = "{\"kind\":\"test\"}"
        val envelope = session.prepareRequest(plaintext).envelope

        assertEquals(31, E2eProtocol.RPC_ENVELOPE_PREFIX_BYTES)
        assertEquals(2.toByte(), envelope[0])
        assertEquals(
            "YGFiY2RlZmdoaWprbG1ubw",
            String(envelope.copyOfRange(1, 23), Charsets.US_ASCII),
        )
        assertArrayEquals(ByteArray(8), envelope.copyOfRange(23, 31))
        val ciphertext = envelope.copyOfRange(31, envelope.size)
        assertEquals(plaintext.length + E2eProtocol.GCM_TAG_BYTES, ciphertext.size)
        // The AEAD is exactly what the JSON envelope carried, minus base64.
        assertArrayEquals(
            plaintext.toByteArray(),
            E2eProtocol.decrypt(
                requestKey,
                E2eProtocol.A2D_AAD_DOMAIN,
                "desktop-7",
                "YGFiY2RlZmdoaWprbG1ubw",
                0,
                E2eProtocol.encode(ciphertext),
            ),
        )
        // The instance id is not on the wire but still bound by the AAD.
        assertThrows(E2eProtocolException::class.java) {
            E2eProtocol.decrypt(
                requestKey,
                E2eProtocol.A2D_AAD_DOMAIN,
                "desktop-8",
                "YGFiY2RlZmdoaWprbG1ubw",
                0,
                E2eProtocol.encode(ciphertext),
            )
        }
        session.close()
        Arrays.fill(requestKey, 0)
    }

    @Test
    fun rpcRequestEnvelopeEncodesTheSequenceBigEndian() {
        val envelope = E2eProtocol.rpcRequestEnvelope(
            "YGFiY2RlZmdoaWprbG1ubw",
            0x0001_0203_0405_0607L,
            ByteArray(E2eProtocol.GCM_TAG_BYTES) { 9 },
        )
        assertArrayEquals(byteArrayOf(0, 1, 2, 3, 4, 5, 6, 7), envelope.copyOfRange(23, 31))
        assertEquals(31 + E2eProtocol.GCM_TAG_BYTES, envelope.size)
        assertThrows(IllegalArgumentException::class.java) {
            E2eProtocol.rpcRequestEnvelope("short", 0, ByteArray(16))
        }
        assertThrows(IllegalArgumentException::class.java) {
            E2eProtocol.rpcRequestEnvelope(
                "YGFiY2RlZmdoaWprbG1ubw",
                E2eProtocol.MAX_SEQUENCE + 1,
                ByteArray(16),
            )
        }
    }

    @Test
    fun rpcPostsBinaryWithTheInstanceHeaderOnCloudAndDirect() {
        for ((transport, expectedUrl) in listOf(
            E2eTransport.cloud("https://relay.example/") to
                "https://relay.example/api/android/e2e/rpc/binary",
            E2eTransport.tailscale("http://100.64.0.1:19280/remote/") to
                "http://100.64.0.1:19280/remote/v1/e2e/rpc",
        )) {
            val responseKey = ByteArray(32) { 2 }
            val sent = mutableListOf<RecordingConnection>()
            val client = E2eRemoteClient(
                connectionFactory = { uri ->
                    RecordingConnection(
                        uri.toURL(),
                        mutableListOf(),
                        failResponse = false,
                        responseBody = okResponseEnvelope(responseKey, 0),
                    ).also(sent::add)
                },
                nowEpochSeconds = { 100 },
                rpcRetryWait = {},
            )
            val session = RemoteSession(
                transport.endpoint,
                "desktop-7",
                "YGFiY2RlZmdoaWprbG1ubw",
                1_000,
                ByteArray(32) { 1 },
                responseKey.copyOf(),
                nowEpochSeconds = { 100 },
                transport = transport,
            )
            val pending = session.prepareRequest("{\"kind\":\"test\"}")

            assertEquals("ok", client.resumePending(session)?.getString("kind"))
            val connection = sent.single()
            assertEquals(expectedUrl, connection.url.toString())
            assertEquals("POST", connection.requestMethod)
            assertEquals("application/octet-stream", connection.sentContentType)
            assertEquals("application/json", connection.sentAccept)
            assertEquals("desktop-7", connection.sentInstanceHeader)
            assertEquals(pending.envelope.size.toLong(), connection.sentFixedLength)
            assertArrayEquals(pending.envelope, connection.sentBody)
            session.close()
            Arrays.fill(responseKey, 0)
        }
    }

    @Test
    fun rpcRetryResendsTheExactBinaryEnvelope() {
        val responseKey = ByteArray(32) { 2 }
        val sent = mutableListOf<RecordingConnection>()
        val client = E2eRemoteClient(
            connectionFactory = { uri ->
                RecordingConnection(
                    uri.toURL(),
                    mutableListOf(),
                    failResponse = sent.size < 3,
                    responseBody = okResponseEnvelope(responseKey, 0),
                ).also(sent::add)
            },
            nowEpochSeconds = { 100 },
            rpcRetryWait = {},
        )
        val session = RemoteSession(
            "https://relay.example/",
            "desktop-7",
            "YGFiY2RlZmdoaWprbG1ubw",
            1_000,
            ByteArray(32) { 1 },
            responseKey.copyOf(),
            nowEpochSeconds = { 100 },
        )

        assertEquals("ok", client.rpc(session, JSONObject().put("kind", "test")).getString("kind"))
        assertEquals(4, sent.size)
        sent.forEach { connection ->
            assertArrayEquals(sent.first().sentBody, connection.sentBody)
            assertEquals("desktop-7", connection.sentInstanceHeader)
        }
        session.close()
        Arrays.fill(responseKey, 0)
    }

    @Test
    fun handshakePostsStayJsonWithoutTheInstanceHeader() {
        val sent = mutableListOf<RecordingConnection>()
        val client = E2eRemoteClient(
            connectionFactory = { uri ->
                RecordingConnection(uri.toURL(), mutableListOf(), failResponse = false)
                    .also(sent::add)
            },
        )
        client.postWithRetry(
            "https://relay.example/",
            "/api/android/e2e/session/challenge",
            E2eHttpBody.json("{\"exact\":true}"),
            1024,
            attempts = 1,
            invalidatesSession = false,
        )
        val connection = sent.single()
        assertEquals("application/json", connection.sentContentType)
        assertEquals(null, connection.sentInstanceHeader)
        assertEquals("{\"exact\":true}", String(connection.sentBody, Charsets.UTF_8))
    }

    private fun okResponseEnvelope(responseKey: ByteArray, sequence: Long): String {
        val responsePlaintext = JSONObject()
            .put("version", E2eProtocol.VERSION)
            .put("expiresAt", 1_000)
            .put("response", JSONObject().put("kind", "ok"))
            .toString()
            .toByteArray()
        return try {
            JSONObject()
                .put("version", E2eProtocol.VERSION)
                .put("instanceId", "desktop-7")
                .put("sessionId", "YGFiY2RlZmdoaWprbG1ubw")
                .put("sequence", sequence)
                .put(
                    "ciphertext",
                    E2eProtocol.encrypt(
                        responseKey,
                        E2eProtocol.D2A_AAD_DOMAIN,
                        "desktop-7",
                        "YGFiY2RlZmdoaWprbG1ubw",
                        sequence,
                        responsePlaintext,
                    ),
                )
                .toString()
        } finally {
            Arrays.fill(responsePlaintext, 0)
        }
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

    private fun scriptedRpcClient(
        steps: List<RpcStep>,
        sent: MutableList<RpcStep>,
        responseBody: String = "{}",
        onRetryWait: () -> Unit = {},
    ): E2eRemoteClient = E2eRemoteClient(
        connectionFactory = { uri ->
            val step = steps[sent.size]
            sent += step
            ScriptedConnection(uri.toURL(), step, responseBody)
        },
        nowEpochSeconds = { 100 },
        rpcRetryWait = onRetryWait,
    )

    private fun rpcSession(transport: E2eTransport, responseKey: ByteArray) = RemoteSession(
        transport.endpoint,
        "desktop-7",
        "YGFiY2RlZmdoaWprbG1ubw",
        1_000,
        ByteArray(32) { 1 },
        responseKey.copyOf(),
        nowEpochSeconds = { 100 },
        transport = transport,
    )

    @Test
    fun repeatedBodyWriteFailuresStopTheRetryLoopAndInvalidateTheSession() {
        val sent = mutableListOf<RpcStep>()
        var waits = 0
        // Without the cap this would loop until the session deadline.
        val client = scriptedRpcClient(List(50) { RpcStep.WRITE_FAILS }, sent, onRetryWait = {
            waits += 1
        })
        val session = rpcSession(E2eTransport.cloud("https://relay.example/"), ByteArray(32) { 2 })

        val error = assertThrows(E2eTransportException::class.java) {
            client.rpc(session, JSONObject().put("kind", "test"))
        }

        assertEquals(E2eRemoteClient.RPC_BODY_WRITE_FAILURE_LIMIT, sent.size)
        assertEquals(0, waits)
        assertEquals(false, error.retryable)
        assertEquals(true, error.invalidatesSession)
        assertEquals(E2eTransportFailureKind.OTHER, error.failureKind)
        assertTrue((error.cause as E2eTransportException).bodyWriteFailed)
        session.close()
    }

    @Test
    fun bodyWriteFailuresAreCountedAcrossRetryBatches() {
        val sent = mutableListOf<RpcStep>()
        var waits = 0
        val client = scriptedRpcClient(
            listOf(
                RpcStep.WRITE_FAILS,
                RpcStep.RESPONSE_FAILS,
                RpcStep.RESPONSE_FAILS,
                RpcStep.WRITE_FAILS,
                RpcStep.OK,
            ),
            sent,
            onRetryWait = { waits += 1 },
        )
        val session = rpcSession(E2eTransport.cloud("https://relay.example/"), ByteArray(32) { 2 })

        val error = assertThrows(E2eTransportException::class.java) {
            client.rpc(session, JSONObject().put("kind", "test"))
        }

        // Response-phase losses keep the existing retry; the second body
        // failure of the same request ends it.
        assertEquals(4, sent.size)
        assertEquals(1, waits)
        assertEquals(true, error.invalidatesSession)
        session.close()
    }

    @Test
    fun directRetriesOneBodyWriteFailureWithoutFallingBack() {
        val responseKey = ByteArray(32) { 2 }
        val sent = mutableListOf<RpcStep>()
        val client = scriptedRpcClient(
            listOf(RpcStep.WRITE_FAILS, RpcStep.OK),
            sent,
            responseBody = okResponseEnvelope(responseKey, 0),
        )
        val session = rpcSession(
            E2eTransport.tailscale("http://100.64.0.1:19280/remote/"),
            responseKey,
        )

        assertEquals("ok", client.rpc(session, JSONObject().put("kind", "test")).getString("kind"))
        assertEquals(listOf(RpcStep.WRITE_FAILS, RpcStep.OK), sent)
        session.close()
        Arrays.fill(responseKey, 0)
    }

    @Test
    fun directRepeatedBodyWriteFailureReestablishesInsteadOfFallingBackToCloud() {
        val sent = mutableListOf<RpcStep>()
        val transport = E2eTransport.tailscale("http://100.64.0.1:19280/remote/")
        val client = scriptedRpcClient(List(10) { RpcStep.WRITE_FAILS }, sent)
        val session = rpcSession(transport, ByteArray(32) { 2 })

        val error = assertThrows(E2eTransportException::class.java) {
            client.rpc(session, JSONObject().put("kind", "test"))
        }

        assertEquals(E2eRemoteClient.RPC_BODY_WRITE_FAILURE_LIMIT, sent.size)
        assertEquals(true, error.invalidatesSession)
        // Re-establishing runs the Direct-first probe again, which still
        // falls back to Cloud when the tailnet is really gone.
        assertEquals(
            false,
            E2eTransportPolicy.shouldFallbackActiveSession(transport.kind, error.failureKind),
        )
        session.close()
    }

    @Test
    fun handshakeBodyWriteFailureStaysANetworkFailure() {
        val sent = mutableListOf<RpcStep>()
        val client = scriptedRpcClient(List(4) { RpcStep.WRITE_FAILS }, sent)

        val error = assertThrows(E2eTransportException::class.java) {
            client.postWithRetry(
                "http://100.64.0.1:19280/remote/",
                "/remote/v1/e2e/session/challenge",
                E2eHttpBody.json("{}"),
                1024,
                attempts = 2,
                invalidatesSession = false,
            )
        }

        assertEquals(2, sent.size)
        assertEquals(E2eTransportFailureKind.NETWORK, error.failureKind)
        assertTrue(E2eTransportPolicy.shouldFallbackToCloud(error))
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
        compatVersion: Int = E2eProtocol.COMPAT_VERSION,
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
        val response = JSONObject()
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
        // 0 = 버저닝 도입 전 데스크톱(필드 부재) 시뮬레이션.
        if (compatVersion != 0) response.put("compatVersion", compatVersion)
        return response.toString()
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

    private enum class RpcStep { OK, WRITE_FAILS, RESPONSE_FAILS }

    /** Connects, then fails while the body is written, while the response is read, or not at all. */
    private class ScriptedConnection(
        url: URL,
        private val step: RpcStep,
        private val responseBody: String,
    ) : HttpURLConnection(url) {
        override fun getOutputStream(): OutputStream = object : OutputStream() {
            override fun write(b: Int) {
                if (step == RpcStep.WRITE_FAILS) throw IOException("simulated connection reset")
            }

            override fun write(b: ByteArray, off: Int, len: Int) {
                if (step == RpcStep.WRITE_FAILS) throw IOException("simulated connection reset")
            }
        }

        override fun getResponseCode(): Int {
            check(step != RpcStep.WRITE_FAILS) { "status read after a failed body write" }
            if (step == RpcStep.RESPONSE_FAILS) throw IOException("simulated response loss")
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
        var sentBody = ByteArray(0)
            private set
        var sentContentType: String? = null
            private set
        var sentAccept: String? = null
            private set
        var sentInstanceHeader: String? = null
            private set
        var sentFixedLength = -1L
            private set

        override fun getOutputStream(): ByteArrayOutputStream = request

        override fun getResponseCode(): Int {
            sentBody = request.toByteArray()
            sentContentType = getRequestProperty("Content-Type")
            sentAccept = getRequestProperty("Accept")
            sentInstanceHeader = getRequestProperty(E2eProtocol.INSTANCE_HEADER)
            sentFixedLength = fixedContentLengthLong
            // ISO-8859-1 keeps binary bodies byte-exact for equality checks.
            val body = request.toString(Charsets.ISO_8859_1.name())
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
