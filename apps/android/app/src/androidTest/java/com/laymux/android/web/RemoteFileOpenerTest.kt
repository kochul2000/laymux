package com.laymux.android.web

import android.content.Context
import android.content.Intent
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RemoteFileOpenerTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun originalHtmlIsReadableThroughTemporaryReadOnlyContentUri() {
        val original = "<h1>원본 HTML</h1>".toByteArray()
        val intent = RemoteFileOpener.prepare(context, "../notes.html", "text/html", Base64.encodeToString(original, Base64.NO_WRAP))
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals("text/html", intent.type)
        assertEquals("content", intent.data!!.scheme)
        assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, intent.flags)
        assertEquals(intent.data, intent.clipData!!.getItemAt(0).uri)
        assertArrayEquals(original, context.contentResolver.openInputStream(intent.data!!)!!.use { it.readBytes() })
    }

    @Test
    fun sameNameKeepsIndependentCopiesAndPdfMimeType() {
        val first = RemoteFileOpener.prepare(context, "report.pdf", "application/pdf", "YQ==")
        val second = RemoteFileOpener.prepare(context, "report.pdf", "application/pdf", "Yg==")
        assertNotEquals(first.data, second.data)
        assertEquals("application/pdf", first.type)
        assertEquals("a", context.contentResolver.openInputStream(first.data!!)!!.bufferedReader().use { it.readText() })
    }

    @Test
    fun oversizedAndInvalidPayloadsAreRejected() {
        for (payload in listOf("a", "A".repeat(RemoteDownloadPolicy.MAX_ENCODED_DOWNLOAD_CHARS + 1))) {
            assertThrows(IllegalArgumentException::class.java) {
                RemoteFileOpener.prepare(context, "file.pdf", "application/pdf", payload)
            }
        }
    }
}
