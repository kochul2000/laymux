package com.laymux.android.remote

/** Matches the desktop Remote attachment route's 1.5 MiB JSON body bound. */
internal const val MAX_REMOTE_HTTP_BODY_CHARS = 1536 * 1024

internal fun remoteHttpBodyWithinLimit(bodyJson: String?): Boolean =
    (bodyJson?.length ?: 0) <= MAX_REMOTE_HTTP_BODY_CHARS
