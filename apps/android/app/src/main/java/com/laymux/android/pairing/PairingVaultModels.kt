package com.laymux.android.pairing

import java.io.Closeable
import java.util.Arrays
import javax.crypto.Cipher

data class PairingMetadata(
    val endpoint: String,
    val instanceId: String,
    val pairingId: String,
    val expiresAtEpochSeconds: Long,
    val clientNonce: String,
    val confirmedAtEpochSeconds: Long?,
    val label: String?,
)

class StoredPairing internal constructor(
    val metadata: PairingMetadata,
    private val secret: ByteArray,
) : Closeable {
    internal fun secretCopy(): ByteArray = secret.copyOf()

    override fun close() {
        Arrays.fill(secret, 0)
    }

    override fun toString(): String = "StoredPairing(metadata=$metadata, secret=<redacted>)"
}

class PendingPairingDecryption internal constructor(
    val policy: PairingProtectionPolicy,
    val metadata: PairingMetadata,
    val cipher: Cipher,
    internal val ciphertext: ByteArray,
) : Closeable {
    override fun close() {
        Arrays.fill(ciphertext, 0)
    }

    override fun toString(): String =
        "PendingPairingDecryption(policy=$policy, metadata=$metadata, ciphertext=<redacted>)"
}

class PairingKeyInvalidatedException(
    cause: Throwable,
    val recoverySucceeded: Boolean,
) : IllegalStateException("생체 정보가 변경되어 페어링 키가 무효화됐습니다", cause)
