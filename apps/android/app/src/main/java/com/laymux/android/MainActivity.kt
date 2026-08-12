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
import com.laymux.android.remote.E2eProtocolException
import com.laymux.android.remote.E2eRemoteClient
import com.laymux.android.remote.E2eSessionSuspendedException
import com.laymux.android.remote.E2eTransportException
import com.laymux.android.remote.RemoteSession
import com.laymux.android.web.LocalContentWebViewClient
import com.laymux.android.web.NativeBridge
import com.laymux.android.web.RemoteOutputBridge
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Cipher
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : FragmentActivity() {
    private lateinit var webView: WebView
    private lateinit var vault: PairingVault
    private lateinit var bridge: NativeBridge
    private lateinit var scanner: GmsBarcodeScanner
    private lateinit var biometricGate: BiometricGate
    private val pairingAckClient = PairingAckClient()
    private val e2eRemoteClient = E2eRemoteClient()
    private val pairingExecutor = Executors.newSingleThreadExecutor()
    private val remoteExecutor = Executors.newSingleThreadScheduledExecutor()
    private var scanInFlight = false
    private var pairingAckInFlight = false
    private var activePairingAckSession: PairingAckSession? = null
    private var pendingPairing: PairingPayload? = null
    private var pendingClientNonce: String? = null
    private var pendingDecryption: PendingPairingDecryption? = null
    private var pendingDecryptionPurpose: DecryptionPurpose? = null
    private var policyDialog: AlertDialog? = null
    @Volatile private var remoteSession: RemoteSession? = null
    @Volatile private var remoteOpeningSession: RemoteSession? = null
    @Volatile private var remoteConnecting = false
    @Volatile private var remoteLeaseId: String? = null
    @Volatile private var remoteTerminalId: String? = null
    @Volatile private var remoteTerminalTitle: String? = null
    @Volatile private var remoteGeneration: Long? = null
    @Volatile private var remoteSourceSeq: Long? = null
    private var remotePoll: ScheduledFuture<*>? = null
    private var remoteHeartbeat: ScheduledFuture<*>? = null
    private var remoteBackgroundExpiry: ScheduledFuture<*>? = null
    private val remoteConnectionGeneration = AtomicLong()
    @Volatile private var remoteLifecycleActive = false

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

    fun remoteConnected(): Boolean = remoteSession?.isExpired() == false

    fun remoteConnecting(): Boolean = remoteConnecting

    fun remoteSessionExpiresAt(): Long? = remoteSession?.expiresAtEpochSeconds

    fun remoteTerminalTitle(): String? = remoteTerminalTitle

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

    fun connectRemote() {
        if (scanInFlight || hasPendingCryptoOperation() || remoteOpeningSession != null) {
            return
        }
        remoteSession?.let { session ->
            if (!session.isExpired()) return
            closeRemoteSession()
        }
        val metadata = try {
            vault.loadMetadata()
        } catch (error: Exception) {
            notifyPairingChanged(error = pairingOperationError(error))
            return
        }
        if (metadata?.confirmedAtEpochSeconds == null) {
            notifyPairingChanged(error = "먼저 데스크톱과 페어링을 확인하세요.")
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
        val connectionGeneration = remoteConnectionGeneration.incrementAndGet()
        remoteConnecting = true
        notifyPairingChanged(notice = "보안 세션을 준비하고 있습니다.")
        if (pending.policy == PairingProtectionPolicy.KEYSTORE_ONLY) {
            completeRemoteConnection(pending, pending.cipher, connectionGeneration)
            return
        }

        pendingDecryption = pending
        pendingDecryptionPurpose = DecryptionPurpose.CONNECT
        try {
            biometricGate.authenticate(
                cipher = pending.cipher,
                title = "Laymux 보안 세션 열기",
                subtitle = "사용 중에는 유지되며 15분 비활성 시 잠깁니다.",
                onSuccess = { cipher ->
                    val current = pendingDecryption
                    val purpose = pendingDecryptionPurpose
                    pendingDecryption = null
                    pendingDecryptionPurpose = null
                    if (current != null && purpose == DecryptionPurpose.CONNECT) {
                        completeRemoteConnection(current, cipher, connectionGeneration)
                    }
                },
                onError = { message ->
                    pendingDecryption?.close()
                    pendingDecryption = null
                    pendingDecryptionPurpose = null
                    if (remoteConnectionGeneration.get() == connectionGeneration) {
                        remoteConnecting = false
                        notifyPairingChanged(error = message)
                    }
                },
            )
        } catch (error: Exception) {
            pending.close()
            pendingDecryption = null
            pendingDecryptionPurpose = null
            if (remoteConnectionGeneration.get() == connectionGeneration) {
                remoteConnecting = false
                notifyPairingChanged(error = pairingOperationError(error))
            }
        }
    }

    private fun completeRemoteConnection(
        pending: PendingPairingDecryption,
        authorizedCipher: Cipher,
        connectionGeneration: Long,
    ) {
        if (remoteConnectionGeneration.get() != connectionGeneration || !remoteLifecycleActive) {
            pending.close()
            return
        }
        val stored = try {
            vault.completeDecryption(pending, authorizedCipher)
        } catch (error: Exception) {
            pending.close()
            remoteConnecting = false
            notifyPairingChanged(error = pairingOperationError(error))
            return
        }
        try {
            remoteExecutor.execute {
                val result = runCatching {
                    stored.use { material ->
                        if (remoteConnectionGeneration.get() != connectionGeneration ||
                            !remoteLifecycleActive
                        ) {
                            throw RemoteConnectionCancelledException()
                        }
                        val session = e2eRemoteClient.open(material)
                        remoteOpeningSession = session
                        try {
                            if (remoteConnectionGeneration.get() != connectionGeneration ||
                                !remoteLifecycleActive
                            ) {
                                throw RemoteConnectionCancelledException()
                            }
                            RemoteConnection(session, bootstrapRemoteSession(session))
                        } catch (error: Throwable) {
                            if (remoteOpeningSession === session) remoteOpeningSession = null
                            session.close()
                            throw error
                        }
                    }
                }
                runOnUiThread {
                    val stale = remoteConnectionGeneration.get() != connectionGeneration ||
                        !remoteLifecycleActive || isDestroyed
                    if (stale) {
                        result.getOrNull()?.session?.let { session ->
                            if (remoteOpeningSession === session) remoteOpeningSession = null
                            session.close()
                        }
                        return@runOnUiThread
                    }
                    remoteConnecting = false
                    result.fold(
                        onSuccess = { connection ->
                            val bootstrap = connection.bootstrap
                            if (remoteOpeningSession === connection.session) {
                                remoteOpeningSession = null
                            }
                            remoteSession = connection.session
                            remoteLeaseId = bootstrap.leaseId
                            remoteTerminalId = bootstrap.terminalId
                            remoteTerminalTitle = bootstrap.terminalTitle
                            remoteGeneration = bootstrap.generation
                            remoteSourceSeq = bootstrap.sourceSeq
                            emitRemoteOutput(
                                bootstrap.output.optString("data"),
                                reset = true,
                                bootstrap.output,
                            )
                            startRemotePolling()
                            notifyPairingChanged(notice = "터미널이 종단 암호화로 연결됐습니다.")
                        },
                        onFailure = { error ->
                            closeRemoteSession()
                            if (error !is RemoteConnectionCancelledException) {
                                notifyPairingChanged(error = remoteErrorMessage(error))
                            }
                        },
                    )
                }
            }
        } catch (_: RejectedExecutionException) {
            stored.close()
            remoteConnecting = false
            notifyPairingChanged(error = "보안 연결 작업을 시작하지 못했습니다.")
        }
    }

    private fun bootstrapRemoteSession(session: RemoteSession): RemoteBootstrap {
        return bootstrapRemoteSessionWithLease(session, claimRemoteLease(session))
    }

    private fun claimRemoteLease(session: RemoteSession): String {
        val claim = remoteHttp(
            session,
            "POST",
            "/remote/v1/session/claim",
            JSONObject().put("clientName", "Laymux Android E2E"),
        )
        val leaseId = claim.getJSONObject("body").optString("leaseId")
        if (leaseId.isEmpty()) throw E2eProtocolException("원격 제어 lease를 받지 못했습니다.")
        return leaseId
    }

    private fun bootstrapRemoteSessionWithLease(
        session: RemoteSession,
        leaseId: String,
    ): RemoteBootstrap {
        val terminals = remoteHttp(
            session,
            "GET",
            "/remote/v1/terminals",
            null,
        ).getJSONObject("body").optJSONArray("terminals") ?: JSONArray()
        if (terminals.length() == 0) {
            throw E2eProtocolException("연결할 수 있는 터미널이 없습니다.")
        }
        val terminal = terminals.getJSONObject(0)
        val terminalId = terminal.getString("id")
        val terminalTitle = terminal.optString("title").takeIf(String::isNotEmpty) ?: terminalId
        remoteHttp(
            session,
            "POST",
            "/remote/v1/terminals/$terminalId/focus",
            JSONObject().put("leaseId", leaseId),
        )
        val output = fetchRemoteOutput(session, terminalId, leaseId)
        return RemoteBootstrap(
            leaseId = leaseId,
            terminalId = terminalId,
            terminalTitle = terminalTitle,
            generation = output.getLong("generation"),
            sourceSeq = output.getLong("sourceSeq"),
            output = output,
        )
    }

    private fun remoteHttp(
        session: RemoteSession,
        method: String,
        path: String,
        body: JSONObject?,
    ): JSONObject {
        val response = e2eRemoteClient.rpc(
            session,
            JSONObject()
                .put("kind", "http")
                .put("method", method)
                .put("path", path)
                .put("body", body ?: JSONObject.NULL),
        )
        if (response.optString("kind") != "http") {
            throw E2eProtocolException("원격 HTTP 응답이 올바르지 않습니다.")
        }
        val status = response.optInt("status", 500)
        if (status !in 200..299) {
            throw RemoteOperationException(
                status,
                response.optJSONObject("body")?.optString("error")
                    ?: response.optString("error", "원격 요청이 거부됐습니다."),
            )
        }
        return response
    }

    private fun fetchRemoteOutput(
        session: RemoteSession,
        terminalId: String,
        leaseId: String,
    ): JSONObject {
        val response = e2eRemoteClient.rpc(
            session,
            JSONObject()
                .put("kind", "terminalOutputOpen")
                .put("terminalId", terminalId)
                .put("leaseId", leaseId),
        )
        requireTerminalOutput(response)
        return response
    }

    private fun startRemotePolling() {
        if (!remoteLifecycleActive) return
        remoteBackgroundExpiry?.cancel(false)
        remoteBackgroundExpiry = null
        remotePoll?.cancel(false)
        remotePoll = remoteExecutor.scheduleWithFixedDelay(
            ::pollRemoteOutput,
            REMOTE_POLL_INTERVAL_MS,
            REMOTE_POLL_INTERVAL_MS,
            TimeUnit.MILLISECONDS,
        )
        remoteHeartbeat?.cancel(false)
        remoteHeartbeat = remoteExecutor.scheduleWithFixedDelay(
            ::heartbeatRemoteSession,
            REMOTE_HEARTBEAT_INTERVAL_SECONDS,
            REMOTE_HEARTBEAT_INTERVAL_SECONDS,
            TimeUnit.SECONDS,
        )
    }

    private fun cancelRemoteTraffic() {
        remotePoll?.cancel(false)
        remotePoll = null
        remoteHeartbeat?.cancel(false)
        remoteHeartbeat = null
    }

    private fun suspendRemoteSessionForBackground() {
        remoteConnectionGeneration.incrementAndGet()
        cancelRemoteTraffic()
        remoteBackgroundExpiry?.cancel(false)
        remoteBackgroundExpiry = null
        remoteOpeningSession?.close()
        remoteOpeningSession = null
        remoteConnecting = false
        val session = remoteSession ?: return
        session.suspendForBackground()
        scheduleBackgroundSessionExpiry(session)
    }

    private fun scheduleBackgroundSessionExpiry(session: RemoteSession) {
        if (remoteLifecycleActive || remoteSession !== session) return
        val delaySeconds = session.inactivitySecondsRemaining()
        if (delaySeconds == 0L) {
            closeRemoteSession()
            return
        }
        try {
            remoteBackgroundExpiry = remoteExecutor.schedule(
                {
                    if (remoteLifecycleActive || remoteSession !== session) return@schedule
                    if (session.isExpired()) {
                        closeRemoteSession()
                    } else {
                        scheduleBackgroundSessionExpiry(session)
                    }
                },
                delaySeconds,
                TimeUnit.SECONDS,
            )
        } catch (_: RejectedExecutionException) {
            if (remoteSession === session) closeRemoteSession()
        }
    }

    private fun resumeRemoteSessionAfterBackground() {
        val session = remoteSession ?: return
        remoteBackgroundExpiry?.cancel(false)
        remoteBackgroundExpiry = null
        if (!session.resumeFromBackground()) {
            closeRemoteSession()
            notifyPairingChanged(notice = "15분 동안 사용하지 않아 보안 세션이 잠겼습니다.")
            return
        }
        val connectionGeneration = remoteConnectionGeneration.incrementAndGet()
        remoteConnecting = true
        try {
            remoteExecutor.execute {
                val result = runCatching {
                    e2eRemoteClient.resumePending(session)
                    ensureRemoteResumeCurrent(session, connectionGeneration)
                    resumeRemoteBootstrap(session, connectionGeneration)
                }
                runOnUiThread {
                    val stale = remoteConnectionGeneration.get() != connectionGeneration ||
                        !remoteLifecycleActive || remoteSession !== session || isDestroyed
                    if (stale) return@runOnUiThread
                    remoteConnecting = false
                    result.fold(
                        onSuccess = { bootstrap ->
                            remoteLeaseId = bootstrap.leaseId
                            remoteTerminalId = bootstrap.terminalId
                            remoteTerminalTitle = bootstrap.terminalTitle
                            remoteGeneration = bootstrap.generation
                            remoteSourceSeq = bootstrap.sourceSeq
                            emitRemoteOutput(
                                bootstrap.output.optString("data"),
                                reset = true,
                                bootstrap.output,
                            )
                            startRemotePolling()
                            notifyPairingChanged(notice = "보안 세션을 다시 연결했습니다.")
                        },
                        onFailure = { error ->
                            closeRemoteSession()
                            if (error !is RemoteConnectionCancelledException &&
                                error !is E2eSessionSuspendedException
                            ) {
                                notifyPairingChanged(error = remoteErrorMessage(error))
                            }
                        },
                    )
                }
            }
        } catch (_: RejectedExecutionException) {
            closeRemoteSession()
            notifyPairingChanged(error = "보안 세션을 다시 연결하지 못했습니다.")
        }
    }

    private fun ensureRemoteResumeCurrent(
        session: RemoteSession,
        connectionGeneration: Long,
    ) {
        if (remoteConnectionGeneration.get() != connectionGeneration ||
            !remoteLifecycleActive || remoteSession !== session
        ) {
            throw RemoteConnectionCancelledException()
        }
    }

    private fun resumeRemoteBootstrap(
        session: RemoteSession,
        connectionGeneration: Long,
    ): RemoteBootstrap {
        val leaseId = remoteLeaseId
        val terminalId = remoteTerminalId
        val terminalTitle = remoteTerminalTitle ?: terminalId
        if (leaseId != null && terminalId != null && terminalTitle != null) {
            try {
                remoteHttp(
                    session,
                    "POST",
                    "/remote/v1/session/heartbeat",
                    JSONObject().put("leaseId", leaseId),
                )
                ensureRemoteResumeCurrent(session, connectionGeneration)
                val output = fetchRemoteOutput(session, terminalId, leaseId)
                return RemoteBootstrap(
                    leaseId,
                    terminalId,
                    terminalTitle,
                    output.getLong("generation"),
                    output.getLong("sourceSeq"),
                    output,
                )
            } catch (error: RemoteOperationException) {
                if (error.status != 409) throw error
                try {
                    remoteHttp(
                        session,
                        "POST",
                        "/remote/v1/session/release",
                        JSONObject().put("leaseId", leaseId),
                    )
                } catch (releaseError: RemoteOperationException) {
                    if (releaseError.status != 409) throw releaseError
                }
            }
        }

        val resumeDeadline = session.expiresAtEpochSeconds
        var claimedLeaseId: String? = null
        while (claimedLeaseId == null) {
            ensureRemoteResumeCurrent(session, connectionGeneration)
            try {
                claimedLeaseId = claimRemoteLease(session)
            } catch (error: RemoteOperationException) {
                val now = System.currentTimeMillis() / 1_000
                if (error.status != 409 || now >= resumeDeadline) throw error
                try {
                    Thread.sleep(REMOTE_RESUME_RETRY_DELAY_MS)
                } catch (interrupted: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw RemoteConnectionCancelledException()
                }
            }
        }
        ensureRemoteResumeCurrent(session, connectionGeneration)
        return bootstrapRemoteSessionWithLease(session, claimedLeaseId)
    }

    private fun heartbeatRemoteSession() {
        val session = remoteSession ?: return
        val leaseId = remoteLeaseId ?: return
        try {
            remoteHttp(
                session,
                "POST",
                "/remote/v1/session/heartbeat",
                JSONObject().put("leaseId", leaseId),
            )
        } catch (error: Throwable) {
            handleRemoteFailure(error, session)
        }
    }

    private fun pollRemoteOutput() {
        val session = remoteSession ?: return
        val terminalId = remoteTerminalId ?: return
        val leaseId = remoteLeaseId ?: return
        val generation = remoteGeneration ?: return
        val sourceSeq = remoteSourceSeq ?: return
        try {
            val response = e2eRemoteClient.rpc(
                session,
                JSONObject()
                    .put("kind", "terminalOutputPoll")
                    .put("terminalId", terminalId)
                    .put("leaseId", leaseId)
                    .put("generation", generation)
                    .put("sourceSeq", sourceSeq),
            )
            requireTerminalOutput(response)
            if (remoteSession !== session) return
            when (response.optString("phase")) {
                "delta", "idle" -> {
                    remoteGeneration = response.getLong("generation")
                    remoteSourceSeq = response.getLong("sourceSeq")
                    if (response.optString("phase") == "delta") {
                        emitRemoteOutput(response.optString("data"), reset = false, response)
                    }
                }
                "reattach" -> {
                    val snapshot = fetchRemoteOutput(session, terminalId, leaseId)
                    if (remoteSession !== session) return
                    remoteGeneration = snapshot.getLong("generation")
                    remoteSourceSeq = snapshot.getLong("sourceSeq")
                    emitRemoteOutput(snapshot.optString("data"), reset = true, snapshot)
                }
                else -> throw E2eProtocolException("터미널 출력 응답이 올바르지 않습니다.")
            }
        } catch (error: Throwable) {
            handleRemoteFailure(error, session)
        }
    }

    fun sendRemoteInput(data: String) {
        if (data.isEmpty() || data.toByteArray().size > MAX_REMOTE_INPUT_BYTES) return
        executeRemoteAction { session, terminalId, leaseId ->
            remoteHttp(
                session,
                "POST",
                "/remote/v1/terminals/$terminalId/write",
                JSONObject().put("data", data).put("leaseId", leaseId),
            )
        }
    }

    fun resizeRemoteTerminal(cols: Int, rows: Int) {
        if (cols !in 1..1_000 || rows !in 1..1_000) return
        executeRemoteAction { session, terminalId, leaseId ->
            remoteHttp(
                session,
                "POST",
                "/remote/v1/terminals/$terminalId/resize",
                JSONObject()
                    .put("cols", cols)
                    .put("rows", rows)
                    .put("leaseId", leaseId)
                    .put("exact", false),
            )
        }
    }

    private fun executeRemoteAction(
        action: (RemoteSession, String, String) -> Unit,
    ) {
        val session = remoteSession ?: return
        val terminalId = remoteTerminalId ?: return
        val leaseId = remoteLeaseId ?: return
        try {
            remoteExecutor.execute {
                try {
                    action(session, terminalId, leaseId)
                } catch (error: Throwable) {
                    handleRemoteFailure(error, session)
                }
            }
        } catch (_: RejectedExecutionException) {
            notifyPairingChanged(error = "원격 작업을 시작하지 못했습니다.")
        }
    }

    fun disconnectRemote() {
        closeRemoteSession()
        notifyPairingChanged(notice = "보안 세션을 닫았습니다.")
    }

    private fun closeRemoteSession() {
        remoteConnectionGeneration.incrementAndGet()
        cancelRemoteTraffic()
        remoteBackgroundExpiry?.cancel(false)
        remoteBackgroundExpiry = null
        remoteOpeningSession?.close()
        remoteOpeningSession = null
        remoteSession?.close()
        remoteSession = null
        remoteLeaseId = null
        remoteTerminalId = null
        remoteTerminalTitle = null
        remoteGeneration = null
        remoteSourceSeq = null
        remoteConnecting = false
    }

    private fun handleRemoteFailure(error: Throwable, failedSession: RemoteSession) {
        if (remoteSession !== failedSession) return
        if (!remoteLifecycleActive &&
            (error is E2eSessionSuspendedException || error is RemoteOperationException)
        ) {
            return
        }
        closeRemoteSession()
        notifyPairingChanged(error = remoteErrorMessage(error))
    }

    private fun remoteErrorMessage(error: Throwable): String = when (error) {
        is E2eProtocolException -> error.message ?: "보안 세션이 거부됐습니다."
        is E2eTransportException -> error.message ?: "보안 연결에 실패했습니다."
        is RemoteOperationException -> error.message ?: "원격 작업이 거부됐습니다."
        else -> "종단 암호화 원격 연결에 실패했습니다."
    }

    private fun requireTerminalOutput(response: JSONObject) {
        if (response.optString("kind") == "error") {
            throw RemoteOperationException(
                response.optInt("status", 500),
                response.optString("error", "터미널 출력이 거부됐습니다."),
            )
        }
        if (response.optString("kind") != "terminalOutput") {
            throw E2eProtocolException("터미널 출력 응답이 올바르지 않습니다.")
        }
    }

    private fun emitRemoteOutput(data: String, reset: Boolean, response: JSONObject) {
        val geometry = response.optJSONObject("geometry")
        val cols = geometry?.optInt("cols", 80) ?: 80
        val rows = geometry?.optInt("rows", 24) ?: 24
        val modes = response.optJSONObject("modes")
        val bracketedPaste = modes
            ?.takeIf { it.has("bracketedPaste") && !it.isNull("bracketedPaste") }
            ?.getBoolean("bracketedPaste")
        runOnUiThread {
            if (!::webView.isInitialized || isDestroyed) return@runOnUiThread
            webView.evaluateJavascript(
                RemoteOutputBridge.script(data, reset, cols, rows, bracketedPaste),
                null,
            )
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
            closeRemoteSession()
            vault.clear()
            notifyPairingChanged(notice = "페어링을 해제했습니다.")
        } catch (_: Exception) {
            notifyPairingChanged(error = "페어링 정보를 삭제하지 못했습니다.")
        }
    }

    private fun hasPendingCryptoOperation(): Boolean =
        pendingPairing != null || pendingDecryption != null || pairingAckInFlight || remoteConnecting

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

    override fun onStart() {
        super.onStart()
        remoteLifecycleActive = true
        resumeRemoteSessionAfterBackground()
        if (::webView.isInitialized) notifyPairingChanged()
    }

    override fun onStop() {
        remoteLifecycleActive = false
        suspendRemoteSessionForBackground()
        if (pendingDecryptionPurpose == DecryptionPurpose.CONNECT) {
            biometricGate.cancel()
            pendingDecryption?.close()
            pendingDecryption = null
            pendingDecryptionPurpose = null
        }
        super.onStop()
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
        closeRemoteSession()
        remoteExecutor.shutdownNow()
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
        private const val REMOTE_POLL_INTERVAL_MS = 120L
        private const val REMOTE_HEARTBEAT_INTERVAL_SECONDS = 10L
        private const val REMOTE_RESUME_RETRY_DELAY_MS = 1_000L
        private const val MAX_REMOTE_INPUT_BYTES = 64 * 1024
    }

    private enum class DecryptionPurpose {
        VERIFY,
        CONFIRM,
        CONNECT,
    }

    private data class RemoteBootstrap(
        val leaseId: String,
        val terminalId: String,
        val terminalTitle: String,
        val generation: Long,
        val sourceSeq: Long,
        val output: JSONObject,
    )

    private data class RemoteConnection(
        val session: RemoteSession,
        val bootstrap: RemoteBootstrap,
    )

    private class RemoteOperationException(
        val status: Int,
        message: String,
    ) : Exception(message)

    private class RemoteConnectionCancelledException : Exception()
}
