package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Test

class SinglePendingResultTest {
    @Test
    fun pickerResultWaitsForTransportResumeAndIsDeliveredOnce() {
        val pending = SinglePendingResult<String>()
        val received = mutableListOf<String?>()
        pending.replace(received::add)
        pending.setReady(false)
        pending.complete("content://gallery/photo")
        assertEquals(emptyList<String?>(), received)
        pending.setReady(true)
        pending.setReady(true)
        assertEquals(listOf("content://gallery/photo"), received)
    }

    @Test
    fun replacementDocumentCancelsADeferredPickerResult() {
        val pending = SinglePendingResult<String>()
        val received = mutableListOf<String?>()
        pending.replace(received::add)
        pending.setReady(false)
        pending.complete("content://gallery/photo")
        pending.cancel()
        pending.setReady(true)
        assertEquals(listOf<String?>(null), received)
    }

    @Test
    fun replacementCancellationAndCompletionAreDeliveredExactlyOnce() {
        val pending = SinglePendingResult<String>()
        val first = mutableListOf<String?>()
        val second = mutableListOf<String?>()

        pending.replace(first::add)
        pending.replace(second::add)
        pending.complete("content://attachment")
        pending.complete("content://late-result")
        pending.cancel()

        assertEquals(listOf<String?>(null), first)
        assertEquals(listOf("content://attachment"), second)
    }
}
