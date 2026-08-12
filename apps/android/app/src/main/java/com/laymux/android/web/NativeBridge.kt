package com.laymux.android.web

import android.webkit.JavascriptInterface
import com.laymux.android.MainActivity
import com.laymux.android.pairing.BiometricAvailability
import com.laymux.android.pairing.PairingProtectionPolicy
import com.laymux.android.pairing.PairingVault
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
    fun verifyPairingProtection() {
        activity.runOnUiThread(activity::verifyPairingProtection)
    }

    @JavascriptInterface
    fun retryPairingConfirmation() {
        activity.runOnUiThread(activity::retryPairingConfirmation)
    }

    @JavascriptInterface
    fun forgetPairing() {
        activity.runOnUiThread(activity::forgetPairing)
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

            val stored = vault.loadMetadata()
            result.put("paired", stored != null)
            result.put("confirmed", stored?.confirmedAtEpochSeconds != null)
            result.put(
                "confirmationPending",
                stored != null && stored.confirmedAtEpochSeconds == null,
            )
            if (stored != null) {
                result.put("endpoint", stored.endpoint)
                result.put("instanceId", stored.instanceId)
                result.put("expiresAt", stored.expiresAtEpochSeconds)
                result.put(
                    "confirmedAt",
                    stored.confirmedAtEpochSeconds ?: JSONObject.NULL,
                )
                result.put("label", stored.label ?: JSONObject.NULL)
            }
        } catch (_: Exception) {
            result.put("paired", false)
            result.put("error", "저장된 페어링 정보를 읽지 못했습니다.")
        }
        if (error != null) result.put("error", error)
        if (notice != null) result.put("notice", notice)
        return result.toString()
    }
}
