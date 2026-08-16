package com.laymux.android.web

import com.laymux.android.remote.TailscaleEndpoint
import java.util.UUID

sealed interface TailscaleRouteHint {
    data object Missing : TailscaleRouteHint
    data class Valid(val url: String) : TailscaleRouteHint
    data object Invalid : TailscaleRouteHint
}

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

    fun validTailscaleUrl(value: String): String? = TailscaleEndpoint.canonicalUrl(value)

    fun tailscaleRouteHint(value: String): TailscaleRouteHint {
        if (value.isEmpty()) return TailscaleRouteHint.Missing
        return validTailscaleUrl(value)?.let(TailscaleRouteHint::Valid)
            ?: TailscaleRouteHint.Invalid
    }
}
