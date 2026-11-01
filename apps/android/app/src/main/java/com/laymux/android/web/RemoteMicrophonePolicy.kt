package com.laymux.android.web

internal fun allowRemoteMicrophone(origin: String, resources: List<String>, currentDocument: Boolean): Boolean =
    currentDocument && origin == "https://remote.laymux.invalid" &&
        resources == listOf("android.webkit.resource.AUDIO_CAPTURE")
