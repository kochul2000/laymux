package com.laymux.android.remote

import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

/** Preserves the one sequential RPC that can cross an Android background transition. */
internal class RemoteHttpResumeTracker {
    class Attempt internal constructor(
        val requestId: String,
        internal val session: Any,
        val generation: Long,
    )

    data class Completion(
        val requestId: String,
        val response: JSONObject?,
    )

    private data class State(
        val attempt: Attempt,
        val response: JSONObject?,
    )

    private val active = AtomicReference<State?>()

    fun begin(requestId: String, session: Any, generation: Long): Attempt? {
        val attempt = Attempt(requestId, session, generation)
        return if (active.compareAndSet(null, State(attempt, null))) attempt else null
    }

    fun retain(attempt: Attempt, response: JSONObject? = null): Boolean {
        while (true) {
            val current = active.get() ?: return false
            if (current.attempt !== attempt) return false
            val updated = if (current.response == null && response != null) {
                current.copy(response = response)
            } else {
                current
            }
            if (updated === current || active.compareAndSet(current, updated)) return true
        }
    }

    fun captureResumedResponse(session: Any, response: JSONObject?) {
        if (response == null) return
        while (true) {
            val current = active.get() ?: return
            if (current.attempt.session !== session || current.response != null) return
            if (active.compareAndSet(current, current.copy(response = response))) return
        }
    }

    fun finish(attempt: Attempt) {
        while (true) {
            val current = active.get() ?: return
            if (current.attempt !== attempt) return
            if (active.compareAndSet(current, null)) return
        }
    }

    fun cancel(requestId: String) {
        while (true) {
            val current = active.get() ?: return
            if (current.attempt.requestId != requestId) return
            if (active.compareAndSet(current, null)) return
        }
    }

    fun take(session: Any): Completion? {
        while (true) {
            val current = active.get() ?: return null
            if (current.attempt.session !== session) return null
            if (active.compareAndSet(current, null)) {
                return Completion(current.attempt.requestId, current.response)
            }
        }
    }

    fun clear() {
        active.set(null)
    }
}
