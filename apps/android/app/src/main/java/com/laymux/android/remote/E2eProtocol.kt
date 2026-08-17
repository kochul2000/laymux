package com.laymux.android.remote

import com.laymux.android.pairing.Base64Url
import com.laymux.android.pairing.PairingMetadata
import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Arrays
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

internal data class VerifiedChallenge(
    val metadata: PairingMetadata,
    val clientSessionNonce: String,
    val challengeId: String,
    val serverNonce: String,
    val challengeExpiresAtEpochSeconds: Long,
)

internal data class PendingRpc(
    val sequence: Long,
    val envelopeJson: String,
)

internal class RemoteSession internal constructor(
    val endpoint: String,
    val instanceId: String,
    val sessionId: String,
    expiresAtEpochSeconds: Long,
    private val requestKey: ByteArray,
    private val responseKey: ByteArray,
    private val nowEpochSeconds: () -> Long,
    val transport: E2eTransport = E2eTransport.cloud(endpoint),
) : Closeable {
    @Volatile
    var expiresAtEpochSeconds = expiresAtEpochSeconds
        private set
    private var nextSequence = 0L
    private var inFlight: PendingRpc? = null
    @Volatile
    private var closed = false
    @Volatile
    private var suspendedForBackground = false
    private var backgroundExpiryCap: Long? = null

    @Synchronized
    fun prepareRequest(plaintextJson: String): PendingRpc {
        checkActive()
        if (suspendedForBackground) throw E2eSessionSuspendedException()
        if (inFlight != null) {
            throw E2eProtocolException(
                "보안 세션에는 한 번에 하나의 요청만 보낼 수 있습니다.",
                invalidatesSession = true,
            )
        }
        if (nextSequence > E2eProtocol.MAX_SEQUENCE) {
            throw E2eProtocolException("보안 세션 sequence를 모두 사용했습니다.", invalidatesSession = true)
        }
        JSONObject(plaintextJson)
        val ciphertext = E2eProtocol.encrypt(
            requestKey,
            E2eProtocol.A2D_AAD_DOMAIN,
            instanceId,
            sessionId,
            nextSequence,
            plaintextJson.toByteArray(StandardCharsets.UTF_8),
        )
        return PendingRpc(
            sequence = nextSequence,
            envelopeJson =
                "{\"version\":${E2eProtocol.VERSION}," +
                    "\"instanceId\":\"$instanceId\"," +
                    "\"sessionId\":\"$sessionId\"," +
                    "\"sequence\":$nextSequence," +
                    "\"ciphertext\":\"$ciphertext\"}",
        ).also { inFlight = it }
    }

    @Synchronized
    fun completeRequest(pending: PendingRpc, rawResponse: String): String {
        if (suspendedForBackground) throw E2eSessionSuspendedException()
        if (pending !== inFlight || pending.sequence != nextSequence) {
            throw E2eProtocolException("보안 세션 요청 순서가 변경됐습니다.", invalidatesSession = true)
        }
        val response = E2eProtocol.strictObject(
            rawResponse,
            setOf("version", "instanceId", "sessionId", "sequence", "ciphertext"),
        )
        if (response.optInt("version", -1) != E2eProtocol.VERSION ||
            response.optString("instanceId") != instanceId ||
            response.optString("sessionId") != sessionId ||
            response.optLong("sequence", -1) != nextSequence
        ) {
            throw E2eProtocolException("보안 응답 식별자가 일치하지 않습니다.", invalidatesSession = true)
        }
        val plaintext = E2eProtocol.decrypt(
            responseKey,
            E2eProtocol.D2A_AAD_DOMAIN,
            instanceId,
            sessionId,
            nextSequence,
            response.optString("ciphertext"),
        )
        return try {
            val decoded = plaintext.toString(StandardCharsets.UTF_8)
            val secured = E2eProtocol.strictObject(
                decoded,
                setOf("version", "expiresAt", "response"),
            )
            val now = nowEpochSeconds()
            val responseBody = secured.opt("response") as? JSONObject
            if (secured.optInt("version", -1) != E2eProtocol.VERSION || responseBody == null) {
                throw E2eProtocolException(
                    "보안 응답 payload가 올바르지 않습니다.",
                    invalidatesSession = true,
                )
            }
            val authenticatedExpiry = E2eProtocol.boundedSessionExpiry(
                secured.optLong("expiresAt", -1),
                now,
            )
            expiresAtEpochSeconds = backgroundExpiryCap
                ?.let { minOf(authenticatedExpiry, it) }
                ?: authenticatedExpiry
            backgroundExpiryCap = null
            nextSequence += 1
            inFlight = null
            responseBody.toString()
        } finally {
            Arrays.fill(plaintext, 0)
        }
    }

    @Synchronized
    fun isExpired(now: Long = nowEpochSeconds()): Boolean = closed || now >= expiresAtEpochSeconds

    fun inactivitySecondsRemaining(now: Long = nowEpochSeconds()): Long =
        (expiresAtEpochSeconds - now).coerceAtLeast(0)

    @Synchronized
    fun suspendForBackground() {
        if (!closed) {
            backgroundExpiryCap = backgroundExpiryCap ?: expiresAtEpochSeconds
            suspendedForBackground = true
        }
    }

    @Synchronized
    fun resumeFromBackground(): Boolean {
        if (isExpired()) return false
        suspendedForBackground = false
        if (inFlight == null) backgroundExpiryCap = null
        return true
    }

    fun isSuspendedForBackground(): Boolean = suspendedForBackground

    @Synchronized
    fun requireTransportAllowed() {
        if (suspendedForBackground) throw E2eSessionSuspendedException()
        checkActive()
    }

    @Synchronized
    fun openOutputCipher(streamNonce: String): E2eOutputCipher {
        requireTransportAllowed()
        val keys = E2eOutputProtocol.deriveKeys(
            requestKey,
            responseKey,
            instanceId,
            sessionId,
            streamNonce,
        )
        return E2eOutputCipher(
            instanceId,
            sessionId,
            streamNonce,
            keys.first,
            keys.second,
        )
    }

    @Synchronized
    fun pendingRequest(): PendingRpc? = inFlight

    @Synchronized
    override fun close() {
        closed = true
        suspendedForBackground = false
        backgroundExpiryCap = null
        Arrays.fill(requestKey, 0)
        Arrays.fill(responseKey, 0)
        inFlight = null
        nextSequence = E2eProtocol.MAX_SEQUENCE + 1
    }

    private fun checkActive() {
        if (isExpired()) {
            throw E2eProtocolException("보안 세션이 만료됐습니다.", invalidatesSession = true)
        }
    }
}

