package com.laymux.android.web

import android.hardware.input.InputManager
import android.os.Handler
import android.os.Looper
import android.view.InputDevice

internal class AndroidPhysicalKeyboardSource(
    private val inputManager: InputManager,
) : PhysicalKeyboardSource {
    private var onChanged: (() -> Unit)? = null
    private val listener = object : InputManager.InputDeviceListener {
        override fun onInputDeviceAdded(deviceId: Int) { onChanged?.invoke() }
        override fun onInputDeviceRemoved(deviceId: Int) { onChanged?.invoke() }
        override fun onInputDeviceChanged(deviceId: Int) { onChanged?.invoke() }
    }

    override fun isConnected(): Boolean = inputManager.inputDeviceIds.any { id ->
        val device = inputManager.getInputDevice(id)
        device != null && !device.isVirtual &&
            device.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC
    }

    override fun start(onChanged: () -> Unit) {
        this.onChanged = onChanged
        inputManager.registerInputDeviceListener(listener, Handler(Looper.getMainLooper()))
    }

    override fun stop() {
        onChanged = null
        inputManager.unregisterInputDeviceListener(listener)
    }
}
