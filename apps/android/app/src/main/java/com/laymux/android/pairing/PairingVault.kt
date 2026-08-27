package com.laymux.android.pairing

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.Closeable
import java.net.URI
import java.security.KeyStore
import java.util.Arrays
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

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

class PairingKeyInvalidatedException(cause: Throwable) :
    IllegalStateException("생체 정보가 변경되어 페어링 키가 무효화됐습니다", cause)

/**
 * Stores one pairing envelope per desktop instance. Biometric protection is
 * the fail-closed default; all envelopes using a policy share its wrapping key.
 */
class PairingVault(
    context: Context,
    private val preferenceName: String = PREFERENCE_NAME,
    private val keyAlias: String = KEY_ALIAS,
    private val nowEpochSeconds: () -> Long = { System.currentTimeMillis() / 1_000 },
) {
    private val preferences = context.applicationContext.getSharedPreferences(
        preferenceName,
        Context.MODE_PRIVATE,
    )

    init {
        // Storage v4 deliberately has no migration from the former singleton record.
        if (preferences.contains(LEGACY_PAIRING_KEY) &&
            !preferences.edit().remove(LEGACY_PAIRING_KEY).commit()
        ) {
            throw IllegalStateException("이전 페어링 정보를 폐기하지 못했습니다")
        }
    }

    @Synchronized
    fun protectionPolicy(): PairingProtectionPolicy = try {
        PairingProtectionPolicy.fromStorage(preferences.getString(PROTECTION_POLICY_KEY, null))
    } catch (error: IllegalArgumentException) {
        throw IllegalStateException(error.message, error)
    }

    /** Changing key authorization cannot mutate an existing Keystore key. Re-pair instead. */
    @Synchronized
    fun setProtectionPolicy(policy: PairingProtectionPolicy) {
        if (protectionPolicy() == policy) return
        clear()
        if (!preferences.edit().putString(PROTECTION_POLICY_KEY, policy.storageValue).commit()) {
            throw IllegalStateException("키 보호 설정을 저장하지 못했습니다")
        }
    }

    @Synchronized
    fun prepareEncryption(policy: PairingProtectionPolicy): Cipher {
        if (protectionPolicy() != policy) {
            throw IllegalStateException("키 보호 설정이 변경됐습니다")
        }
        return Cipher.getInstance(CIPHER_TRANSFORMATION).apply {
            try {
                init(Cipher.ENCRYPT_MODE, getOrCreateWrappingKey(policy))
            } catch (error: KeyPermanentlyInvalidatedException) {
                throw PairingKeyInvalidatedException(error)
            }
        }
    }

    /** The caller must authorize [cipher] with BiometricPrompt when policy is BIOMETRIC. */
    @Synchronized
    fun save(
        payload: PairingPayload,
        clientNonce: String,
        policy: PairingProtectionPolicy,
        cipher: Cipher,
    ) {
        if (protectionPolicy() != policy) {
            throw IllegalStateException("키 보호 설정이 변경됐습니다")
        }
        val secret = payload.secretCopy()
        try {
            val encrypted = cipher.doFinal(secret)
            val envelope = JSONObject()
                .put("version", STORAGE_VERSION)
                .put("protection", policy.storageValue)
                .put("endpoint", payload.endpoint.toString())
                .put("instanceId", payload.instanceId)
                .put("pairingId", payload.pairingId)
                .put("expiresAt", payload.expiresAtEpochSeconds)
                .put("clientNonce", clientNonce)
                .put("confirmedAt", JSONObject.NULL)
                .put("label", payload.label ?: JSONObject.NULL)
                .put("iv", encodeBase64(cipher.iv))
                .put("ciphertext", encodeBase64(encrypted))
                .toString()
            if (!preferences.edit().putString(pairingKey(payload.instanceId), envelope).commit()) {
                throw IllegalStateException("페어링 정보를 저장하지 못했습니다")
            }
        } finally {
            Arrays.fill(secret, 0)
        }
    }

    /** Reads non-secret display metadata without initializing or using the wrapping key. */
    @Synchronized
    fun loadMetadata(): List<PairingMetadata> = pairingInstanceIds()
        .mapNotNull { instanceId -> activeEnvelope(instanceId)?.metadata }

    /** Cloud selection can only resolve an already confirmed record for that instance. */
    @Synchronized
    fun loadConfirmedMetadata(instanceId: String): PairingMetadata? =
        activeEnvelope(instanceId)?.metadata?.takeIf { it.confirmedAtEpochSeconds != null }

    @Synchronized
    fun markConfirmed(
        instanceId: String,
        pairingId: String,
        clientNonce: String,
        confirmedAtEpochSeconds: Long,
    ) {
        if (confirmedAtEpochSeconds <= 0) {
            throw IllegalArgumentException("페어링 확인 시각이 올바르지 않습니다")
        }
        val key = pairingKey(instanceId)
        val encodedEnvelope = preferences.getString(key, null)
            ?: throw IllegalStateException("저장된 페어링이 없습니다")
        val json = try {
            JSONObject(encodedEnvelope)
        } catch (_: Exception) {
            throw corrupted()
        }
        val envelope = storedEnvelope(instanceId)
            ?: throw IllegalStateException("저장된 페어링이 없습니다")
        if (envelope.metadata.pairingId != pairingId ||
            envelope.metadata.clientNonce != clientNonce
        ) {
            throw IllegalStateException("페어링 확인 대상이 변경됐습니다")
        }
        json.put("confirmedAt", confirmedAtEpochSeconds)
        if (!preferences.edit().putString(key, json.toString()).commit()) {
            throw IllegalStateException("페어링 확인 상태를 저장하지 못했습니다")
        }
    }

    @Synchronized
    fun prepareDecryption(instanceId: String): PendingPairingDecryption? {
        val envelope = activeEnvelope(instanceId) ?: return null
        if (envelope.policy != protectionPolicy()) {
            throw IllegalStateException("저장된 페어링과 키 보호 설정이 일치하지 않습니다")
        }
        val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
        try {
            cipher.init(
                Cipher.DECRYPT_MODE,
                getWrappingKey(envelope.policy),
                GCMParameterSpec(GCM_TAG_BITS, envelope.iv),
            )
        } catch (error: KeyPermanentlyInvalidatedException) {
            throw PairingKeyInvalidatedException(error)
        }
        return PendingPairingDecryption(
            policy = envelope.policy,
            metadata = envelope.metadata,
            cipher = cipher,
            ciphertext = envelope.ciphertext,
        )
    }

    /** Completes an operation after BiometricPrompt returns its authorized cipher. */
    fun completeDecryption(
        pending: PendingPairingDecryption,
        authorizedCipher: Cipher,
    ): StoredPairing {
        if (authorizedCipher !== pending.cipher) {
            pending.close()
            throw IllegalArgumentException("인증된 암호 연산이 일치하지 않습니다")
        }
        return try {
            val secret = authorizedCipher.doFinal(pending.ciphertext)
            if (secret.size != PairingPayload.SECRET_BYTES) {
                Arrays.fill(secret, 0)
                throw IllegalStateException("저장된 페어링 키 길이가 올바르지 않습니다")
            }
            StoredPairing(pending.metadata, secret)
        } finally {
            pending.close()
        }
    }

    @Synchronized
    fun clear() {
        val editor = preferences.edit().remove(LEGACY_PAIRING_KEY)
        pairingKeys().forEach(editor::remove)
        if (!editor.commit()) {
            throw IllegalStateException("페어링 정보를 삭제하지 못했습니다")
        }
        val keyStore = androidKeyStore()
        PairingProtectionPolicy.entries.forEach { policy ->
            val alias = aliasFor(policy)
            if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
        }
    }

    /** Deletes one desktop record without deleting the policy's shared wrapping key. */
    @Synchronized
    fun clear(instanceId: String) {
        if (!preferences.edit().remove(pairingKey(instanceId)).commit()) {
            throw IllegalStateException("페어링 정보를 삭제하지 못했습니다")
        }
    }

    /** A stale network result must not delete a newer accepted pairing value. */
    @Synchronized
    fun clearIfMatches(instanceId: String, pairingId: String, clientNonce: String): Boolean {
        val metadata = storedEnvelope(instanceId)?.metadata ?: return false
        if (metadata.pairingId != pairingId || metadata.clientNonce != clientNonce) return false
        clear(instanceId)
        return true
    }

    private fun storedEnvelope(instanceId: String): StoredEnvelope? {
        val encodedEnvelope = preferences.getString(pairingKey(instanceId), null) ?: return null
        val json = try {
            JSONObject(encodedEnvelope)
        } catch (_: Exception) {
            throw corrupted()
        }
        if (json.optInt("version", -1) != STORAGE_VERSION) throw corrupted()
        val policy = try {
            if (!json.has("protection") || json.isNull("protection")) throw corrupted()
            PairingProtectionPolicy.fromStorage(json.getString("protection"))
        } catch (_: Exception) {
            throw corrupted()
        }
        val metadata = validateMetadata(
            endpoint = json.optString("endpoint"),
            instanceId = json.optString("instanceId"),
            pairingId = json.optString("pairingId"),
            expiresAtEpochSeconds = json.optLong("expiresAt", -1),
            clientNonce = json.optString("clientNonce"),
            confirmedAtEpochSeconds = if (json.isNull("confirmedAt")) {
                null
            } else {
                json.optLong("confirmedAt", -1)
            },
            label = if (json.isNull("label")) null else json.optString("label"),
        )
        if (metadata.instanceId != instanceId) throw corrupted()
        val iv = decodeBase64(json.optString("iv"))
        val ciphertext = decodeBase64(json.optString("ciphertext"))
        if (iv.size != GCM_IV_BYTES || ciphertext.size <= GCM_TAG_BYTES) throw corrupted()
        return StoredEnvelope(policy, metadata, iv, ciphertext)
    }

    private fun activeEnvelope(instanceId: String): StoredEnvelope? {
        val envelope = storedEnvelope(instanceId) ?: return null
        if (envelope.metadata.confirmedAtEpochSeconds == null &&
            nowEpochSeconds() >= envelope.metadata.expiresAtEpochSeconds
        ) {
            clear(instanceId)
            return null
        }
        return envelope
    }

    private fun pairingKeys(): List<String> = preferences.all.keys
        .filter { it.startsWith(PAIRING_KEY_PREFIX) }

    private fun pairingInstanceIds(): List<String> = pairingKeys()
        .asSequence()
        .map { key ->
            key.removePrefix(PAIRING_KEY_PREFIX).also { instanceId ->
                if (!INSTANCE_PATTERN.matches(instanceId)) throw corrupted()
            }
        }
        .sorted()
        .toList()

    private fun pairingKey(instanceId: String): String {
        if (!INSTANCE_PATTERN.matches(instanceId)) {
            throw IllegalArgumentException("PC 식별자가 올바르지 않습니다")
        }
        return "$PAIRING_KEY_PREFIX$instanceId"
    }

    private fun validateMetadata(
        endpoint: String,
        instanceId: String,
        pairingId: String,
        expiresAtEpochSeconds: Long,
        clientNonce: String,
        confirmedAtEpochSeconds: Long?,
        label: String?,
    ): PairingMetadata {
        val uri = try {
            URI(endpoint)
        } catch (_: Exception) {
            throw corrupted()
        }
        val host = uri.host?.removePrefix("[")?.removeSuffix("]")?.lowercase()
        val allowedScheme = uri.scheme == "https" ||
            (uri.scheme == "http" && (host == "127.0.0.1" || host == "::1"))
        val pairingIdBytes = Base64Url.decodeExact(pairingId, PairingPayload.PAIRING_ID_BYTES)
        val clientNonceBytes = Base64Url.decodeExact(
            clientNonce,
            PairingHandshake.CLIENT_NONCE_BYTES,
        )
        val validIdentifiers = pairingIdBytes != null && clientNonceBytes != null
        pairingIdBytes?.let { Arrays.fill(it, 0) }
        clientNonceBytes?.let { Arrays.fill(it, 0) }
        if (!allowedScheme ||
            host.isNullOrEmpty() ||
            uri.rawUserInfo != null ||
            uri.rawQuery != null ||
            uri.rawFragment != null ||
            uri.rawPath != "/" ||
            endpoint.length > MAX_ENDPOINT_LENGTH ||
            !INSTANCE_PATTERN.matches(instanceId) ||
            !PAIRING_ID_PATTERN.matches(pairingId) ||
            !CLIENT_NONCE_PATTERN.matches(clientNonce) ||
            !validIdentifiers ||
            expiresAtEpochSeconds <= 0 ||
            (confirmedAtEpochSeconds != null && confirmedAtEpochSeconds <= 0) ||
            (label != null &&
                (label.isBlank() || label.length > MAX_LABEL_LENGTH || label.any(Char::isISOControl)))
        ) {
            throw corrupted()
        }
        return PairingMetadata(
            endpoint,
            instanceId,
            pairingId,
            expiresAtEpochSeconds,
            clientNonce,
            confirmedAtEpochSeconds,
            label,
        )
    }

    private fun getOrCreateWrappingKey(policy: PairingProtectionPolicy): SecretKey {
        val alias = aliasFor(policy)
        val keyStore = androidKeyStore()
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
        if (policy == PairingProtectionPolicy.BIOMETRIC) {
            builder.setUserAuthenticationRequired(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            } else {
                @Suppress("DEPRECATION")
                builder.setUserAuthenticationValidityDurationSeconds(-1)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                builder.setInvalidatedByBiometricEnrollment(true)
            }
        }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(builder.build())
        return generator.generateKey()
    }

    private fun getWrappingKey(policy: PairingProtectionPolicy): SecretKey =
        androidKeyStore().getKey(aliasFor(policy), null) as? SecretKey
            ?: throw IllegalStateException("페어링 보호 키가 없습니다")

    private fun aliasFor(policy: PairingProtectionPolicy): String = when (policy) {
        PairingProtectionPolicy.BIOMETRIC -> "$keyAlias.biometric"
        PairingProtectionPolicy.KEYSTORE_ONLY -> "$keyAlias.keystore-only"
    }

    private fun androidKeyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply {
        load(null)
    }

    private fun encodeBase64(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun decodeBase64(value: String): ByteArray = try {
        Base64.decode(value, Base64.NO_WRAP)
    } catch (_: Exception) {
        throw corrupted()
    }

    private fun corrupted() = IllegalStateException("저장된 페어링 정보가 손상되었습니다")

    private data class StoredEnvelope(
        val policy: PairingProtectionPolicy,
        val metadata: PairingMetadata,
        val iv: ByteArray,
        val ciphertext: ByteArray,
    )

    companion object {
        private const val PREFERENCE_NAME = "laymux-pairing-v1"
        private const val LEGACY_PAIRING_KEY = "pairing"
        private const val PAIRING_KEY_PREFIX = "pairing:"
        private const val PROTECTION_POLICY_KEY = "protection-policy"
        private const val KEY_ALIAS = "com.laymux.android.pairing-wrap.v2"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val STORAGE_VERSION = 4
        private const val GCM_IV_BYTES = 12
        private const val GCM_TAG_BITS = 128
        private const val GCM_TAG_BYTES = GCM_TAG_BITS / Byte.SIZE_BITS
        private const val MAX_ENDPOINT_LENGTH = 2048
        private const val MAX_LABEL_LENGTH = 80
        private val INSTANCE_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
        private val PAIRING_ID_PATTERN = Regex("^[A-Za-z0-9_-]{22}$")
        private val CLIENT_NONCE_PATTERN = Regex("^[A-Za-z0-9_-]{22}$")
    }
}