internal class E2eProtocolException(
    message: String,
    val invalidatesSession: Boolean = false,
    cause: Throwable? = null,
) : Exception(message, cause)

internal class E2eSessionSuspendedException : Exception("보안 세션이 백그라운드에서 일시 중지됐습니다.")

internal object E2eProtocol {
    const val VERSION = 1

    // desktop↔앱 같은-릴리즈 계약의 호환 번호 (ADR-0171). 비호환 변경이
    // 실릴 때만 1씩 올린다 — 릴리즈마다 올리지 않는다. desktop의
    // COMPAT_VERSION(android_e2e/mod.rs)과 항상 같은 값이어야 한다.
    const val COMPAT_VERSION = 1

    const val MAX_SEQUENCE = 9_007_199_254_740_991L
    const val CLIENT_SESSION_NONCE_BYTES = 16
    const val SESSION_ID_BYTES = 16
    const val CHALLENGE_ID_BYTES = 16
    const val SERVER_NONCE_BYTES = 32
    const val PROOF_BYTES = 32
    const val KEY_BYTES = 32
    const val SESSION_INACTIVITY_TIMEOUT_SECONDS = 15 * 60L
    const val GCM_TAG_BITS = 128
    const val GCM_TAG_BYTES = GCM_TAG_BITS / Byte.SIZE_BITS

    const val CHALLENGE_RESPONSE_DOMAIN = "laymux.android-e2e.challenge.response.v1"
    const val ESTABLISH_REQUEST_DOMAIN = "laymux.android-e2e.establish.request.v1"
    const val ESTABLISH_RESPONSE_DOMAIN = "laymux.android-e2e.establish.response.v1"
    const val HKDF_SALT_DOMAIN = "laymux.android-e2e.hkdf.salt.v1"
    const val A2D_INFO = "laymux.android-e2e.a2d.v1"
    const val D2A_INFO = "laymux.android-e2e.d2a.v1"
    const val A2D_AAD_DOMAIN = "laymux.android-e2e.a2d.aad.v1"
    const val D2A_AAD_DOMAIN = "laymux.android-e2e.d2a.aad.v1"

