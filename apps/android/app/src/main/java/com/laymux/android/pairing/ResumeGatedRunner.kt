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

    /** Runs [action] now when resumed, otherwise once the host resumes again. */
    fun runWhenResumed(action: () -> Unit) {
        if (resumed) {
            action()
            return
        }
        pending = action
    }

    /** Drops a deferred request. Returns true when one was waiting. */
    fun cancelPending(): Boolean {
        val had = pending != null
        pending = null
        return had
    }
}
