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

/**
 * Plaintext for one inner Remote HTTP request. The validated body JSON is spliced in
 * verbatim: routing it through `JSONObject.toString()` would escape every `/` in a
 * base64 attachment payload and inflate the plaintext past the desktop bound that is
 * derived from the page's own bytes (ADR-0227).
 */
internal fun remoteHttpRequestPlaintext(method: String, path: String, bodyJson: String?): String =
    buildString {
        append("{\"kind\":\"http\",\"method\":")
        append(org.json.JSONObject.quote(method.uppercase()))
        append(",\"path\":")
        append(org.json.JSONObject.quote(path))
        append(",\"body\":")
        append(bodyJson ?: "null")
        append('}')
    }