    internal fun boundedSessionExpiry(authenticatedExpiresAt: Long, now: Long): Long {
        if (now < 0 ||
            authenticatedExpiresAt <= now ||
            now > Long.MAX_VALUE - SESSION_INACTIVITY_TIMEOUT_SECONDS
        ) {
            throw E2eProtocolException(
                "보안 세션 만료 시각이 올바르지 않습니다.",
                invalidatesSession = true,
            )
        }
        return minOf(authenticatedExpiresAt, now + SESSION_INACTIVITY_TIMEOUT_SECONDS)
    }

    fun newClientSessionNonce(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(CLIENT_SESSION_NONCE_BYTES)
        random.nextBytes(bytes)
        return try {
            encode(bytes)
        } finally {
            Arrays.fill(bytes, 0)
        }
    }

    fun challengeRequest(metadata: PairingMetadata, clientSessionNonce: String): String {
        require(decodeExact(clientSessionNonce, CLIENT_SESSION_NONCE_BYTES) != null)
        return JSONObject()
            .put("version", VERSION)
            .put("instanceId", metadata.instanceId)
            .put("pairingId", metadata.pairingId)
            .put("clientNonce", metadata.clientNonce)
            .put("clientSessionNonce", clientSessionNonce)
            .toString()
    }

    fun verifyChallenge(
        metadata: PairingMetadata,
        clientSessionNonce: String,
        seed: ByteArray,
        rawResponse: String,
        nowEpochSeconds: Long,
    ): VerifiedChallenge {
        val response = strictObject(
            rawResponse,
            setOf(
                "version",
                "instanceId",
                "pairingId",
                "clientNonce",
                "clientSessionNonce",
                "challengeId",
                "serverNonce",
                "challengeExpiresAt",
                "serverProof",
            ),
            // 버저닝 도입 전 데스크톱엔 없다 — 부재는 아래 게이트가 PC
            // 구버전으로 안내한다.
            optionalKeys = setOf("compatVersion"),
        )
        // 같은-릴리즈 계약의 호환 게이트 (ADR-0171). proof에 안 실리는 표시
        // 전용 필드다 — 위조해 봐야 이 오류를 띄우고 연결을 접게 만들 뿐,
        // relay가 이미 가진 연결 거부 능력을 넘지 않는다. 필드 부재(0)는
        // 버저닝 도입 전 데스크톱이다.
        val compatVersion = response.optInt("compatVersion", 0)
        if (compatVersion != COMPAT_VERSION) {
            throw E2eProtocolException(
                if (compatVersion < COMPAT_VERSION) {
                    "PC Laymux가 구버전이라 연결할 수 없습니다. PC를 업데이트하세요."
                } else {
                    "앱이 구버전이라 연결할 수 없습니다. 앱을 업데이트하세요."
                },
            )
        }
        val challengeId = response.optString("challengeId")
        val serverNonce = response.optString("serverNonce")
        val challengeExpiresAt = response.optLong("challengeExpiresAt", -1)
        val validEcho = response.optInt("version", -1) == VERSION &&
            response.optString("instanceId") == metadata.instanceId &&
            response.optString("pairingId") == metadata.pairingId &&
            response.optString("clientNonce") == metadata.clientNonce &&
            response.optString("clientSessionNonce") == clientSessionNonce
        if (!validEcho ||
            decodeExact(challengeId, CHALLENGE_ID_BYTES) == null ||
            decodeExact(serverNonce, SERVER_NONCE_BYTES) == null ||
            challengeExpiresAt <= nowEpochSeconds
        ) {
            throw E2eProtocolException("데스크톱 보안 challenge가 올바르지 않습니다.")
        }
        val fields = arrayOf(
            metadata.pairingId,
            metadata.instanceId,
            metadata.clientNonce,
            clientSessionNonce,
            challengeId,
            serverNonce,
            challengeExpiresAt.toString(),
        )
        if (!verifyProof(
                seed,
                CHALLENGE_RESPONSE_DOMAIN,
                fields,
                response.optString("serverProof"),
            )
        ) {
            throw E2eProtocolException("데스크톱 보안 challenge 증명이 일치하지 않습니다.")
        }
        return VerifiedChallenge(
            metadata,
            clientSessionNonce,
            challengeId,
            serverNonce,
            challengeExpiresAt,
        )
    }

