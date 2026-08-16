package com.laymux.android.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteHttpRequestRegistryTest {
    @Test
    fun cancelledQueuedRequestIsNoLongerCurrent() {
        val registry = RemoteHttpRequestRegistry()
        val ticket = requireNotNull(registry.register("http-document-a-1"))

        assertTrue(registry.isCurrent(ticket))
        assertTrue(registry.cancel(ticket.requestId))
        assertFalse(registry.isCurrent(ticket))
    }

    @Test
    fun staleCompletionCannotRemoveAReusedRequestId() {
        val registry = RemoteHttpRequestRegistry()
        val stale = requireNotNull(registry.register("http-document-a-1"))
        assertTrue(registry.cancel(stale.requestId))
        val current = requireNotNull(registry.register(stale.requestId))

        assertFalse(registry.complete(stale))
        assertTrue(registry.isCurrent(current))
        assertTrue(registry.complete(current))
        assertFalse(registry.isCurrent(current))
    }

    @Test
    fun duplicateLiveRequestIdIsRejected() {
        val registry = RemoteHttpRequestRegistry()

        requireNotNull(registry.register("http-document-a-1"))
        assertNull(registry.register("http-document-a-1"))
    }
}
