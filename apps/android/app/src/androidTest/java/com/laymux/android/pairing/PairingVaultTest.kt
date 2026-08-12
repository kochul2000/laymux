package com.laymux.android.pairing

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.Base64
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PairingVaultTest {
    private val pairingId = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(ByteArray(PairingPayload.PAIRING_ID_BYTES) { (it + 16).toByte() })
    private val clientNonce = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(ByteArray(PairingHandshake.CLIENT_NONCE_BYTES) { (it + 32).toByte() })
    private val expiresAt = 4_102_444_800L
    private var nowEpochSeconds = 1_786_500_000L
    private val suffix = System.nanoTime().toString()
    private val vault = PairingVault(
        context = ApplicationProvider.getApplicationContext(),
        preferenceName = "pairing-vault-test-$suffix",
        keyAlias = "com.laymux.android.test.$suffix",
        nowEpochSeconds = { nowEpochSeconds },
    )

    @After
    fun tearDown() {
        vault.clear()
    }

    @Test
    fun defaultsToBiometricProtection() {
        assertEquals(PairingProtectionPolicy.BIOMETRIC, vault.protectionPolicy())
    }

    @Test
    fun wrapsOptedOutPairingSecretAndRestoresIt() {
        vault.setProtectionPolicy(PairingProtectionPolicy.KEYSTORE_ONLY)
        val secret = ByteArray(PairingPayload.SECRET_BYTES) { (it + 1).toByte() }
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(secret)
        val payload = PairingPayload.parse(
            pairingUri("desktop-7", encoded, "work"),
        )

        payload.use {
            val cipher = vault.prepareEncryption(PairingProtectionPolicy.KEYSTORE_ONLY)
            vault.save(it, clientNonce, PairingProtectionPolicy.KEYSTORE_ONLY, cipher)
        }

        assertEquals(
            PairingMetadata(
                "https://app.laymux.com/",
                "desktop-7",
                pairingId,
                expiresAt,
                clientNonce,
                null,
                "work",
            ),
            vault.loadMetadata(),
        )
        val pending = requireNotNull(vault.prepareDecryption())
        assertEquals(PairingProtectionPolicy.KEYSTORE_ONLY, pending.policy)
        vault.completeDecryption(pending, pending.cipher).use { restored ->
            requireNotNull(restored)
            assertEquals("https://app.laymux.com/", restored.metadata.endpoint)
            assertEquals("desktop-7", restored.metadata.instanceId)
            assertEquals(pairingId, restored.metadata.pairingId)
            assertEquals(clientNonce, restored.metadata.clientNonce)
            assertEquals("work", restored.metadata.label)
            assertArrayEquals(secret, restored.secretCopy())
            assertFalse(restored.toString().contains(encoded))
        }
    }

    @Test
    fun clearRemovesStoredPairing() {
        vault.setProtectionPolicy(PairingProtectionPolicy.KEYSTORE_ONLY)
        val secret = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(PairingPayload.SECRET_BYTES))
        PairingPayload.parse(
            pairingUri("desktop", secret),
        ).use {
            val cipher = vault.prepareEncryption(PairingProtectionPolicy.KEYSTORE_ONLY)
            vault.save(it, clientNonce, PairingProtectionPolicy.KEYSTORE_ONLY, cipher)
        }

        vault.clear()

        assertNull(vault.loadMetadata())
    }

    @Test
    fun changingProtectionPolicyClearsTheOldPairing() {
        vault.setProtectionPolicy(PairingProtectionPolicy.KEYSTORE_ONLY)
        val secret = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(PairingPayload.SECRET_BYTES))
        PairingPayload.parse(
            pairingUri("desktop", secret),
        ).use {
            val cipher = vault.prepareEncryption(PairingProtectionPolicy.KEYSTORE_ONLY)
            vault.save(it, clientNonce, PairingProtectionPolicy.KEYSTORE_ONLY, cipher)
        }

        vault.setProtectionPolicy(PairingProtectionPolicy.BIOMETRIC)

        assertEquals(PairingProtectionPolicy.BIOMETRIC, vault.protectionPolicy())
        assertNull(vault.loadMetadata())
    }

    @Test
    fun confirmationUpdatesOnlyMetadataWithoutRewrappingTheSecret() {
        vault.setProtectionPolicy(PairingProtectionPolicy.KEYSTORE_ONLY)
        val secret = ByteArray(PairingPayload.SECRET_BYTES) { (it + 4).toByte() }
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(secret)
        PairingPayload.parse(pairingUri("desktop", encoded)).use {
            val cipher = vault.prepareEncryption(PairingProtectionPolicy.KEYSTORE_ONLY)
            vault.save(it, clientNonce, PairingProtectionPolicy.KEYSTORE_ONLY, cipher)
        }

        vault.markConfirmed(pairingId, clientNonce, 1_786_500_000)

        assertEquals(1_786_500_000, vault.loadMetadata()?.confirmedAtEpochSeconds)
        val pending = requireNotNull(vault.prepareDecryption())
        vault.completeDecryption(pending, pending.cipher).use { restored ->
            assertArrayEquals(secret, restored.secretCopy())
        }
    }

    @Test
    fun staleAckCannotConfirmOrDeleteAReplacementPairing() {
        vault.setProtectionPolicy(PairingProtectionPolicy.KEYSTORE_ONLY)
        val secret = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(PairingPayload.SECRET_BYTES) { (it + 8).toByte() })
        PairingPayload.parse(pairingUri("desktop", secret)).use {
            val cipher = vault.prepareEncryption(PairingProtectionPolicy.KEYSTORE_ONLY)
            vault.save(it, clientNonce, PairingProtectionPolicy.KEYSTORE_ONLY, cipher)
        }
        val staleNonce = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(PairingHandshake.CLIENT_NONCE_BYTES) { 99 })

        assertThrows(IllegalStateException::class.java) {
            vault.markConfirmed(pairingId, staleNonce, 1_786_500_000)
        }
        assertFalse(vault.clearIfMatches(pairingId, staleNonce))
        assertNull(vault.loadMetadata()?.confirmedAtEpochSeconds)
        assertEquals(clientNonce, vault.loadMetadata()?.clientNonce)
    }

    @Test
    fun expiredPendingPairingIsDeletedAtTheExactBoundary() {
        vault.setProtectionPolicy(PairingProtectionPolicy.KEYSTORE_ONLY)
        val secret = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(ByteArray(PairingPayload.SECRET_BYTES) { (it + 10).toByte() })
        PairingPayload.parse(pairingUri("desktop", secret)).use {
            val cipher = vault.prepareEncryption(PairingProtectionPolicy.KEYSTORE_ONLY)
            vault.save(it, clientNonce, PairingProtectionPolicy.KEYSTORE_ONLY, cipher)
        }

        nowEpochSeconds = expiresAt - 1
        assertEquals(pairingId, vault.loadMetadata()?.pairingId)
        nowEpochSeconds = expiresAt
        assertNull(vault.loadMetadata())
        assertNull(vault.prepareDecryption())
    }

    @Test
    fun verifiesExactDesktopResponseAndRejectsTampering() {
        val secret = ByteArray(PairingPayload.SECRET_BYTES) { it.toByte() }
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(secret)
        PairingPayload.parse(pairingUri("desktop-7", encoded)).use { payload ->
            PairingHandshake.createSession(payload, clientNonce).use { session ->
                assertEquals(
                    "VCLjMKeN3kuPYo0PZv1B_5u-reuVTjOjVBW9AFmZbD0",
                    session.request.clientProof,
                )
                val response = """
                    {
                      "version": 1,
                      "instanceId": "desktop-7",
                      "pairingId": "$pairingId",
                      "clientNonce": "$clientNonce",
                      "confirmedAt": 1786500000,
                      "serverProof": "uPqJodeWKRiXPi08V_o8JQznMtxtHZF6ZQNEKB0oL_g"
                    }
                """.trimIndent()

                assertEquals(1_786_500_000, session.verifyResponse(response).confirmedAtEpochSeconds)
                assertThrows(PairingAckException::class.java) {
                    session.verifyResponse(response.replace("1786500000", "1786500001"))
                }
            }
        }
    }

    private fun pairingUri(instance: String, secret: String, label: String? = null): String {
        val labelQuery = label?.let { "&label=$it" }.orEmpty()
        return "laymux://pair/v2?endpoint=https%3A%2F%2Fapp.laymux.com" +
            "&instance=$instance&pairing=$pairingId&expires=$expiresAt" +
            "&secret=$secret$labelQuery"
    }
}
