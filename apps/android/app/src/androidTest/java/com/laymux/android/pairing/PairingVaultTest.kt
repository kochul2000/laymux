package com.laymux.android.pairing

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.Base64
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PairingVaultTest {
    private val suffix = System.nanoTime().toString()
    private val vault = PairingVault(
        context = ApplicationProvider.getApplicationContext(),
        preferenceName = "pairing-vault-test-$suffix",
        keyAlias = "com.laymux.android.test.$suffix",
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
            "laymux://pair/v1?endpoint=https%3A%2F%2Fapp.laymux.com" +
                "&instance=desktop-7&secret=$encoded&label=work",
        )

        payload.use {
            val cipher = vault.prepareEncryption(PairingProtectionPolicy.KEYSTORE_ONLY)
            vault.save(it, PairingProtectionPolicy.KEYSTORE_ONLY, cipher)
        }

        assertEquals(
            PairingMetadata("https://app.laymux.com/", "desktop-7", "work"),
            vault.loadMetadata(),
        )
        val pending = requireNotNull(vault.prepareDecryption())
        assertEquals(PairingProtectionPolicy.KEYSTORE_ONLY, pending.policy)
        vault.completeDecryption(pending, pending.cipher).use { restored ->
            requireNotNull(restored)
            assertEquals("https://app.laymux.com/", restored.metadata.endpoint)
            assertEquals("desktop-7", restored.metadata.instanceId)
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
            "laymux://pair/v1?endpoint=https%3A%2F%2Fapp.laymux.com" +
                "&instance=desktop&secret=$secret",
        ).use {
            val cipher = vault.prepareEncryption(PairingProtectionPolicy.KEYSTORE_ONLY)
            vault.save(it, PairingProtectionPolicy.KEYSTORE_ONLY, cipher)
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
            "laymux://pair/v1?endpoint=https%3A%2F%2Fapp.laymux.com" +
                "&instance=desktop&secret=$secret",
        ).use {
            val cipher = vault.prepareEncryption(PairingProtectionPolicy.KEYSTORE_ONLY)
            vault.save(it, PairingProtectionPolicy.KEYSTORE_ONLY, cipher)
        }

        vault.setProtectionPolicy(PairingProtectionPolicy.BIOMETRIC)

        assertEquals(PairingProtectionPolicy.BIOMETRIC, vault.protectionPolicy())
        assertNull(vault.loadMetadata())
    }
}
