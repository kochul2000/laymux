package com.laymux.android.web

import android.webkit.JavascriptInterface
import com.laymux.android.MainActivity
import com.laymux.android.pairing.BiometricAvailability
import com.laymux.android.pairing.PairingMetadata
import com.laymux.android.pairing.PairingProtectionPolicy
import com.laymux.android.pairing.PairingVault
import org.json.JSONArray
import org.json.JSONObject

/** Narrow bridge: the WebView can request native actions but can never read key bytes. */
class NativeBridge(
    private val activity: MainActivity,
    private val vault: PairingVault,
) {
    @JavascriptInterface
    fun getPairingStatus(): String = statusJson()

    @JavascriptInterface
    fun scanPairingQr() {
        activity.runOnUiThread(activity::startPairingScan)
    }

    @JavascriptInterface
    fun setBiometricRequired(required: Boolean) {
        activity.runOnUiThread { activity.setBiometricRequired(required) }
    }

    @JavascriptInterface
    fun verifyPairingProtection(instanceId: String) {
        activity.runOnUiThread { activity.verifyPairingProtection(instanceId) }
    }

    @JavascriptInterface
    fun retryPairingConfirmation(instanceId: String) {
        activity.runOnUiThread { activity.retryPairingConfirmation(instanceId) }
    }

    @JavascriptInterface
    fun connectRemote() {
        activity.runOnUiThread(activity::connectRemote)
    }

    @JavascriptInterface
    fun disconnectRemote() {
        activity.runOnUiThread(activity::disconnectRemote)
    }

    @JavascriptInterface
    fun showCloudDashboard() {
        activity.runOnUiThread(activity::showCloudDashboard)
    }

    @JavascriptInterface
    fun forgetPairing(instanceId: String) {
        activity.runOnUiThread { activity.forgetPairing(instanceId) }
    }

    fun statusJson(
        error: String? = null,
        notice: String? = null,
    ): String {
        val result = JSONObject()
        try {
            val policy = vault.protectionPolicy()
            val biometricAvailability = activity.biometricAvailability()
            result.put("protectionPolicy", policy.storageValue)
            result.put("biometricRequired", policy == PairingProtectionPolicy.BIOMETRIC)
            result.put(
                "biometricAvailable",
                biometricAvailability == BiometricAvailability.AVAILABLE,
            )
            result.put("biometricStatus", biometricAvailability.wireValue)
            result.put(
                "biometricStatusMessage",
                biometricAvailability.userMessage ?: JSONObject.NULL,
            )
            result.put("remoteConnected", activity.remoteConnected())
            result.put("remoteConnecting", activity.remoteConnecting())
            result.put(
                "remoteExpiresAt",
                activity.remoteSessionExpiresAt() ?: JSONObject.NULL,
            )
            val pairings = vault.loadMetadata()
            appendPairingState(result, pairings, activity.selectedCloudInstanceId())
        } catch (_: Exception) {
            result.put("paired", false)
            result.put("error", "저장된 페어링 정보를 읽지 못했습니다.")
        }
        if (error != null) result.put("error", error)
        if (notice != null) result.put("notice", notice)
        return result.toString()
    }
}

internal fun appendPairingState(
    result: JSONObject,
    pairings: List<PairingMetadata>,
    selectedInstanceId: String?,
) {
    val selected = pairings.firstOrNull { it.instanceId == selectedInstanceId }
    result.put("selectedInstanceId", selectedInstanceId ?: JSONObject.NULL)
    result.put("pairingCount", pairings.size)
    result.put("pairings", JSONArray().apply {
        pairings.forEach { metadata ->
            put(
                JSONObject()
                    .put("endpoint", metadata.endpoint)
                    .put("instanceId", metadata.instanceId)
                    .put("expiresAt", metadata.expiresAtEpochSeconds)
                    .put("confirmedAt", metadata.confirmedAtEpochSeconds ?: JSONObject.NULL)
                    .put("label", metadata.label ?: JSONObject.NULL),
            )
        }
    })
    result.put("paired", selected != null)
    result.put("confirmed", selected?.confirmedAtEpochSeconds != null)
    result.put(
        "confirmationPending",
        selected != null && selected.confirmedAtEpochSeconds == null,
    )
    if (selected != null) {
        result.put("endpoint", selected.endpoint)
        result.put("instanceId", selected.instanceId)
        result.put("expiresAt", selected.expiresAtEpochSeconds)
        result.put("confirmedAt", selected.confirmedAtEpochSeconds ?: JSONObject.NULL)
        result.put("label", selected.label ?: JSONObject.NULL)
    }
}
