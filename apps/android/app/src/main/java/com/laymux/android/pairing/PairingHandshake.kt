package com.laymux.android.pairing

import java.io.Closeable
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Arrays
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

data class PairingAckRequest(
    val version: Int,
    val instanceId: String,
    val pairingId: String,
    val clientNonce: String,
    val clientProof: String,
) {
    fun toJson(): String = JSONObject()
        .put("version", version)
        .put("instanceId", instanceId)
        .put("pairingId", pairingId)
        .put("clientNonce", clientNonce)
        .put("clientProof", clientProof)
        .toString()

    override fun toString(): String =
        "PairingAckRequest(version=$version, instanceId=$instanceId, " +
            "pairingId=$pairingId, clientNonce=$clientNonce, clientProof=<redacted>)"
}

data class PairingConfirmation(
    val confirmedAtEpochSeconds: Long,
)

class PairingAckSession internal constructor(
    val endpoint: java.net.URI,
    val expiresAtEpochSeconds: Long,
    val request: PairingAckRequest,
    private val secret: ByteArray,
) : Closeable {
    fun isExpired(nowEpochSeconds: Long = System.currentTimeMillis() / 1_000): Boolean =
        nowEpochSeconds >= expiresAtEpochSeconds

    @Synchronized
    fun verifyResponse(raw: String): PairingConfirmation {
        val json = try {
            JSONObject(raw)
        } catch (_: Exception) {
            throw PairingAckException("데스크톱 확인 응답이 올바르지 않습니다.")
        }
        val keys = buildSet {
            val iterator = json.keys()
            while (iterator.hasNext()) add(iterator.next())
        }
        if (keys != RESPONSE_FIELDS) {
            throw PairingAckException("데스크톱 확인 응답이 올바르지 않습니다.")
        }
        val confirmedAt = try {
            if (json.getInt("version") != ACK_VERSION ||
                json.getString("instanceId") != request.instanceId ||
                json.getString("pairingId") != request.pairingId ||
                json.getString("clientNonce") != request.clientNonce
            ) {
                throw PairingAckException("데스크톱 확인 응답이 요청과 일치하지 않습니다.")
            }
            json.getLong("confirmedAt").takeIf { it > 0 }
                ?: throw PairingAckException("데스크톱 확인 시각이 올바르지 않습니다.")
        } catch (error: PairingAckException) {
            throw error
        } catch (_: Exception) {
            throw PairingAckException("데스크톱 확인 응답이 올바르지 않습니다.")
        }
        val serverProof = try {
            json.getString("serverProof")
        } catch (_: Exception) {
            throw PairingAckException("데스크톱 확인 응답이 올바르지 않습니다.")
        }
        if (!PairingHandshake.verifyServerProof(
                secret = secret,
                pairingId = request.pairingId,
                instanceId = request.instanceId,
                clientNonce = request.clientNonce,
                confirmedAtEpochSeconds = confirmedAt,
                encodedProof = serverProof,
            )
        ) {
            throw PairingAckException("데스크톱 확인 서명이 올바르지 않습니다.")
        }
        return PairingConfirmation(confirmedAt)
    }

    @Synchronized
    override fun close() {
        Arrays.fill(secret, 0)
    }

    override fun toString(): String =
        "PairingAckSession(endpoint=$endpoint, request=$request, secret=<redacted>)"

    companion object {
        private const val ACK_VERSION = 1
        private val RESPONSE_FIELDS = setOf(
            "version",
            "instanceId",
            "pairingId",
            "clientNonce",
            "confirmedAt",
            "serverProof",
        )
    }
}

object PairingHandshake {
    const val CLIENT_NONCE_BYTES = 16

    private const val ACK_VERSION = 1
    private const val PROOF_BYTES = 32
    private const val REQUEST_DOMAIN = "laymux.android-pair.request.v1"
    private const val RESPONSE_DOMAIN = "laymux.android-pair.response.v1"

    fun newClientNonce(random: SecureRandom = SecureRandom()): String {
        val nonce = ByteArray(CLIENT_NONCE_BYTES)
        return try {
            random.nextBytes(nonce)
            Base64Url.encode(nonce)
        } finally {
            Arrays.fill(nonce, 0)
        }
    }

    fun createSession(payload: PairingPayload, clientNonce: String): PairingAckSession {
        requireValidClientNonce(clientNonce)
        val secret = payload.secretCopy()
        return try {
            PairingAckSession(
                endpoint = payload.endpoint,
                expiresAtEpochSeconds = payload.expiresAtEpochSeconds,
                request = PairingAckRequest(
                    version = ACK_VERSION,
                    instanceId = payload.instanceId,
                    pairingId = payload.pairingId,
                    clientNonce = clientNonce,
                    clientProof = clientProof(
                        secret,
                        payload.pairingId,
                        payload.instanceId,
                        clientNonce,
                    ),
                ),
                secret = secret,
            )
        } catch (error: Exception) {
            Arrays.fill(secret, 0)
            throw error
        }
    }

