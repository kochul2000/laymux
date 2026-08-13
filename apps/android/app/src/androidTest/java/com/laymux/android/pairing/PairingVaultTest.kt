package com.laymux.android.pairing

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.Base64
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
    private val preferenceName = "pairing-vault-test-$suffix"
    private val vault = PairingVault(
        context = ApplicationProvider.getApplicationContext(),
        preferenceName = preferenceName,
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
            vault.loadMetadata().single(),
        )
        val pending = requireNotNull(vault.prepareDecryption("desktop-7"))
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

        assertTrue(vault.loadMetadata().isEmpty())
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
        assertTrue(vault.loadMetadata().isEmpty())
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

        vault.markConfirmed("desktop", pairingId, clientNonce, 1_786_500_000)

        assertEquals(1_786_500_000, vault.loadMetadata().single().confirmedAtEpochSeconds)
        val pending = requireNotNull(vault.prepareDecryption("desktop"))
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
            vault.markConfirmed("desktop", pairingId, staleNonce, 1_786_500_000)
        }
        assertFalse(vault.clearIfMatches("desktop", pairingId, staleNonce))
        assertNull(vault.loadMetadata().single().confirmedAtEpochSeconds)
        assertEquals(clientNonce, vault.loadMetadata().single().clientNonce)
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
        assertEquals(pairingId, vault.loadMetadata().single().pairingId)
        nowEpochSeconds = expiresAt
        assertTrue(vault.loadMetadata().isEmpty())
        assertNull(vault.prepareDecryption("desktop"))
    }

    @Test
    fun expiredPendingPairingDoesNotDeleteAnotherInstance() {
        vault.setProtectionPolicy(PairingProtectionPolicy.KEYSTORE_ONLY)
        savePairing("desktop-a", ByteArray(PairingPayload.SECRET_BYTES) { 1 })
        savePairing("desktop-b", ByteArray(PairingPayload.SECRET_BYTES) { 2 })
        vault.markConfirmed("desktop-b", pairingId, clientNonce, nowEpochSeconds)

        nowEpochSeconds = expiresAt

        assertEquals(listOf("desktop-b"), vault.loadMetadata().map { it.instanceId })
    }

    @Test
    fun storesMultiplePairingsByInstance() {
        vault.setProtectionPolicy(PairingProtectionPolicy.KEYSTORE_ONLY)
        val secondSecret = ByteArray(PairingPayload.SECRET_BYTES) { (it + 40).toByte() }
        savePairing("desktop-a", ByteArray(PairingPayload.SECRET_BYTES) { (it + 20).toByte() })
        savePairing("desktop-b", secondSecret)

        assertEquals(listOf("desktop-a", "desktop-b"), vault.loadMetadata().map { it.instanceId })
    }

    @Test
    fun selectingOnePairingReturnsOnlyThatSecret() {
        vault.setProtectionPolicy(PairingProtectionPolicy.KEYSTORE_ONLY)
        val firstSecret = ByteArray(PairingPayload.SECRET_BYTES) { (it + 20).toByte() }
        val secondSecret = ByteArray(PairingPayload.SECRET_BYTES) { (it + 40).toByte() }
        savePairing("desktop-a", firstSecret)
        savePairing("desktop-b", secondSecret)

        val pending = requireNotNull(vault.prepareDecryption("desktop-b"))
        vault.completeDecryption(pending, pending.cipher).use { restored ->
            assertEquals("desktop-b", restored.metadata.instanceId)
            assertArrayEquals(secondSecret, restored.secretCopy())
        }
    }

    @Test
    fun clearInstancePreservesOtherPairingsAndSharedWrappingKey() {
        vault.setProtectionPolicy(PairingProtectionPolicy.KEYSTORE_ONLY)
        val preservedSecret = ByteArray(PairingPayload.SECRET_BYTES) { (it + 50).toByte() }
        savePairing("desktop-a", ByteArray(PairingPayload.SECRET_BYTES) { 1 })
        savePairing("desktop-b", preservedSecret)

        vault.clear("desktop-a")

        assertEquals(listOf("desktop-b"), vault.loadMetadata().map { it.instanceId })
        val pending = requireNotNull(vault.prepareDecryption("desktop-b"))
        vault.completeDecryption(pending, pending.cipher).use { restored ->
            assertArrayEquals(preservedSecret, restored.secretCopy())
        }
    }

    @Test
    fun changingProtectionPolicyClearsAllPairings() {
        vault.setProtectionPolicy(PairingProtectionPolicy.KEYSTORE_ONLY)
        savePairing("desktop-a", ByteArray(PairingPayload.SECRET_BYTES) { 1 })
        savePairing("desktop-b", ByteArray(PairingPayload.SECRET_BYTES) { 2 })

        vault.setProtectionPolicy(PairingProtectionPolicy.BIOMETRIC)

        assertTrue(vault.loadMetadata().isEmpty())
    }

    @Test
    fun confirmationUpdatesOnlyTheTargetInstance() {
        vault.setProtectionPolicy(PairingProtectionPolicy.KEYSTORE_ONLY)
        savePairing("desktop-a", ByteArray(PairingPayload.SECRET_BYTES) { 1 })
        savePairing("desktop-b", ByteArray(PairingPayload.SECRET_BYTES) { 2 })

        vault.markConfirmed("desktop-a", pairingId, clientNonce, 1_786_500_000)

        val metadata = vault.loadMetadata().associateBy { it.instanceId }
        assertEquals(1_786_500_000, metadata.getValue("desktop-a").confirmedAtEpochSeconds)
        assertNull(metadata.getValue("desktop-b").confirmedAtEpochSeconds)
        assertEquals("desktop-a", vault.loadConfirmedMetadata("desktop-a")?.instanceId)
        assertNull(vault.loadConfirmedMetadata("desktop-b"))
    }

    @Test
    fun discardsLegacySingletonRecordWithoutMigration() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.getSharedPreferences(preferenceName, android.content.Context.MODE_PRIVATE)
            .edit()
            .putString("pairing", "legacy-v3-envelope")
            .commit()

        val reopened = PairingVault(
            context = context,
            preferenceName = preferenceName,
            keyAlias = "com.laymux.android.test.$suffix",
            nowEpochSeconds = { nowEpochSeconds },
        )

        assertTrue(reopened.loadMetadata().isEmpty())
        assertFalse(
            context.getSharedPreferences(preferenceName, android.content.Context.MODE_PRIVATE)
                .contains("pairing"),
        )
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

    private fun savePairing(instance: String, secret: ByteArray) {
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(secret)
        PairingPayload.parse(pairingUri(instance, encoded)).use {
            val cipher = vault.prepareEncryption(PairingProtectionPolicy.KEYSTORE_ONLY)
            vault.save(it, clientNonce, PairingProtectionPolicy.KEYSTORE_ONLY, cipher)
        }
    }
}
