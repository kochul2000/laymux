package com.laymux.android.remote

import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Arrays
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

internal class E2eOutputCipher(
    private val instanceId: String,
    private val sessionId: String,
    private val streamNonce: String,
    private val requestKey: ByteArray,
    private val responseKey: ByteArray,
) : Closeable {
    private var nextRequestSequence = 0L
    private var nextResponseSequence = 0L
    private var closed = false

    @Synchronized
    fun encryptOpen(terminalId: String, leaseId: String, historyKib: Int = 0): ByteArray {
        check(!closed)
        val json = JSONObject()
            .put("terminalId", terminalId)
            .put("leaseId", leaseId)
            .apply { if (historyKib > 0) put("historyKib", historyKib) }
            .toString()
            .toByteArray(StandardCharsets.UTF_8)
        val plaintext = ByteArray(1 + json.size)
        plaintext[0] = E2eOutputProtocol.RECORD_OPEN
        json.copyInto(plaintext, 1)
        Arrays.fill(json, 0)
        return try {
            E2eOutputProtocol.encryptRecord(
                requestKey,
                E2eOutputProtocol.A2D_AAD_DOMAIN,
                instanceId,
                sessionId,
                streamNonce,
                nextRequestSequence++,
                plaintext,
            )
        } finally {
            Arrays.fill(plaintext, 0)
        }
    }

    @Synchronized
    fun decryptResponse(record: ByteArray): ByteArray {
        check(!closed)
        return E2eOutputProtocol.decryptRecord(
            responseKey,
            E2eOutputProtocol.D2A_AAD_DOMAIN,
            instanceId,
            sessionId,
            streamNonce,
            nextResponseSequence++,
            record,
        ).also { plaintext ->
            if (plaintext.isEmpty() ||
                (plaintext[0] != E2eOutputProtocol.RECORD_TEXT &&
                    plaintext[0] != E2eOutputProtocol.RECORD_BINARY)
            ) {
                Arrays.fill(plaintext, 0)
                throw E2eProtocolException("Secure output record type is invalid.", true)
            }
        }
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        Arrays.fill(requestKey, 0)
        Arrays.fill(responseKey, 0)
        nextRequestSequence = E2eProtocol.MAX_SEQUENCE + 1
        nextResponseSequence = E2eProtocol.MAX_SEQUENCE + 1
    }
}

internal object E2eOutputProtocol {
    const val STREAM_NONCE_BYTES = 32
    const val RECORD_OPEN: Byte = 1
    const val RECORD_TEXT: Byte = 2
    const val RECORD_BINARY: Byte = 3
    private const val RECORD_HEADER_BYTES = 9
    private const val SALT_DOMAIN = "laymux.android-e2e.output.hkdf.salt.v1"
    private const val A2D_INFO = "laymux.android-e2e.output.a2d.v1"
    private const val D2A_INFO = "laymux.android-e2e.output.d2a.v1"
    const val A2D_AAD_DOMAIN = "laymux.android-e2e.output.a2d.aad.v1"
    const val D2A_AAD_DOMAIN = "laymux.android-e2e.output.d2a.aad.v1"

    fun deriveKeys(
        requestKey: ByteArray,
        responseKey: ByteArray,
        instanceId: String,
        sessionId: String,
        streamNonce: String,
    ): Pair<ByteArray, ByteArray> {
        val nonceBytes = requireNotNull(
            E2eProtocol.decodeExact(streamNonce, STREAM_NONCE_BYTES),
        ) { "Secure output stream nonce is invalid." }
        Arrays.fill(nonceBytes, 0)
        val saltInput = framed(SALT_DOMAIN, arrayOf(instanceId, sessionId, streamNonce))
        val salt = MessageDigest.getInstance("SHA-256").digest(saltInput)
        Arrays.fill(saltInput, 0)
        return try {
            Pair(hkdf(requestKey, salt, A2D_INFO), hkdf(responseKey, salt, D2A_INFO))
        } finally {
            Arrays.fill(salt, 0)
        }
    }

