package com.laymux.android.remote

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteHttpResumeTrackerTest {
    @Test
    fun pendingRequestReceivesTheExactResumedResponse() {
        val tracker = RemoteHttpResumeTracker()
        val session = Any()
        val attempt = requireNotNull(
            tracker.begin("http-document-a-1", session, generation = 7),
        )
        val resumed = JSONObject().put("kind", "http").put("status", 200)

        assertTrue(tracker.retain(attempt))
        tracker.captureResumedResponse(session, resumed)
        val completion = requireNotNull(tracker.take(session))

        assertEquals("http-document-a-1", completion.requestId)
        assertSame(resumed, completion.response)
        assertNull(tracker.take(session))
    }

    @Test
    fun completedRequestKeepsItsOwnResponseAheadOfAnInternalResume() {
        val tracker = RemoteHttpResumeTracker()
        val session = Any()
        val attempt = requireNotNull(
            tracker.begin("http-document-a-2", session, generation = 11),
        )
        val completed = JSONObject().put("kind", "http").put("status", 204)
        val internalResume = JSONObject().put("kind", "backgroundTransition")

        assertTrue(tracker.retain(attempt, completed))
        tracker.captureResumedResponse(session, internalResume)
        val completion = requireNotNull(tracker.take(session))

        assertSame(completed, completion.response)
    }

    @Test
    fun cancelledOrDifferentSessionRequestIsNotDelivered() {
        val tracker = RemoteHttpResumeTracker()
        val session = Any()
        tracker.begin("http-document-a-3", session, generation = 13)

        tracker.cancel("http-document-a-3")
        tracker.captureResumedResponse(session, JSONObject())
        assertNull(tracker.take(session))

        val second = requireNotNull(
            tracker.begin("http-document-a-4", session, generation = 14),
        )
        assertTrue(tracker.retain(second))
        tracker.captureResumedResponse(Any(), JSONObject())
        assertNull(tracker.take(Any()))
        assertEquals("http-document-a-4", tracker.take(session)?.requestId)
    }
}
