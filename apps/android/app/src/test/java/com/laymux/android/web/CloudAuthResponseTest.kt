package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class CloudAuthResponseTest {
    @Test
    fun acceptsOnlyTheFixedDashboardRedirectWithBoundedCookies() {
        val cookies = CloudAuthResponse.requireSuccess(
            status = 303,
            location = "/dashboard?client=android",
            setCookies = listOf("laymux_session=signed; Path=/; HttpOnly; Secure; SameSite=Lax"),
        )

        assertEquals(1, cookies.size)
    }

    @Test
    fun rejectsExternalRedirectMissingCookieAndHeaderInjection() {
        assertThrows(CloudAuthException::class.java) {
            CloudAuthResponse.requireSuccess(303, "https://evil.test", listOf("a=b"))
        }
        assertThrows(CloudAuthException::class.java) {
            CloudAuthResponse.requireSuccess(303, "/dashboard?client=android", emptyList())
        }
        assertThrows(CloudAuthException::class.java) {
            CloudAuthResponse.requireSuccess(
                303,
                "/dashboard?client=android",
                listOf("laymux_session=value; Path=/; Secure; SameSite=Lax"),
            )
        }
        assertThrows(CloudAuthException::class.java) {
            CloudAuthResponse.requireSuccess(
                303,
                "/dashboard?client=android",
                listOf(
                    "laymux_session=value; Domain=.laymux.com; Path=/; HttpOnly; Secure; SameSite=Lax",
                ),
            )
        }
        assertThrows(CloudAuthException::class.java) {
            CloudAuthResponse.requireSuccess(
                303,
                "/dashboard?client=android",
                listOf("laymux_session=value\r\nX-Evil: true"),
            )
        }
    }
}
