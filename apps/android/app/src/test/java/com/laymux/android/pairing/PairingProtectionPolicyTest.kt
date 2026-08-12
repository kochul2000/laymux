package com.laymux.android.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PairingProtectionPolicyTest {
    @Test
    fun defaultsToBiometricWhenNoPreferenceExists() {
        assertEquals(
            PairingProtectionPolicy.BIOMETRIC,
            PairingProtectionPolicy.fromStorage(null),
        )
    }

    @Test
    fun roundTripsExplicitOptOut() {
        val policy = PairingProtectionPolicy.KEYSTORE_ONLY

        assertEquals(policy, PairingProtectionPolicy.fromStorage(policy.storageValue))
    }

    @Test
    fun failsClosedForUnknownStoredPolicy() {
        assertThrows(IllegalArgumentException::class.java) {
            PairingProtectionPolicy.fromStorage("unknown")
        }
    }
}
