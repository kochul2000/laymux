package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudNavigationPolicyTest {
    @Test
    fun allowsOnlyTheConfiguredHttpsOrigin() {
        val policy = CloudNavigationPolicy("https://app.laymux.com")

        assertEquals("https://app.laymux.com/app/android", policy.startUrl)
        assertTrue(policy.isAllowed("https://app.laymux.com/dashboard?client=android"))
        assertFalse(policy.isAllowed("https://remote.laymux.com/remote/"))
        assertFalse(policy.isAllowed("https://app.laymux.com.evil.test/dashboard"))
        assertFalse(policy.isAllowed("https://user@app.laymux.com/dashboard"))
        assertFalse(policy.isAllowed("http://app.laymux.com/dashboard"))
    }

    @Test
    fun configuredPortIsPartOfTheOrigin() {
        val policy = CloudNavigationPolicy("https://cloud.example.test:8443")

        assertTrue(policy.isAllowed("https://cloud.example.test:8443/app/android"))
        assertFalse(policy.isAllowed("https://cloud.example.test/app/android"))
    }

    @Test
    fun rejectsNonOriginConfiguration() {
        assertThrows(IllegalArgumentException::class.java) {
            CloudNavigationPolicy("http://app.laymux.com")
        }
        assertThrows(IllegalArgumentException::class.java) {
            CloudNavigationPolicy("https://app.laymux.com/path")
        }
        assertThrows(IllegalArgumentException::class.java) {
            CloudNavigationPolicy("https://user@app.laymux.com")
        }
    }
}
