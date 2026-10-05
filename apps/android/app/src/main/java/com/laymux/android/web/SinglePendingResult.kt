package com.laymux.android.web

/** Delivers or cancels one Activity Result callback exactly once. */
internal class SinglePendingResult<T> {
    private var callback: ((T?) -> Unit)? = null
    private var ready = true
    private var hasResult = false
    private var result: T? = null

    fun setReady(value: Boolean) {
        ready = value
        if (ready && hasResult) deliver(result)
    }

    fun replace(next: (T?) -> Unit) {
        cancel()
        callback = next
    }

    fun complete(value: T?) {
        if (callback == null || hasResult) return
        if (!ready) {
            result = value
            hasResult = true
            return
        }
        deliver(value)
    }

    private fun deliver(value: T?) {
        val current = callback
        callback = null
        result = null
        hasResult = false
        current?.invoke(value)
    }

    fun cancel() = deliver(null)
}
