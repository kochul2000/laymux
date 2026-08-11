package com.laymux.android.pairing

enum class PairingProtectionPolicy(val storageValue: String) {
    BIOMETRIC("biometric"),
    KEYSTORE_ONLY("keystoreOnly"),
    ;

    companion object {
        fun fromStorage(value: String?): PairingProtectionPolicy = when (value) {
            null -> BIOMETRIC
            BIOMETRIC.storageValue -> BIOMETRIC
            KEYSTORE_ONLY.storageValue -> KEYSTORE_ONLY
            else -> throw IllegalArgumentException("지원하지 않는 키 보호 정책입니다")
        }
    }
}
