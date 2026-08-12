package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Test

class RemoteOutputBridgeTest {
    @Test
    fun snapshotCarriesBracketedPasteOnAndOffToTheLocalXterm() {
        assertEquals(
            "if (window.laymuxNative) window.laymuxNative.onRemoteOutput(\"AA\",true,80,24,true);",
            RemoteOutputBridge.script("AA", true, 80, 24, true),
        )
        assertEquals(
            "if (window.laymuxNative) window.laymuxNative.onRemoteOutput(\"AA\",true,80,24,false);",
            RemoteOutputBridge.script("AA", true, 80, 24, false),
        )
    }

    @Test
    fun deltaWithoutModesDoesNotOverwriteTheCurrentXtermMode() {
        assertEquals(
            "if (window.laymuxNative) window.laymuxNative.onRemoteOutput(\"AA\",false,80,24,null);",
            RemoteOutputBridge.script("AA", false, 80, 24, null),
        )
    }
}
