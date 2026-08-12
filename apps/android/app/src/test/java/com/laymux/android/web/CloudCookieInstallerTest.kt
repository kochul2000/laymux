package com.laymux.android.web

import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudCookieInstallerTest {
    @Test
    fun doesNotCompleteBeforeTheCookieStoreCallback() = runBlocking {
        var callback: ((Boolean) -> Unit)? = null
        val completed = AtomicBoolean(false)
        val install = async {
            CloudCookieInstaller.install(
                originUrl = "https://app.laymux.com",
                cookies = listOf("session=value; Secure; HttpOnly; Path=/; SameSite=Lax"),
                setCookie = { _, _, result -> callback = result },
            )
            completed.set(true)
        }

        yield()
        assertFalse(completed.get())
        requireNotNull(callback).invoke(true)
        install.await()
        assertTrue(completed.get())
    }

    @Test
    fun rejectsACloudCookieTheStoreDidNotAccept() {
        assertThrows(CloudAuthException::class.java) {
            runBlocking {
                CloudCookieInstaller.install(
                    originUrl = "https://app.laymux.com",
                    cookies = listOf("session=value; Secure; HttpOnly; Path=/; SameSite=Lax"),
                    setCookie = { _, _, result -> result(false) },
                )
            }
        }
    }
}
