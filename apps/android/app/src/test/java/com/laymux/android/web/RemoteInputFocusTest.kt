package com.laymux.android.web

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteInputFocusTest {
    @Test
    fun defersTouchFocusUntilTheRemoteDocumentIsReadyForInput() {
        var scheduled: Runnable? = null
        var requested = false

        val accepted = scheduleRemoteInputFocus(
            post = { action ->
                scheduled = action
                true
            },
            canFocus = { true },
            requestFocusFromTouch = {
                requested = true
                true
            },
        )

        assertTrue(accepted)
        assertFalse(requested)
        scheduled!!.run()
        assertTrue(requested)
    }

    @Test
    fun skipsADeferredFocusWhenTheRemoteDocumentIsNoLongerCurrent() {
        var scheduled: Runnable? = null
        var current = true
        var requested = false

        scheduleRemoteInputFocus(
            post = { action ->
                scheduled = action
                true
            },
            canFocus = { current },
            requestFocusFromTouch = {
                requested = true
                true
            },
        )

        current = false
        scheduled!!.run()

        assertFalse(requested)
    }
}
