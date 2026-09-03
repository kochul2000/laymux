package com.laymux.android.remote

/**
 * Largest configurable desktop attachment (`remote.attachmentMaxMib`, ADR-0227) as a
 * base64 JSON body: 10 MiB decoded, base64-expanded, plus the desktop's 16 KiB slack for
 * the non-data fields. Matches `attachment_request_limit` in the desktop attachments route.
 */
internal const val MAX_REMOTE_ATTACHMENT_BYTES = 10 * 1024 * 1024
internal const val MAX_REMOTE_HTTP_BODY_CHARS = (MAX_REMOTE_ATTACHMENT_BYTES + 2) / 3 * 4 + 16 * 1024

internal fun remoteHttpBodyWithinLimit(bodyJson: String?): Boolean =
    (bodyJson?.length ?: 0) <= MAX_REMOTE_HTTP_BODY_CHARS
