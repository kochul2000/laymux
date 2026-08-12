package com.laymux.android

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.fragment.app.FragmentActivity
import androidx.webkit.WebViewAssetLoader
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.laymux.android.pairing.BiometricAvailability
import com.laymux.android.pairing.BiometricGate
import com.laymux.android.pairing.PairingAckClient
import com.laymux.android.pairing.PairingAckException
import com.laymux.android.pairing.PairingAckSession
import com.laymux.android.pairing.PairingHandshake
import com.laymux.android.pairing.PairingKeyInvalidatedException
import com.laymux.android.pairing.PairingPayload
import com.laymux.android.pairing.PairingProtectionPolicy
import com.laymux.android.pairing.PairingVault
import com.laymux.android.pairing.PendingPairingDecryption
import com.laymux.android.web.LocalContentWebViewClient
import com.laymux.android.web.NativeBridge
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import javax.crypto.Cipher
import org.json.JSONObject

class MainActivity : FragmentActivity() {
    private lateinit var webView: WebView
    private lateinit var vault: PairingVault
    private lateinit var bridge: NativeBridge
    private lateinit var scanner: GmsBarcodeScanner
    private lateinit var biometricGate: BiometricGate
    private val pairingAckClient = PairingAckClient()
    private val pairingExecutor = Executors.newSingleThreadExecutor()
    private var scanInFlight = false
    private var pairingAckInFlight = false
    private var activePairingAckSession: PairingAckSession? = null
    private var pendingPairing: PairingPayload? = null
    private var pendingClientNonce: String? = null
    private var pendingDecryption: PendingPairingDecryption? = null
    private var pendingDecryptionPurpose: DecryptionPurpose? = null
    private var policyDialog: AlertDialog? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        vault = PairingVault(this)
        biometricGate = BiometricGate(this)
        bridge = NativeBridge(this, vault)
        scanner = GmsBarcodeScanning.getClient(
            this,
            GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build(),
        )
        webView = createWebView()
        setContentView(webView)
        webView.loadUrl(LocalContentWebViewClient.START_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler(
                LocalContentWebViewClient.ASSET_PATH,
                WebViewAssetLoader.AssetsPathHandler(this),
            )
            .build()
        return WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = false
            settings.databaseEnabled = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.setGeolocationEnabled(false)
            settings.mediaPlaybackRequiresUserGesture = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            webViewClient = LocalContentWebViewClient(assetLoader)
            addJavascriptInterface(bridge, NATIVE_BRIDGE_NAME)
        }
    }

    fun biometricAvailability(): BiometricAvailability = biometricGate.availability()

    fun startPairingScan() {
        if (scanInFlight || hasPendingCryptoOperation()) return
        val policy = try {
            vault.protectionPolicy()
        } catch (_: Exception) {
            notifyPairingChanged(error = "키 보호 설정을 읽지 못했습니다.")
            return
        }
        if (policy == PairingProtectionPolicy.BIOMETRIC) {
            val availability = biometricAvailability()
            if (availability != BiometricAvailability.AVAILABLE) {
                notifyPairingChanged(error = requireNotNull(availability.userMessage))
                return
            }
        }

        scanInFlight = true
        scanner.startScan()
            .addOnSuccessListener { barcode ->
                scanInFlight = false
                val raw = barcode.rawValue
                if (raw == null) {
                    notifyPairingChanged(error = "QR에서 페어링 정보를 읽지 못했습니다.")
                    return@addOnSuccessListener
                }
                try {
                    val debugBuild = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
                    saveScannedPairing(
                        PairingPayload.parse(raw, allowLoopbackHttp = debugBuild),
                        policy,
                    )
                } catch (error: IllegalArgumentException) {
                    notifyPairingChanged(
                        error = error.message ?: "지원하지 않는 페어링 QR입니다.",
                    )
                } catch (error: Exception) {
                    notifyPairingChanged(error = pairingOperationError(error))
                }
            }
            .addOnCanceledListener {
                scanInFlight = false
                notifyPairingChanged(error = "QR 스캔을 취소했습니다.")
            }
            .addOnFailureListener {
                scanInFlight = false
                notifyPairingChanged(error = "QR 스캐너를 시작하지 못했습니다.")
            }
    }

    private fun saveScannedPairing(
        payload: PairingPayload,
        policy: PairingProtectionPolicy,
    ) {
        val cipher = try {
            vault.prepareEncryption(policy)
        } catch (error: Exception) {
            payload.close()
            throw error
        }
        val clientNonce = try {
            PairingHandshake.newClientNonce()
        } catch (error: Exception) {
            payload.close()
            throw error
        }
        if (policy == PairingProtectionPolicy.KEYSTORE_ONLY) {
            payload.use { persistAndConfirm(it, clientNonce, policy, cipher) }
            return
        }

        pendingPairing = payload
        pendingClientNonce = clientNonce
        try {
            biometricGate.authenticate(
                cipher = cipher,
                title = "페어링 키 저장",
                subtitle = "Laymux 키를 생체 인증으로 보호합니다.",
                onSuccess = ::completeBiometricPairing,
                onError = { message ->
                    pendingPairing?.close()
                    pendingPairing = null
                    pendingClientNonce = null
                    notifyPairingChanged(error = message)
                },
            )
        } catch (error: Exception) {
            pendingPairing?.close()
            pendingPairing = null
            pendingClientNonce = null
            throw error
        }
    }

    private fun completeBiometricPairing(authorizedCipher: Cipher) {
        val payload = pendingPairing ?: return
        val clientNonce = pendingClientNonce ?: run {
            payload.close()
            pendingPairing = null
            return
        }
        pendingPairing = null
        pendingClientNonce = null
        try {
            payload.use {
                persistAndConfirm(
                    it,
                    clientNonce,
                    PairingProtectionPolicy.BIOMETRIC,
                    authorizedCipher,
                )
            }
        } catch (error: Exception) {
            notifyPairingChanged(error = pairingOperationError(error))
        }
    }

    private fun persistAndConfirm(
        payload: PairingPayload,
        clientNonce: String,
        policy: PairingProtectionPolicy,
        cipher: Cipher,
    ) {
        val session = PairingHandshake.createSession(payload, clientNonce)
        try {
            vault.save(payload, clientNonce, policy, cipher)
        } catch (error: Exception) {
            session.close()
            throw error
        }
        startPairingAck(session)
    }

    private fun startPairingAck(session: PairingAckSession) {
        val pairingId = session.request.pairingId
        val clientNonce = session.request.clientNonce
        if (session.isExpired()) {
            session.close()
            try {
                vault.clearIfMatches(pairingId, clientNonce)
            } catch (_: Exception) {
                notifyPairingChanged(error = "만료된 페어링 정보를 삭제하지 못했습니다.")
                return
            }
            notifyPairingChanged(error = "페어링 QR이 만료됐습니다. 새 QR을 스캔하세요.")
            return
        }
        if (pairingAckInFlight) {
            session.close()
            notifyPairingChanged(error = "이미 데스크톱 확인을 진행하고 있습니다.")
            return
        }
        pairingAckInFlight = true
        activePairingAckSession = session
        notifyPairingChanged(notice = "키를 안전하게 저장했습니다. 데스크톱에 확인 중입니다.")
        try {
            pairingExecutor.execute {
                val result = runCatching {
                    session.use { pairingAckClient.confirm(it) }
                }
                runOnUiThread {
                    pairingAckInFlight = false
                    if (activePairingAckSession === session) {
                        activePairingAckSession = null
                    }
                    if (isDestroyed) return@runOnUiThread
                    result.fold(
                        onSuccess = { confirmation ->
                            try {
                                vault.markConfirmed(
                                    pairingId,
                                    clientNonce,
                                    confirmation.confirmedAtEpochSeconds,
                                )
                                notifyPairingChanged(notice = "데스크톱과 페어링을 확인했습니다.")
                            } catch (_: Exception) {
                                notifyPairingChanged(error = "페어링 확인 상태를 저장하지 못했습니다.")
                            }
                        },
                        onFailure = { error ->
                            handlePairingAckFailure(error, pairingId, clientNonce)
                        },
                    )
                }
            }
        } catch (_: RejectedExecutionException) {
            session.close()
            activePairingAckSession = null
            pairingAckInFlight = false
            notifyPairingChanged(error = "페어링 확인 작업을 시작하지 못했습니다.")
        }
    }

    private fun handlePairingAckFailure(
        error: Throwable,
        pairingId: String,
        clientNonce: String,
    ) {
        val ackError = error as? PairingAckException
        if (ackError?.pairingInvalidated == true) {
            try {
                vault.clearIfMatches(pairingId, clientNonce)
            } catch (_: Exception) {
                notifyPairingChanged(error = "무효한 페어링 정보를 삭제하지 못했습니다.")
                return
            }
        }
        notifyPairingChanged(
            error = ackError?.message ?: "데스크톱 페어링 확인에 실패했습니다.",
        )
    }

    fun setBiometricRequired(required: Boolean) {
        if (scanInFlight || hasPendingCryptoOperation() || policyDialog != null) {
            notifyPairingChanged(error = "진행 중인 작업이 끝난 뒤 키 보호 설정을 바꾸세요.")
            return
        }
        val policy = if (required) {
            PairingProtectionPolicy.BIOMETRIC
        } else {
            PairingProtectionPolicy.KEYSTORE_ONLY
        }
        val currentPolicy = try {
            vault.protectionPolicy()
        } catch (_: Exception) {
            notifyPairingChanged(error = "키 보호 설정을 읽지 못했습니다.")
            return
        }
        if (currentPolicy == policy) {
            notifyPairingChanged()
            return
        }
        val hasPairing = try {
            vault.loadMetadata() != null
        } catch (_: Exception) {
            notifyPairingChanged(error = "저장된 페어링 정보를 읽지 못했습니다.")
            return
        }
        if (!required || hasPairing) {
            showPolicyConfirmation(policy, hasPairing)
        } else {
            applyProtectionPolicy(policy, hadPairing = false)
        }
    }

    private fun showPolicyConfirmation(
        policy: PairingProtectionPolicy,
        hasPairing: Boolean,
    ) {
        val disablingBiometric = policy == PairingProtectionPolicy.KEYSTORE_ONLY
        val message = buildString {
            if (disablingBiometric) {
                append("생체 인증을 끄면 키 사용 시 본인 확인을 요구하지 않습니다. ")
                append("앱 전용 Android Keystore 보호만 유지됩니다.")
            } else {
                append("앞으로 페어링 키를 저장하거나 사용할 때마다 강한 생체 인증을 요구합니다.")
            }
            if (hasPairing) {
                append("\n\n보호 방식을 바꾸면 현재 페어링이 삭제되므로 다시 QR로 페어링해야 합니다.")
            }
        }
        policyDialog = AlertDialog.Builder(this)
            .setTitle(if (disablingBiometric) "생체 인증을 끌까요?" else "생체 인증을 켤까요?")
            .setMessage(message)
            .setPositiveButton(if (disablingBiometric) "끄기" else "켜기") { _, _ ->
                policyDialog = null
                applyProtectionPolicy(policy, hadPairing = hasPairing)
            }
            .setNegativeButton("취소") { _, _ ->
                policyDialog = null
                notifyPairingChanged()
            }
            .setOnCancelListener {
                policyDialog = null
                notifyPairingChanged()
            }
            .show()
    }

    private fun applyProtectionPolicy(
        policy: PairingProtectionPolicy,
        hadPairing: Boolean,
    ) {
        try {
            vault.setProtectionPolicy(policy)
            notifyPairingChanged(
                notice = if (hadPairing) {
                    "키 보호 설정을 변경하고 기존 페어링을 삭제했습니다. 다시 페어링하세요."
                } else {
                    "키 보호 설정을 변경했습니다."
                },
            )
        } catch (_: Exception) {
            notifyPairingChanged(error = "키 보호 설정을 변경하지 못했습니다.")
        }
    }

    fun verifyPairingProtection() {
        if (scanInFlight || hasPendingCryptoOperation()) return
        val policy = try {
            vault.protectionPolicy()
        } catch (_: Exception) {
            notifyPairingChanged(error = "키 보호 설정을 읽지 못했습니다.")
            return
        }
        if (policy == PairingProtectionPolicy.BIOMETRIC) {
            val availability = biometricAvailability()
            if (availability != BiometricAvailability.AVAILABLE) {
                notifyPairingChanged(error = requireNotNull(availability.userMessage))
                return
            }
        }
        val pending = try {
            vault.prepareDecryption()
        } catch (error: Exception) {
            notifyPairingChanged(error = pairingOperationError(error))
            return
        }
        if (pending == null) {
            notifyPairingChanged(error = "먼저 페어링하세요.")
            return
        }
        if (pending.policy == PairingProtectionPolicy.KEYSTORE_ONLY) {
            completeVerification(pending, pending.cipher)
            return
        }

        pendingDecryption = pending
        pendingDecryptionPurpose = DecryptionPurpose.VERIFY
        try {
            biometricGate.authenticate(
                cipher = pending.cipher,
                title = "페어링 키 확인",
                subtitle = "저장된 Laymux 키의 보호 상태를 확인합니다.",
                onSuccess = { cipher ->
                    val current = pendingDecryption
                    val purpose = pendingDecryptionPurpose
                    pendingDecryption = null
                    pendingDecryptionPurpose = null
                    if (current != null && purpose == DecryptionPurpose.VERIFY) {
                        completeVerification(current, cipher)
                    }
                },
                onError = { message ->
                    pendingDecryption?.close()
                    pendingDecryption = null
                    pendingDecryptionPurpose = null
                    notifyPairingChanged(error = message)
                },
            )
        } catch (error: Exception) {
            pendingDecryption?.close()
            pendingDecryption = null
            pendingDecryptionPurpose = null
            notifyPairingChanged(error = pairingOperationError(error))
        }
    }

    fun retryPairingConfirmation() {
        if (scanInFlight || hasPendingCryptoOperation()) return
        val metadata = try {
            vault.loadMetadata()
        } catch (error: Exception) {
            notifyPairingChanged(error = pairingOperationError(error))
            return
        }
        if (metadata == null) {
            notifyPairingChanged(error = "먼저 페어링하세요.")
            return
        }
        if (metadata.confirmedAtEpochSeconds != null) {
            notifyPairingChanged(notice = "이미 데스크톱과 페어링을 확인했습니다.")
            return
        }
        val policy = try {
            vault.protectionPolicy()
        } catch (error: Exception) {
            notifyPairingChanged(error = pairingOperationError(error))
            return
        }
        if (policy == PairingProtectionPolicy.BIOMETRIC) {
            val availability = biometricAvailability()
            if (availability != BiometricAvailability.AVAILABLE) {
                notifyPairingChanged(error = requireNotNull(availability.userMessage))
                return
            }
        }
        val pending = try {
            vault.prepareDecryption()
        } catch (error: Exception) {
            notifyPairingChanged(error = pairingOperationError(error))
            return
        } ?: run {
            notifyPairingChanged(error = "먼저 페어링하세요.")
            return
        }
        if (pending.policy == PairingProtectionPolicy.KEYSTORE_ONLY) {
            completePairingConfirmation(pending, pending.cipher)
            return
        }

        pendingDecryption = pending
        pendingDecryptionPurpose = DecryptionPurpose.CONFIRM
        try {
            biometricGate.authenticate(
                cipher = pending.cipher,
                title = "데스크톱 페어링 확인",
                subtitle = "저장된 Laymux 키로 데스크톱을 확인합니다.",
                onSuccess = { cipher ->
                    val current = pendingDecryption
                    val purpose = pendingDecryptionPurpose
                    pendingDecryption = null
                    pendingDecryptionPurpose = null
                    if (current != null && purpose == DecryptionPurpose.CONFIRM) {
                        completePairingConfirmation(current, cipher)
                    }
                },
                onError = { message ->
                    pendingDecryption?.close()
                    pendingDecryption = null
                    pendingDecryptionPurpose = null
                    notifyPairingChanged(error = message)
                },
            )
        } catch (error: Exception) {
            pendingDecryption?.close()
            pendingDecryption = null
            pendingDecryptionPurpose = null
            notifyPairingChanged(error = pairingOperationError(error))
        }
    }

    private fun completePairingConfirmation(
        pending: PendingPairingDecryption,
        authorizedCipher: Cipher,
    ) {
        try {
            val session = vault.completeDecryption(pending, authorizedCipher).use { stored ->
                PairingHandshake.createSession(stored)
            }
            startPairingAck(session)
        } catch (error: Exception) {
            pending.close()
            notifyPairingChanged(error = pairingOperationError(error))
        }
    }

    private fun completeVerification(
        pending: PendingPairingDecryption,
        authorizedCipher: Cipher,
    ) {
        try {
            vault.completeDecryption(pending, authorizedCipher).use {
                // Verification intentionally consumes and wipes the secret without exposing it.
            }
            notifyPairingChanged(notice = "페어링 키 보호를 확인했습니다.")
        } catch (error: Exception) {
            pending.close()
            notifyPairingChanged(error = pairingOperationError(error))
        }
    }

    fun forgetPairing() {
        if (scanInFlight || hasPendingCryptoOperation()) {
            notifyPairingChanged(error = "진행 중인 작업이 끝난 뒤 페어링을 해제하세요.")
            return
        }
        try {
            vault.clear()
            notifyPairingChanged(notice = "페어링을 해제했습니다.")
        } catch (_: Exception) {
            notifyPairingChanged(error = "페어링 정보를 삭제하지 못했습니다.")
        }
    }

    private fun hasPendingCryptoOperation(): Boolean =
        pendingPairing != null || pendingDecryption != null || pairingAckInFlight

    private fun pairingOperationError(error: Exception): String = when (error) {
        is PairingKeyInvalidatedException ->
            "생체 정보가 변경되어 페어링 키가 무효화됐습니다. 페어링을 해제한 뒤 다시 연결하세요."
        else -> "페어링 키를 안전하게 처리하지 못했습니다."
    }

    fun notifyPairingChanged(
        error: String? = null,
        notice: String? = null,
    ) {
        runOnUiThread {
            if (!::webView.isInitialized) return@runOnUiThread
            val status = JSONObject.quote(bridge.statusJson(error, notice))
            webView.evaluateJavascript(
                "if (window.laymuxNative) window.laymuxNative.onPairingChanged($status);",
                null,
            )
        }
    }

    override fun onDestroy() {
        policyDialog?.dismiss()
        policyDialog = null
        if (::biometricGate.isInitialized) biometricGate.cancel()
        pendingPairing?.close()
        pendingPairing = null
        pendingClientNonce = null
        pendingDecryption?.close()
        pendingDecryption = null
        pendingDecryptionPurpose = null
        activePairingAckSession?.close()
        activePairingAckSession = null
        pairingExecutor.shutdownNow()
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface(NATIVE_BRIDGE_NAME)
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val NATIVE_BRIDGE_NAME = "LaymuxNative"
    }

    private enum class DecryptionPurpose {
        VERIFY,
        CONFIRM,
    }
}