    fun createSession(pairing: StoredPairing): PairingAckSession {
        val secret = pairing.secretCopy()
        return try {
            val metadata = pairing.metadata
            PairingAckSession(
                endpoint = java.net.URI(metadata.endpoint),
                expiresAtEpochSeconds = metadata.expiresAtEpochSeconds,
                request = PairingAckRequest(
                    version = ACK_VERSION,
                    instanceId = metadata.instanceId,
                    pairingId = metadata.pairingId,
                    clientNonce = metadata.clientNonce,
                    clientProof = clientProof(
                        secret,
                        metadata.pairingId,
                        metadata.instanceId,
                        metadata.clientNonce,
                    ),
                ),
                secret = secret,
            )
        } catch (error: Exception) {
            Arrays.fill(secret, 0)
            throw error
        }
    }

    internal fun clientProof(
        secret: ByteArray,
        pairingId: String,
        instanceId: String,
        clientNonce: String,
    ): String = Base64Url.encode(
        hmac(secret, REQUEST_DOMAIN, pairingId, instanceId, clientNonce),
    )

    internal fun verifyServerProof(
        secret: ByteArray,
        pairingId: String,
        instanceId: String,
        clientNonce: String,
        confirmedAtEpochSeconds: Long,
        encodedProof: String,
    ): Boolean {
        val provided = Base64Url.decodeExact(encodedProof, PROOF_BYTES) ?: return false
        val expected = hmac(
            secret,
            RESPONSE_DOMAIN,
            pairingId,
            instanceId,
            clientNonce,
            confirmedAtEpochSeconds.toString(),
        )
        return try {
            MessageDigest.isEqual(expected, provided)
        } finally {
            Arrays.fill(expected, 0)
            Arrays.fill(provided, 0)
        }
    }

    private fun hmac(secret: ByteArray, domain: String, vararg fields: String): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret, "HmacSHA256"))
        mac.update(domain.toByteArray(StandardCharsets.UTF_8))
        fields.forEach { field ->
            val bytes = field.toByteArray(StandardCharsets.UTF_8)
            val length = bytes.size
            mac.update(
                byteArrayOf(
                    (length ushr 24).toByte(),
                    (length ushr 16).toByte(),
                    (length ushr 8).toByte(),
                    length.toByte(),
                ),
            )
            mac.update(bytes)
        }
        return mac.doFinal()
    }

    private fun requireValidClientNonce(value: String) {
        val decoded = Base64Url.decodeExact(value, CLIENT_NONCE_BYTES)
        try {
            require(decoded != null) { "client nonce가 올바르지 않습니다" }
        } finally {
            decoded?.let { Arrays.fill(it, 0) }
        }
    }
}

internal object Base64Url {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    fun encode(bytes: ByteArray): String {
        val output = StringBuilder((bytes.size * 8 + 5) / 6)
        var accumulator = 0
        var bits = 0
        bytes.forEach { byte ->
            accumulator = (accumulator shl 8) or (byte.toInt() and 0xff)
            bits += 8
            while (bits >= 6) {
                bits -= 6
                output.append(ALPHABET[(accumulator ushr bits) and 0x3f])
                accumulator = if (bits == 0) 0 else accumulator and ((1 shl bits) - 1)
            }
        }
        if (bits > 0) output.append(ALPHABET[(accumulator shl (6 - bits)) and 0x3f])
        return output.toString()
    }

    fun decodeExact(encoded: String, expectedBytes: Int): ByteArray? {
        val decoded = ByteArray(expectedBytes)
        var accumulator = 0
        var bits = 0
        var output = 0
        for (character in encoded) {
            val value = ALPHABET.indexOf(character)
            if (value < 0) {
                Arrays.fill(decoded, 0)
                return null
            }
            accumulator = (accumulator shl 6) or value
            bits += 6
            if (bits >= 8) {
                bits -= 8
                if (output >= decoded.size) {
                    Arrays.fill(decoded, 0)
                    return null
                }
                decoded[output++] = (accumulator ushr bits).toByte()
                accumulator = if (bits == 0) 0 else accumulator and ((1 shl bits) - 1)
            }
        }
        if (output != expectedBytes || accumulator != 0 || encode(decoded) != encoded) {
            Arrays.fill(decoded, 0)
            return null
        }
        return decoded
    }
}
