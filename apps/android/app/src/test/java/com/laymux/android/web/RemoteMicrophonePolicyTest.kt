package com.laymux.android.web

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteMicrophonePolicyTest {
    @Test
    fun onlyTheCurrentRemoteDocumentCanRequestAudioAlone() {
        val audio = listOf("android.webkit.resource.AUDIO_CAPTURE")
        assertTrue(allowRemoteMicrophone("https://remote.laymux.invalid", audio, true))
        assertFalse(allowRemoteMicrophone("https://remote.laymux.invalid.evil.test", audio, true))
        assertFalse(allowRemoteMicrophone("https://remote.laymux.invalid", audio, false))
        assertFalse(allowRemoteMicrophone("https://remote.laymux.invalid", emptyList(), true))
        assertFalse(allowRemoteMicrophone("https://remote.laymux.invalid", audio + "android.webkit.resource.VIDEO_CAPTURE", true))
    }
}
