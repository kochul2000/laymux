package com.laymux.android.web

/** Delivers or cancels one Activity Result callback exactly once. */
internal class SinglePendingResult<T> {
    private var callback: ((T?) -> Unit)? = null

    fun replace(next: (T?) -> Unit) {
        cancel()
        callback = next
    }

    fun complete(value: T?) {
        val current = callback
        callback = null
        current?.invoke(value)
    }

    fun cancel() = complete(null)
}
