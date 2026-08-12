package com.laymux.android.web

import java.util.UUID

object CloudBridgeInput {
    private val NONCE_PATTERN = Regex("^[A-Za-z0-9_-]{43}$")

    fun isValidNonce(value: String): Boolean = NONCE_PATTERN.matches(value)

    fun isValidInstanceId(value: String): Boolean = try {
        value == value.lowercase() && UUID.fromString(value).toString() == value
    } catch (_: IllegalArgumentException) {
        false
    }

    fun matchesSelectedInstance(selectedInstanceId: String?, pairingInstanceId: String): Boolean =
        selectedInstanceId == null || selectedInstanceId == pairingInstanceId
}
