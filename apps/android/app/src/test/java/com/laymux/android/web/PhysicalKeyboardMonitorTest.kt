package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhysicalKeyboardMonitorTest {
    private class Devices : PhysicalKeyboardSource {
        var keyboards = 0
        var listener: (() -> Unit)? = null
        var subscriptions = 0
        override fun isConnected() = keyboards > 0
        override fun start(onChanged: () -> Unit) { subscriptions++; listener = onChanged }
        override fun stop() { listener = null }
        fun change(count: Int) { keyboards = count; listener?.invoke() }
    }

    @Test
    fun observesInitialConnectionAndKeepsRemainingKeyboardAfterOneIsRemoved() {
        val devices = Devices().apply { keyboards = 2 }
        val changes = mutableListOf<Boolean>()
        val monitor = PhysicalKeyboardMonitor(devices, changes::add)
        monitor.start()
        assertTrue(monitor.connected)
        devices.change(1)
        assertEquals(listOf(true), changes)
        devices.change(0)
        assertFalse(monitor.connected)
        assertEquals(listOf(true, false), changes)
    }

    @Test
    fun resamplesAfterBackgroundAndIgnoresLateCallbacksWhileStopped() {
        val devices = Devices()
        val changes = mutableListOf<Boolean>()
        val monitor = PhysicalKeyboardMonitor(devices, changes::add)
        monitor.start()
        monitor.start()
        assertEquals(1, devices.subscriptions)
        val lateCallback = devices.listener!!
        monitor.stop()
        devices.change(1)
        lateCallback()
        assertEquals(listOf(false), changes)
        monitor.start()
        assertTrue(monitor.connected)
        assertEquals(listOf(false, true), changes)
        monitor.stop()
        monitor.stop()
    }
}
