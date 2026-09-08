package com.laymux.android.remote

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** Tracks WebView HTTP requests without letting stale completion remove a reused id. */
internal class RemoteHttpRequestRegistry {
    class Ticket internal constructor(
        val requestId: String,
        internal val token: Long,
    )

    private val nextToken = AtomicLong(1)
    private val active = ConcurrentHashMap<String, Long>()

    fun register(requestId: String): Ticket? {
        val token = claimToken()
        return if (active.putIfAbsent(requestId, token) == null) {
            Ticket(requestId, token)
        } else {
            null
        }
    }

    private fun claimToken(): Long {
        while (true) {
            val current = nextToken.get()
            val following = if (current == Long.MAX_VALUE) 1 else current + 1
            if (nextToken.compareAndSet(current, following)) return current
        }
    }

    fun isCurrent(ticket: Ticket): Boolean = active[ticket.requestId] == ticket.token

    fun cancel(requestId: String): Boolean = active.remove(requestId) != null

    fun complete(ticket: Ticket): Boolean = active.remove(ticket.requestId, ticket.token)

    fun clear() {
        active.clear()
    }
}
