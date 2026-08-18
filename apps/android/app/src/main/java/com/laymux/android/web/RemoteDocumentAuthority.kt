package com.laymux.android.web

import java.util.concurrent.atomic.AtomicLong

/** Grants Remote bridge authority to exactly one installed secure-WebView document generation. */
internal class RemoteDocumentAuthority {
    private val sequence = AtomicLong()

    @Volatile
    private var installedGeneration = 0L

    @Volatile
    private var authorizedGeneration: Long? = null

    fun installFreshDocument(): Long {
        val generation = sequence.incrementAndGet()
        installedGeneration = generation
        authorizedGeneration = null
        return generation
    }

    fun authorize(generation: Long): Boolean {
        if (generation != installedGeneration) return false
        authorizedGeneration = generation
        return true
    }

    fun revoke() {
        authorizedGeneration = null
    }

    fun allows(generation: Long, remoteSurface: Boolean): Boolean =
        remoteSurface &&
            generation == installedGeneration &&
            generation == authorizedGeneration
}