    fun establishRequest(challenge: VerifiedChallenge, seed: ByteArray): String {
        val metadata = challenge.metadata
        val fields = arrayOf(
            metadata.pairingId,
            metadata.instanceId,
            metadata.clientNonce,
            challenge.clientSessionNonce,
            challenge.challengeId,
            challenge.serverNonce,
            challenge.challengeExpiresAtEpochSeconds.toString(),
        )
        return JSONObject()
            .put("version", VERSION)
            .put("instanceId", metadata.instanceId)
            .put("pairingId", metadata.pairingId)
            .put("clientNonce", metadata.clientNonce)
            .put("clientSessionNonce", challenge.clientSessionNonce)
            .put("challengeId", challenge.challengeId)
            .put("clientProof", proof(seed, ESTABLISH_REQUEST_DOMAIN, fields))
            .toString()
    }

    fun verifyEstablished(
        challenge: VerifiedChallenge,
        seed: ByteArray,
        transport: E2eTransport,
        rawResponse: String,
        nowEpochSeconds: () -> Long = { System.currentTimeMillis() / 1_000 },
    ): RemoteSession {
        val response = strictObject(
            rawResponse,
            setOf(
                "version",
                "instanceId",
                "pairingId",
                "clientNonce",
                "clientSessionNonce",
                "challengeId",
                "serverNonce",
                "sessionId",
                "expiresAt",
                "serverProof",
            ),
        )
        val metadata = challenge.metadata
        val sessionId = response.optString("sessionId")
        val expiresAt = response.optLong("expiresAt", -1)
        val now = nowEpochSeconds()
        val validEcho = response.optInt("version", -1) == VERSION &&
            response.optString("instanceId") == metadata.instanceId &&
            response.optString("pairingId") == metadata.pairingId &&
            response.optString("clientNonce") == metadata.clientNonce &&
            response.optString("clientSessionNonce") == challenge.clientSessionNonce &&
            response.optString("challengeId") == challenge.challengeId &&
            response.optString("serverNonce") == challenge.serverNonce
        if (!validEcho ||
            decodeExact(sessionId, SESSION_ID_BYTES) == null ||
            expiresAt <= now
        ) {
            throw E2eProtocolException("데스크톱 보안 세션 응답이 올바르지 않습니다.")
        }
        val responseFields = arrayOf(
            metadata.pairingId,
            metadata.instanceId,
            metadata.clientNonce,
            challenge.clientSessionNonce,
            challenge.challengeId,
            challenge.serverNonce,
            sessionId,
            expiresAt.toString(),
        )
        if (!verifyProof(
                seed,
                ESTABLISH_RESPONSE_DOMAIN,
                responseFields,
                response.optString("serverProof"),
            )
        ) {
            throw E2eProtocolException("데스크톱 보안 세션 증명이 일치하지 않습니다.")
        }
        val keyFields = arrayOf(
            metadata.pairingId,
            metadata.instanceId,
            metadata.clientNonce,
            challenge.clientSessionNonce,
            challenge.serverNonce,
            sessionId,
        )
        val keys = deriveKeys(seed, keyFields)
        val localExpiresAt = boundedSessionExpiry(expiresAt, now)
        return RemoteSession(
            transport.endpoint,
            metadata.instanceId,
            sessionId,
            localExpiresAt,
            keys.first,
            keys.second,
            nowEpochSeconds,
            transport,
        )
    }

    internal fun deriveKeys(seed: ByteArray, fields: Array<String>): Pair<ByteArray, ByteArray> {
        val saltInput = framed(HKDF_SALT_DOMAIN, fields)
        val salt = MessageDigest.getInstance("SHA-256").digest(saltInput)
        Arrays.fill(saltInput, 0)
        val prk = hmac(salt, seed)
        Arrays.fill(salt, 0)
        return try {
            Pair(hkdfExpand(prk, A2D_INFO), hkdfExpand(prk, D2A_INFO))
        } finally {
            Arrays.fill(prk, 0)
        }
    }

    internal fun proof(seed: ByteArray, domain: String, fields: Array<String>): String =
        encode(hmac(seed, framed(domain, fields)))

