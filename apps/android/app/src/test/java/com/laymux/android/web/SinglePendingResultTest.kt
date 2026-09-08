package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Test

class SinglePendingResultTest {
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
