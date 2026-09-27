package com.laymux.android.web

internal interface PhysicalKeyboardSource {
    fun isConnected(): Boolean
    fun start(onChanged: () -> Unit)
    fun stop()
}

/** Foreground lifecycle owner; the JS bridge reads only the latest snapshot. */
internal class PhysicalKeyboardMonitor(
    private val source: PhysicalKeyboardSource,
    private val onChanged: (Boolean) -> Unit,
) {
    @Volatile
    var connected: Boolean = false
        private set
    private var started = false

    fun start() {
        if (started) return
        started = true
        // Subscribe first so an attachment cannot fall between snapshot and subscription.
        source.start { refresh() }
        refresh(force = true)
    }

    private fun refresh(force: Boolean = false) {
        if (!started) return
        val next = source.isConnected()
        if (!force && connected == next) return
        connected = next
        onChanged(next)
    }

    fun stop() {
        if (!started) return
        started = false
        source.stop()
    }
}
