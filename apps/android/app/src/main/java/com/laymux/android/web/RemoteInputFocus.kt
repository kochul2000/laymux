package com.laymux.android.web

internal fun scheduleRemoteInputFocus(
    post: (Runnable) -> Boolean,
    canFocus: () -> Boolean,
    requestFocusFromTouch: () -> Boolean,
): Boolean = post(
    Runnable {
        if (canFocus()) requestFocusFromTouch()
    },
)
