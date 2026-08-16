package com.laymux.android.web

import java.util.Locale

/**
 * Transfer counters behind the Remote UI loading overlay (ADR-0168).
 *
 * While the WebView document swaps, the previous page stays on screen with no
 * hint that megabytes of assets are crossing the relay one serial RPC at a
 * time — these counters give the native overlay something honest to say.
 * Owned by the UI thread; transport threads post copies through the activity.
 */
internal data class RemoteLoadProgress(
    val fetchedCount: Int = 0,
    val cachedCount: Int = 0,
    val receivedBytes: Long = 0L,
    val fetchingPath: String? = null,
) {
    fun fetching(path: String): RemoteLoadProgress = copy(fetchingPath = path)

    fun fetched(bytes: Int): RemoteLoadProgress = copy(
        fetchedCount = fetchedCount + 1,
        receivedBytes = receivedBytes + bytes,
        fetchingPath = null,
    )

    fun fetchFailed(): RemoteLoadProgress = copy(fetchingPath = null)

    fun cacheHit(): RemoteLoadProgress = copy(cachedCount = cachedCount + 1)

    fun statusText(): String = buildString {
        append("원격 UI 수신 중")
        if (fetchedCount > 0) {
            append(" · ").append(fetchedCount).append("개 · ").append(formatBytes(receivedBytes))
        }
        if (cachedCount > 0) {
            append(" · 캐시 ").append(cachedCount).append("개")
        }
        fetchingPath?.let { append('\n').append(displayName(it)) }
    }

    companion object {
        internal fun displayName(path: String): String {
            // A trailing slash is the Remote root document, not a file.
            val name = path.substringAfterLast('/')
            return name.ifEmpty { "원격 페이지" }
        }

        internal fun formatBytes(bytes: Long): String = when {
            bytes >= 1024L * 1024L ->
                String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
            bytes >= 1024L -> "${bytes / 1024} KB"
            else -> "$bytes B"
        }
    }
}
