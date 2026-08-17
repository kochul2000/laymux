package com.laymux.android.web

/**
 * Back press policy for the Remote surface: the system default would quit the
 * app mid-session, so the first press only warns and a second press inside the
 * window leaves to the dashboard.
 */
internal class RemoteBackGuard(
    private val windowMillis: Long = DEFAULT_WINDOW_MILLIS,
) {
    enum class Action { WARN, LEAVE }

    private var warnedAtMillis: Long? = null

    fun onBackPressed(nowMillis: Long): Action {
        val warnedAt = warnedAtMillis
        return if (warnedAt != null && nowMillis - warnedAt <= windowMillis) {
            warnedAtMillis = null
            Action.LEAVE
        } else {
            warnedAtMillis = nowMillis
            Action.WARN
        }
    }

    /** Leaving the Remote surface by any other path discards the pending warning. */
    fun reset() {
        warnedAtMillis = null
    }

    companion object {
        const val DEFAULT_WINDOW_MILLIS = 2_000L
    }
}
