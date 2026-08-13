package com.laymux.android.pairing

/**
 * Holds work that must not start while the host activity is paused.
 *
 * The Google code scanner runs in its own activity, so its result callback can
 * reach us before the host resumes. A [android.app.Activity] that requests
 * BiometricPrompt at that moment never shows the prompt and never receives a
 * callback, which leaves the pairing state machine pending forever: no dialog,
 * no error, and every button that guards on "an operation is in flight" stays
 * dead until the process is killed. Requests made while paused wait here and
 * run on the next resume instead.
 */
class ResumeGatedRunner {
    private var resumed = false
    private var pending: (() -> Unit)? = null

    val hasPending: Boolean
        get() = pending != null

    fun onResumed() {
        resumed = true
        val action = pending ?: return
        pending = null
        action()
    }

    fun onPaused() {
        resumed = false
    }

    /**
     * Runs [action] now when resumed, otherwise once the host resumes again.
     *
     * Returns false when a request is already waiting: the deferred lambda owns
     * the cleanup of the secret its caller prepared, so replacing it would drop
     * that cleanup silently. The caller cleans up its own request instead.
     */
    fun runWhenResumed(action: () -> Unit): Boolean {
        if (pending != null) return false
        if (resumed) {
            action()
            return true
        }
        pending = action
        return true
    }

    /** Drops a deferred request. Returns true when one was waiting. */
    fun cancelPending(): Boolean {
        val had = pending != null
        pending = null
        return had
    }
}
