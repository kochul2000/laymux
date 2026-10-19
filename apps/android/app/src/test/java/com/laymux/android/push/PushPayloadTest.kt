package com.laymux.android.push

import org.junit.Assert.*
import org.junit.Test

class PushPayloadTest {
    private val instance = "11111111-1111-4111-8111-111111111111"
    private val notification = "22222222-2222-4222-8222-222222222222"
    private fun data() = mapOf("instanceId" to instance, "notificationId" to notification,
        "action" to "created", "revision" to "1", "body" to "hello")

    @Test fun validatesRoutingAndIgnoresCallerUrl() {
        val payload = PushPayload.parse(data() + ("url" to "https://evil.test"))!!
        assertEquals("laymux:$instance:$notification", payload.tag)
        assertEquals(instance, payload.instanceId)
        assertNull(PushPayload.parse(data() + ("instanceId" to "../other")))
        assertNull(PushPayload.parse(data() + ("notificationId" to "javascript:alert(1)")))
    }

    @Test fun readAndCreatedHaveConsistentRevisionAndBoundedBody() {
        assertNull(PushPayload.parse(data() + ("revision" to "2")))
        assertNotNull(PushPayload.parse(data() + mapOf("action" to "read", "revision" to "2")))
        assertEquals(500, PushPayload.parse(data() + ("body" to "x".repeat(900)))!!.body.length)
        assertFalse(PushPayload.shouldApply(2, 1))
        assertFalse(PushPayload.shouldApply(1, 1))
        assertTrue(PushPayload.shouldApply(1, 2))
    }
}
