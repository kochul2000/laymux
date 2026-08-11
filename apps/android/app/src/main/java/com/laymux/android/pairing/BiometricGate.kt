package com.laymux.android.pairing

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import javax.crypto.Cipher

enum class BiometricAvailability(
    val wireValue: String,
    val userMessage: String?,
) {
    AVAILABLE("available", null),
    NOT_ENROLLED(
        "notEnrolled",
        "강한 생체 정보가 등록되어 있지 않습니다. Android 설정에서 등록한 뒤 다시 시도하세요.",
    ),
    NO_HARDWARE("noHardware", "이 기기는 강한 생체 인증을 지원하지 않습니다."),
    UNAVAILABLE("unavailable", "강한 생체 인증을 현재 사용할 수 없습니다."),
}

/** Owns the AndroidX biometric prompt and never falls back to device credentials. */
class BiometricGate(private val activity: FragmentActivity) {
    private var activePrompt: BiometricPrompt? = null

    fun availability(): BiometricAvailability = when (
        BiometricManager.from(activity).canAuthenticate(AUTHENTICATORS)
    ) {
        BiometricManager.BIOMETRIC_SUCCESS -> BiometricAvailability.AVAILABLE
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> BiometricAvailability.NOT_ENROLLED
        BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> BiometricAvailability.NO_HARDWARE
        else -> BiometricAvailability.UNAVAILABLE
    }

    fun authenticate(
        cipher: Cipher,
        title: String,
        subtitle: String,
        onSuccess: (Cipher) -> Unit,
        onError: (String) -> Unit,
    ) {
        check(activePrompt == null) { "이미 생체 인증이 진행 중입니다" }
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(
                    result: BiometricPrompt.AuthenticationResult,
                ) {
                    activePrompt = null
                    val authorizedCipher = result.cryptoObject?.cipher
                    if (authorizedCipher == null) {
                        onError("생체 인증 결과에서 암호 연산을 확인하지 못했습니다.")
                        return
                    }
                    onSuccess(authorizedCipher)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    activePrompt = null
                    val message = when (errorCode) {
                        BiometricPrompt.ERROR_CANCELED,
                        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                        BiometricPrompt.ERROR_USER_CANCELED,
                        -> "생체 인증이 취소되었습니다."
                        else -> "생체 인증을 완료하지 못했습니다."
                    }
                    onError(message)
                }
            },
        )
        activePrompt = prompt
        try {
            prompt.authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setAllowedAuthenticators(AUTHENTICATORS)
                    .setNegativeButtonText("취소")
                    .build(),
                BiometricPrompt.CryptoObject(cipher),
            )
        } catch (error: Exception) {
            activePrompt = null
            throw error
        }
    }

    fun cancel() {
        activePrompt?.cancelAuthentication()
        activePrompt = null
    }

    companion object {
        private const val AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG
    }
}
