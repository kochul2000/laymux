package com.laymux.android.web

/**
 * A Remote download is host-controlled data: the desktop chose the file name and the byte
 * count, and a Remote document could ask to save anything the lease can read (ADR-0185).
 * So the name is rebuilt here rather than trusted, and the size is bounded before anything
 * is written to shared storage.
 *
 * Only the name is policed. The bytes themselves are opaque — this device does not open
 * them, it stores them — so their content is not this object's business.
 */
object RemoteDownloadPolicy {
    /** Matches Android E2E's stricter source bound (`MAX_ANDROID_E2E_FILE_VIEWER_BYTES`). */
    const val MAX_DOWNLOAD_BYTES: Int = 2 * 1024 * 1024

    /** Largest padded base64 string that can represent the decoded byte bound. */
    const val MAX_ENCODED_DOWNLOAD_CHARS: Int = ((MAX_DOWNLOAD_BYTES + 2) / 3) * 4

    /** Long enough for real file names, short enough to stay under every FS limit. */
    private const val MAX_NAME_LENGTH = 96

    private const val FALLBACK_NAME = "laymux-download"

    /**
     * A single file name safe to hand `MediaStore.DISPLAY_NAME`.
     *
     * Path separators are the whole risk here: a display name containing `/` or `\` can
     * place the file outside the Downloads collection on some OEM implementations. Every
     * separator, control character and reserved character is replaced rather than rejected,
     * because a save that lands under a slightly different name is a better outcome for the
     * user than a save that fails.
     */
    fun safeDisplayName(raw: String): String {
        // Take the last segment for either separator: the host may be Windows or WSL.
        val lastSegment = raw.substringAfterLast('/').substringAfterLast('\\')
        val cleaned = lastSegment
            .map { character ->
                when {
                    character.isISOControl() -> '_'
                    character in RESERVED_CHARACTERS -> '_'
                    else -> character
                }
            }
            .joinToString("")
            .trim()
            .trimEnd('.')
        // "." and ".." survive the pass above but name a directory, never a file.
        if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") return FALLBACK_NAME
        return truncatePreservingExtension(cleaned)
    }

    /** True when the decoded payload is within the transfer bound. */
    fun isWithinBound(byteCount: Int): Boolean = byteCount in 0..MAX_DOWNLOAD_BYTES

    /** Reject oversized bridge strings before `Base64.decode` allocates an output buffer. */
    fun isEncodedPayloadWithinBound(characterCount: Int): Boolean =
        characterCount in 0..MAX_ENCODED_DOWNLOAD_CHARS

    /**
     * Trim the stem, not the extension: a truncated `.png` stops being an image to every
     * app on the device, while a shortened stem is still recognisable to the user.
     */
    private fun truncatePreservingExtension(name: String): String {
        if (name.length <= MAX_NAME_LENGTH) return name
        val dotIndex = name.lastIndexOf('.')
        // A "extension" longer than this is not one; treat the whole name as a stem.
        if (dotIndex <= 0 || name.length - dotIndex > 12) return name.take(MAX_NAME_LENGTH)
        val extension = name.substring(dotIndex)
        val stemBudget = MAX_NAME_LENGTH - extension.length
        if (stemBudget <= 0) return name.take(MAX_NAME_LENGTH)
        return name.take(stemBudget) + extension
    }

    private val RESERVED_CHARACTERS = charArrayOf('/', '\\', ':', '*', '?', '"', '<', '>', '|')
}