    internal fun encrypt(
        key: ByteArray,
        aadDomain: String,
        instanceId: String,
        sessionId: String,
        sequence: Long,
        plaintext: ByteArray,
    ): String {
        require(sequence in 0..MAX_SEQUENCE)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(GCM_TAG_BITS, sequenceNonce(sequence)),
        )
        cipher.updateAAD(envelopeAad(aadDomain, instanceId, sessionId, sequence))
        return encode(cipher.doFinal(plaintext))
    }

    internal fun decrypt(
        key: ByteArray,
        aadDomain: String,
        instanceId: String,
        sessionId: String,
        sequence: Long,
        encodedCiphertext: String,
    ): ByteArray {
        if (sequence !in 0..MAX_SEQUENCE) {
            throw E2eProtocolException("보안 응답 sequence가 올바르지 않습니다.", true)
        }
        val ciphertext = decodeCanonical(encodedCiphertext)
            ?: throw E2eProtocolException("보안 응답 암호문이 올바르지 않습니다.", true)
        if (ciphertext.size < GCM_TAG_BYTES) {
            Arrays.fill(ciphertext, 0)
            throw E2eProtocolException("보안 응답 암호문이 너무 짧습니다.", true)
        }
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(GCM_TAG_BITS, sequenceNonce(sequence)),
            )
            cipher.updateAAD(envelopeAad(aadDomain, instanceId, sessionId, sequence))
            cipher.doFinal(ciphertext)
        } catch (error: Exception) {
            throw E2eProtocolException("보안 응답 인증에 실패했습니다.", true, error)
        } finally {
            Arrays.fill(ciphertext, 0)
        }
    }

    internal fun strictObject(
        raw: String,
        expectedKeys: Set<String>,
        optionalKeys: Set<String> = emptySet(),
    ): JSONObject {
        val json = try {
            JSONObject(raw)
        } catch (error: Exception) {
            throw E2eProtocolException("보안 응답 JSON이 올바르지 않습니다.", cause = error)
        }
        val actual = mutableSetOf<String>()
        val keys = json.keys()
        while (keys.hasNext()) actual.add(keys.next())
        // optional 은 있어도 되고 없어도 되지만, 그 밖의 미지의 필드는 계속
        // fail closed 다. (compatVersion 처럼 구 데스크톱엔 없는 필드용)
        if ((actual - optionalKeys) != expectedKeys) {
            throw E2eProtocolException("보안 응답 필드가 올바르지 않습니다.")
        }
        return json
    }

    private fun verifyProof(
        seed: ByteArray,
        domain: String,
        fields: Array<String>,
        provided: String,
    ): Boolean {
        val decoded = decodeExact(provided, PROOF_BYTES) ?: return false
        val expected = hmac(seed, framed(domain, fields))
        return try {
            MessageDigest.isEqual(expected, decoded)
        } finally {
            Arrays.fill(decoded, 0)
            Arrays.fill(expected, 0)
        }
    }

    private fun hkdfExpand(prk: ByteArray, info: String): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        mac.update(info.toByteArray(StandardCharsets.UTF_8))
        mac.update(1.toByte())
        return mac.doFinal().also { check(it.size == KEY_BYTES) }
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    private fun framed(domain: String, fields: Array<String>): ByteArray {
        val domainBytes = domain.toByteArray(StandardCharsets.UTF_8)
        val fieldBytes = fields.map { it.toByteArray(StandardCharsets.UTF_8) }
        val size = domainBytes.size + fieldBytes.sumOf { Int.SIZE_BYTES + it.size }
        return ByteBuffer.allocate(size).order(ByteOrder.BIG_ENDIAN).apply {
            put(domainBytes)
            fieldBytes.forEach { bytes ->
                putInt(bytes.size)
                put(bytes)
            }
        }.array()
    }

    private fun envelopeAad(
        domain: String,
        instanceId: String,
        sessionId: String,
        sequence: Long,
    ): ByteArray {
        val prefix = framed(domain, emptyArray())
        val fields = framed("", arrayOf(instanceId, sessionId))
        return ByteBuffer.allocate(prefix.size + 1 + fields.size + Long.SIZE_BYTES)
            .order(ByteOrder.BIG_ENDIAN)
            .put(prefix)
            .put(VERSION.toByte())
            .put(fields)
            .putLong(sequence)
            .array()
    }

    private fun sequenceNonce(sequence: Long): ByteArray =
        ByteBuffer.allocate(12).order(ByteOrder.BIG_ENDIAN).putInt(0).putLong(sequence).array()

    internal fun encode(bytes: ByteArray): String =
        Base64Url.encode(bytes)

    internal fun decodeExact(value: String, expectedBytes: Int): ByteArray? {
        val decoded = decodeCanonical(value) ?: return null
        if (decoded.size != expectedBytes) {
            Arrays.fill(decoded, 0)
            return null
        }
        return decoded
    }

    private fun decodeCanonical(value: String): ByteArray? {
        if (value.isEmpty() || value.length % 4 == 1) return null
        return Base64Url.decodeExact(value, value.length * 6 / 8)
    }
}