    fun encryptRecord(
        key: ByteArray,
        aadDomain: String,
        instanceId: String,
        sessionId: String,
        streamNonce: String,
        sequence: Long,
        plaintext: ByteArray,
    ): ByteArray {
        require(sequence in 0..E2eProtocol.MAX_SEQUENCE)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(E2eProtocol.GCM_TAG_BITS, sequenceNonce(sequence)),
        )
        cipher.updateAAD(outputAad(aadDomain, instanceId, sessionId, streamNonce, sequence))
        val ciphertext = cipher.doFinal(plaintext)
        return ByteBuffer.allocate(RECORD_HEADER_BYTES + ciphertext.size)
            .order(ByteOrder.BIG_ENDIAN)
            .put(E2eProtocol.VERSION.toByte())
            .putLong(sequence)
            .put(ciphertext)
            .array()
            .also { Arrays.fill(ciphertext, 0) }
    }

    fun decryptRecord(
        key: ByteArray,
        aadDomain: String,
        instanceId: String,
        sessionId: String,
        streamNonce: String,
        expectedSequence: Long,
        record: ByteArray,
    ): ByteArray {
        if (expectedSequence !in 0..E2eProtocol.MAX_SEQUENCE ||
            record.size < RECORD_HEADER_BYTES + E2eProtocol.GCM_TAG_BYTES ||
            record[0].toInt() != E2eProtocol.VERSION
        ) {
            throw E2eProtocolException("Secure output record is invalid.", true)
        }
        val sequence = ByteBuffer.wrap(record, 1, Long.SIZE_BYTES)
            .order(ByteOrder.BIG_ENDIAN)
            .long
        if (sequence != expectedSequence) {
            throw E2eProtocolException("Secure output sequence is invalid.", true)
        }
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(E2eProtocol.GCM_TAG_BITS, sequenceNonce(sequence)),
            )
            cipher.updateAAD(outputAad(aadDomain, instanceId, sessionId, streamNonce, sequence))
            cipher.doFinal(record, RECORD_HEADER_BYTES, record.size - RECORD_HEADER_BYTES)
        } catch (error: E2eProtocolException) {
            throw error
        } catch (error: Exception) {
            throw E2eProtocolException("Secure output authentication failed.", true, error)
        }
    }

    private fun hkdf(key: ByteArray, salt: ByteArray, info: String): ByteArray {
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = extract.doFinal(key)
        return try {
            val expand = Mac.getInstance("HmacSHA256")
            expand.init(SecretKeySpec(prk, "HmacSHA256"))
            expand.update(info.toByteArray(StandardCharsets.UTF_8))
            expand.update(1.toByte())
            expand.doFinal()
        } finally {
            Arrays.fill(prk, 0)
        }
    }

    private fun outputAad(
        domain: String,
        instanceId: String,
        sessionId: String,
        streamNonce: String,
        sequence: Long,
    ): ByteArray {
        val domainBytes = domain.toByteArray(StandardCharsets.UTF_8)
        val fields = framed("", arrayOf(instanceId, sessionId, streamNonce))
        return ByteBuffer.allocate(domainBytes.size + 1 + fields.size + Long.SIZE_BYTES)
            .order(ByteOrder.BIG_ENDIAN)
            .put(domainBytes)
            .put(E2eProtocol.VERSION.toByte())
            .put(fields)
            .putLong(sequence)
            .array()
    }

    private fun framed(domain: String, fields: Array<String>): ByteArray {
        val domainBytes = domain.toByteArray(StandardCharsets.UTF_8)
        val fieldBytes = fields.map { it.toByteArray(StandardCharsets.UTF_8) }
        return ByteBuffer.allocate(
            domainBytes.size + fieldBytes.sumOf { Int.SIZE_BYTES + it.size },
        ).order(ByteOrder.BIG_ENDIAN).apply {
            put(domainBytes)
            fieldBytes.forEach { bytes ->
                putInt(bytes.size)
                put(bytes)
            }
        }.array()
    }

    private fun sequenceNonce(sequence: Long): ByteArray =
        ByteBuffer.allocate(12).order(ByteOrder.BIG_ENDIAN).putInt(0).putLong(sequence).array()
}
