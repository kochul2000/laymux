package com.laymux.android.web

/**
 * Memory-only cache for AEAD-verified Remote resources (ADR-0168).
 *
 * Every Remote UI resource crosses the relay as a serial encrypted RPC, so a
 * reconnect re-downloads megabytes of assets. Only responses the desktop
 * explicitly marked cacheable (`Cache-Control: max-age=N` without
 * `no-store`/`no-cache`) are kept — content-hashed fonts (ADR-0077) and PWA
 * icons — while `no-store` documents and unmarked vendor scripts stay fresh.
 * Nothing is ever written to disk; the cache dies with the process.
 */
internal class RemoteResourceCache(
    private val maxTotalBytes: Long = DEFAULT_MAX_TOTAL_BYTES,
    private val nowEpochSeconds: () -> Long = { System.currentTimeMillis() / 1_000 },
) {
    private class Entry(
        val response: RemoteResourceResponse,
        val expiresAtEpochSeconds: Long,
    )

    private val lock = Any()
    private val entries = LinkedHashMap<String, Entry>(INITIAL_CAPACITY, LOAD_FACTOR, true)
    private var totalBytes = 0L

    fun get(instanceId: String, path: String): RemoteResourceResponse? = synchronized(lock) {
        val key = key(instanceId, path)
        val entry = entries[key] ?: return null
        if (nowEpochSeconds() >= entry.expiresAtEpochSeconds) {
            entries.remove(key)
            totalBytes -= entry.response.body.size
            return null
        }
        entry.response
    }

    fun put(instanceId: String, path: String, response: RemoteResourceResponse) {
        val ttlSeconds = cacheTtlSeconds(response) ?: return
        if (response.body.size > maxTotalBytes) return
        synchronized(lock) {
            val key = key(instanceId, path)
            entries.remove(key)?.let { totalBytes -= it.response.body.size }
            entries[key] = Entry(response, nowEpochSeconds() + ttlSeconds)
            totalBytes += response.body.size
            val iterator = entries.values.iterator()
            while (totalBytes > maxTotalBytes && iterator.hasNext()) {
                totalBytes -= iterator.next().response.body.size
                iterator.remove()
            }
        }
    }

    fun clear(instanceId: String? = null) {
        synchronized(lock) {
            if (instanceId == null) {
                entries.clear()
                totalBytes = 0
                return
            }
            val prefix = key(instanceId, "")
            val iterator = entries.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                if (entry.key.startsWith(prefix)) {
                    totalBytes -= entry.value.response.body.size
                    iterator.remove()
                }
            }
        }
    }

    companion object {
        private const val DEFAULT_MAX_TOTAL_BYTES = 16L * 1024 * 1024
        private const val MAX_TTL_SECONDS = 31_536_000L
        private const val INITIAL_CAPACITY = 16
        private const val LOAD_FACTOR = 0.75f

        // The instance id is a 1..128 identifier without control characters, so a
        // newline cannot collide with path bytes.
        private fun key(instanceId: String, path: String): String = "$instanceId\n$path"

        /**
         * Opt-in only: no Cache-Control header means no caching, unlike browser
         * heuristic caching — an unmarked asset may change with any desktop update.
         */
        internal fun cacheTtlSeconds(response: RemoteResourceResponse): Long? {
            if (response.status != 200) return null
            val cacheControl = response.headers["cache-control"] ?: return null
            var maxAgeSeconds: Long? = null
            for (directive in cacheControl.split(',')) {
                val parts = directive.trim().lowercase().split('=', limit = 2)
                when (parts[0].trim()) {
                    "no-store", "no-cache" -> return null
                    "max-age" -> maxAgeSeconds = parts.getOrNull(1)?.trim()
                        ?.toLongOrNull()
                        ?.takeIf { it > 0 }
                }
            }
            return maxAgeSeconds?.coerceAtMost(MAX_TTL_SECONDS)
        }
    }
}
