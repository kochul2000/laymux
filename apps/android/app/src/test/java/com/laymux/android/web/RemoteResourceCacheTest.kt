package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class RemoteResourceCacheTest {
    private var now = 1_000L

    private fun cache(maxTotalBytes: Long = 16L * 1024 * 1024): RemoteResourceCache =
        RemoteResourceCache(maxTotalBytes = maxTotalBytes, nowEpochSeconds = { now })

    private fun response(
        cacheControl: String?,
        status: Int = 200,
        bodySize: Int = 4,
    ): RemoteResourceResponse = RemoteResourceResponse(
        status = status,
        mimeType = "font/ttf",
        encoding = null,
        headers = buildMap { cacheControl?.let { put("cache-control", it) } },
        body = ByteArray(bodySize),
    )

    @Test
    fun cachesOnlyExplicitPositiveMaxAge() {
        assertEquals(
            31_536_000L,
            RemoteResourceCache.cacheTtlSeconds(
                response("private, max-age=31536000, immutable"),
            ),
        )
        assertEquals(86_400L, RemoteResourceCache.cacheTtlSeconds(response("private, max-age=86400")))
        assertNull(RemoteResourceCache.cacheTtlSeconds(response("no-store")))
        assertNull(RemoteResourceCache.cacheTtlSeconds(response("no-cache, max-age=60")))
        assertNull(RemoteResourceCache.cacheTtlSeconds(response("max-age=60, no-store")))
        assertNull(RemoteResourceCache.cacheTtlSeconds(response(null)))
        assertNull(RemoteResourceCache.cacheTtlSeconds(response("max-age=0")))
        assertNull(RemoteResourceCache.cacheTtlSeconds(response("max-age=weird")))
        assertNull(RemoteResourceCache.cacheTtlSeconds(response("max-age=60", status = 404)))
        // Lenient with whitespace and directive arguments, still fail closed.
        assertEquals(86_400L, RemoteResourceCache.cacheTtlSeconds(response("private, max-age = 86400")))
        assertNull(RemoteResourceCache.cacheTtlSeconds(response("no-cache=\"set-cookie\", max-age=60")))
    }

    @Test
    fun ttlIsCappedAtOneYear() {
        assertEquals(
            31_536_000L,
            RemoteResourceCache.cacheTtlSeconds(response("max-age=99999999999")),
        )
    }

    @Test
    fun returnsCachedResponseUntilExpiry() {
        val cache = cache()
        val font = response("private, max-age=100, immutable")
        cache.put("pc-1", "/remote/font/a.ttf", font)

        assertSame(font, cache.get("pc-1", "/remote/font/a.ttf"))
        now += 99
        assertSame(font, cache.get("pc-1", "/remote/font/a.ttf"))
        now += 1
        assertNull(cache.get("pc-1", "/remote/font/a.ttf"))
    }

    @Test
    fun neverStoresUncacheableResponses() {
        val cache = cache()
        cache.put("pc-1", "/remote/", response("no-store"))
        cache.put("pc-1", "/remote/vendor/xterm.js", response(null))
        cache.put("pc-1", "/remote/font/a.ttf", response("max-age=60", status = 503))

        assertNull(cache.get("pc-1", "/remote/"))
        assertNull(cache.get("pc-1", "/remote/vendor/xterm.js"))
        assertNull(cache.get("pc-1", "/remote/font/a.ttf"))
    }

    @Test
    fun entriesAreScopedToTheInstance() {
        val cache = cache()
        cache.put("pc-1", "/remote/font/a.ttf", response("max-age=100"))

        assertNull(cache.get("pc-2", "/remote/font/a.ttf"))
    }

    @Test
    fun evictsLeastRecentlyUsedWhenOverBudget() {
        val cache = cache(maxTotalBytes = 10)
        cache.put("pc-1", "/a", response("max-age=100", bodySize = 4))
        cache.put("pc-1", "/b", response("max-age=100", bodySize = 4))
        // Touch /a so /b becomes the least recently used entry.
        cache.get("pc-1", "/a")
        cache.put("pc-1", "/c", response("max-age=100", bodySize = 4))

        assertNull(cache.get("pc-1", "/b"))
        assertEquals(4, cache.get("pc-1", "/a")?.body?.size)
        assertEquals(4, cache.get("pc-1", "/c")?.body?.size)
    }

    @Test
    fun rejectsBodiesLargerThanTheWholeBudget() {
        val cache = cache(maxTotalBytes = 10)
        cache.put("pc-1", "/a", response("max-age=100", bodySize = 11))

        assertNull(cache.get("pc-1", "/a"))
    }

    @Test
    fun replacingAnEntryReleasesItsBytes() {
        val cache = cache(maxTotalBytes = 10)
        cache.put("pc-1", "/a", response("max-age=100", bodySize = 6))
        cache.put("pc-1", "/a", response("max-age=100", bodySize = 6))
        // 6+6 would exceed the budget and evict; a replacement must not.
        assertEquals(6, cache.get("pc-1", "/a")?.body?.size)
    }

    @Test
    fun clearScopesToOneInstanceOrEverything() {
        val cache = cache()
        cache.put("pc-1", "/remote/font/a.ttf", response("max-age=100"))
        cache.put("pc-2", "/remote/font/a.ttf", response("max-age=100"))

        cache.clear("pc-1")
        assertNull(cache.get("pc-1", "/remote/font/a.ttf"))
        assertEquals(200, cache.get("pc-2", "/remote/font/a.ttf")?.status)

        cache.clear()
        assertNull(cache.get("pc-2", "/remote/font/a.ttf"))
    }
}
