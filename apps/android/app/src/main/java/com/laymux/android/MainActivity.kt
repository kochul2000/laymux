package com.laymux.android

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.credentials.CustomCredential
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.gms.tasks.Task
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
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
import com.laymux.android.pairing.ResumeGatedRunner
import com.laymux.android.remote.E2eProtocolException
import com.laymux.android.remote.E2eOutputSocket
import com.laymux.android.remote.E2eOutputSocketCallbacks
import com.laymux.android.remote.E2eRemoteClient
import com.laymux.android.remote.E2eSessionSuspendedException
import com.laymux.android.remote.E2eTransportException
import com.laymux.android.remote.RemoteSession
import com.laymux.android.web.LocalContentWebViewClient
import com.laymux.android.web.NativeBridge
import com.laymux.android.web.RemoteBridge
import com.laymux.android.web.RemoteResourceResponse
import com.laymux.android.web.VisibleWebSurface
import com.laymux.android.web.WebSurfaceLayerPolicy
import com.laymux.android.web.stringWebMessagePayload
import com.laymux.android.web.CloudBridge
import com.laymux.android.web.CloudBridgeInput
import com.laymux.android.web.CloudAuthClient
import com.laymux.android.web.CloudAuthException
import com.laymux.android.web.CloudCookieInstaller
import com.laymux.android.web.CloudNavigationPolicy
import com.laymux.android.web.CloudWebViewClient
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicLong
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import javax.crypto.Cipher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import okhttp3.OkHttpClient

class MainActivity : FragmentActivity(), E2eOutputSocketCallbacks {
    private lateinit var webView: WebView
    private lateinit var cloudWebView: WebView
    private lateinit var vault: PairingVault
    private lateinit var bridge: NativeBridge
    private lateinit var remoteBridge: RemoteBridge
    private lateinit var cloudBridge: CloudBridge
    private lateinit var cloudNavigation: CloudNavigationPolicy
    private lateinit var credentialManager: CredentialManager
    private val cloudAuthClient = CloudAuthClient()
    private lateinit var scanner: GmsBarcodeScanner
    private lateinit var biometricGate: BiometricGate
    private val pairingAckClient = PairingAckClient()
    private val e2eRemoteClient = E2eRemoteClient()
    private val outputHttpClient = OkHttpClient()
    private val pairingExecutor = Executors.newSingleThreadExecutor()
    private val remoteExecutor = Executors.newSingleThreadScheduledExecutor()
    private val biometricPromptGate = ResumeGatedRunner()
    private var scanTask: Task<Barcode>? = null
    private var scanInFlight = false
    private var pairingAckInFlight = false
    private var activePairingAckSession: PairingAckSession? = null
    private var pendingPairing: PairingPayload? = null
    private var pendingClientNonce: String? = null
    private var pendingDecryption: PendingPairingDecryption? = null
    private var pendingDecryptionPurpose: DecryptionPurpose? = null
    private var policyDialog: AlertDialog? = null
    private var selectedCloudInstanceId: String? = null
    private var localWebSurface = LocalWebSurface.PAIRING
    private var visibleWebSurface = VisibleWebSurface.CLOUD
    private var googleSignInInFlight = false
    @Volatile private var remoteSession: RemoteSession? = null
    @Volatile private var remoteOpeningSession: RemoteSession? = null
    @Volatile private var remoteConnecting = false
    @Volatile private var remoteLeaseId: String? = null
    private var remoteBackgroundExpiry: ScheduledFuture<*>? = null
    private val remoteOutputStreams = ConcurrentHashMap<String, E2eOutputSocket>()
    private val remoteOutputReplies = ConcurrentHashMap<String, JavaScriptReplyProxy>()
    private val remoteConnectionGeneration = AtomicLong()
    @Volatile private var remoteLifecycleActive = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        vault = PairingVault(this)
        biometricGate = BiometricGate(this)
        bridge = NativeBridge(this, vault)
        remoteBridge = RemoteBridge(this)
        cloudBridge = CloudBridge(this)
        cloudNavigation = CloudNavigationPolicy(getString(R.string.laymux_cloud_base_url))
        credentialManager = CredentialManager.create(this)
        scanner = GmsBarcodeScanning.getClient(
            this,
            GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build(),
        )
        webView = createWebView()
        cloudWebView = createCloudWebView()
        val root = FrameLayout(this).apply {
            addView(
                cloudWebView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
            addView(
                webView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        setContentView(root)
        applySystemBarInsets(root)
        applyWebSurfaceLayers(VisibleWebSurface.CLOUD)
        webView.loadUrl(LocalContentWebViewClient.START_URL)
        cloudWebView.loadUrl(cloudNavigation.startUrl)
    }

    /**
     * targetSdk 36 draws every window edge to edge, so without this the PC-owned
     * Remote page renders under the status bar and its top menu cannot be tapped.
     * The WebViews own their own scrolling, so the system bars become padding on
     * the container instead of insets the pages would have to know about.
     */
    private fun applySystemBarInsets(root: View) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, windowInsets ->
            val bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            // Edge-to-edge windows no longer resize for the soft keyboard, so the
            // IME would cover the Remote composer unless it becomes padding too.
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(
                bars.left,
                bars.top,
                bars.right,
                maxOf(bars.bottom, ime.bottom),
            )
            // Consumed so the pages inside do not apply the same cutout again
            // through their own `env(safe-area-inset-*)` rules.
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(root)
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
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.setGeolocationEnabled(false)
            settings.mediaPlaybackRequiresUserGesture = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            webViewClient = LocalContentWebViewClient(assetLoader, ::loadRemoteResource)
            addJavascriptInterface(bridge, NATIVE_BRIDGE_NAME)
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
            ) {
                WebViewCompat.addWebMessageListener(
                    this,
                    REMOTE_OUTPUT_BRIDGE_NAME,
                    setOf(REMOTE_WRAPPER_ORIGIN),
                ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
                    if (isMainFrame && sourceOrigin == Uri.parse(REMOTE_WRAPPER_ORIGIN)) {
                        stringWebMessagePayload(
                            message.type,
                            WebMessageCompat.TYPE_STRING,
                        ) { message.data }?.let { handleRemoteOutputMessage(it, replyProxy) }
                    }
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createCloudWebView(): WebView = WebView(this).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = false
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(false)
        settings.setGeolocationEnabled(false)
        settings.mediaPlaybackRequiresUserGesture = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        webViewClient = CloudWebViewClient(cloudNavigation)
        addJavascriptInterface(cloudBridge, CLOUD_BRIDGE_NAME)
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
    }

    fun signInWithGoogle(nonce: String) {
        if (!cloudBridgeActionsEnabled()) return
        if (googleSignInInFlight) return
        val clientId = getString(R.string.laymux_google_web_client_id)
        if (clientId.isBlank()) {
            showCloudMessage("Google 로그인이 아직 이 빌드에 설정되지 않았습니다.")
            return
        }
        googleSignInInFlight = true
        lifecycleScope.launch {
            try {
                val googleOption = GetSignInWithGoogleOption.Builder(clientId)
                    .setNonce(nonce)
                    .build()
                val request = GetCredentialRequest.Builder()
                    .addCredentialOption(googleOption)
                    .build()
                val result = credentialManager.getCredential(this@MainActivity, request)
                val credential = result.credential
                if (credential !is CustomCredential ||
                    credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
                ) {
                    showCloudMessage("Google 로그인 응답을 확인할 수 없습니다.")
                    return@launch
                }
                val googleCredential = GoogleIdTokenCredential.createFrom(credential.data)
                val cookieManager = CookieManager.getInstance()
                val cookieHeader = cookieManager.getCookie(cloudNavigation.originUrl)
                    ?: throw CloudAuthException("Cloud login challenge is unavailable")
                val authResult = withContext(Dispatchers.IO) {
                    cloudAuthClient.authenticate(
                        cloudNavigation.googleAuthUrl,
                        cookieHeader,
                        googleCredential.idToken,
                    )
                }
                CloudCookieInstaller.install(
                    cloudNavigation.originUrl,
                    authResult.setCookies,
                ) { url, cookie, onComplete ->
                    cookieManager.setCookie(url, cookie, onComplete)
                }
                withContext(Dispatchers.IO) { cookieManager.flush() }
                cloudWebView.loadUrl(cloudNavigation.dashboardUrl)
            } catch (_: GetCredentialCancellationException) {
                showCloudMessage("Google 로그인이 취소되었습니다.")
            } catch (_: GetCredentialException) {
                showCloudMessage("Google 로그인을 완료하지 못했습니다.")
            } catch (_: Exception) {
                showCloudMessage("Google 로그인 응답을 처리하지 못했습니다.")
            } finally {
                googleSignInInFlight = false
            }
        }
    }

    fun selectCloudInstance(instanceId: String) {
        if (!cloudBridgeActionsEnabled()) return
        if (selectedCloudInstanceId != instanceId) closeRemoteSession()
        selectedCloudInstanceId = instanceId
        showPairingSurface()
        val metadata = try {
            vault.loadConfirmedMetadata(instanceId)
        } catch (error: Exception) {
            notifyPairingChanged(error = pairingOperationError(error))
            return
        }
        when {
            metadata != null -> connectRemote()
            else -> {
                notifyPairingChanged(notice = "선택한 PC에 표시된 E2E QR을 스캔하세요.")
                startPairingScan()
            }
        }
    }

    fun showCloudDashboard() {
        closeRemoteSession()
        selectedCloudInstanceId = null
        if (!::cloudWebView.isInitialized || isDestroyed) return
        applyWebSurfaceLayers(VisibleWebSurface.CLOUD)
        cloudWebView.loadUrl(cloudNavigation.dashboardUrl)
    }

    private fun showPairingSurface() {
        if (!::webView.isInitialized || isDestroyed) return
        installLocalBridge(LocalWebSurface.PAIRING)
        applyWebSurfaceLayers(VisibleWebSurface.PAIRING)
        webView.loadUrl(LocalContentWebViewClient.START_URL)
    }

    private fun showRemoteSurface() {
        if (!::webView.isInitialized || isDestroyed) return
        installLocalBridge(LocalWebSurface.REMOTE)
        applyWebSurfaceLayers(VisibleWebSurface.REMOTE)
        webView.loadUrl(LocalContentWebViewClient.REMOTE_START_URL)
    }

    private fun applyWebSurfaceLayers(surface: VisibleWebSurface) {
        val layers = WebSurfaceLayerPolicy.forSurface(surface)
        visibleWebSurface = surface
        cloudWebView.visibility = if (layers.cloudVisible) View.VISIBLE else View.GONE
        webView.visibility = if (layers.secureVisible) View.VISIBLE else View.GONE
        cloudWebView.isEnabled = layers.cloudInteractive
        cloudWebView.isFocusable = layers.cloudInteractive
        cloudWebView.isFocusableInTouchMode = layers.cloudInteractive
        cloudWebView.importantForAccessibility = if (layers.cloudAccessible) {
            View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        } else {
            View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        if (layers.secureVisible) {
            cloudWebView.clearFocus()
            webView.bringToFront()
            webView.requestFocus()
        }
    }

    private fun cloudBridgeActionsEnabled(): Boolean =
        WebSurfaceLayerPolicy.forSurface(visibleWebSurface).cloudBridgeEnabled

    private fun installLocalBridge(surface: LocalWebSurface) {
        webView.removeJavascriptInterface(NATIVE_BRIDGE_NAME)
        when (surface) {
            LocalWebSurface.PAIRING -> webView.addJavascriptInterface(bridge, NATIVE_BRIDGE_NAME)
            LocalWebSurface.REMOTE -> webView.addJavascriptInterface(remoteBridge, NATIVE_BRIDGE_NAME)
        }
        localWebSurface = surface
    }

    private fun showCloudMessage(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    fun biometricAvailability(): BiometricAvailability = biometricGate.availability()

    fun remoteConnected(): Boolean = remoteSession?.isExpired() == false

    fun remoteConnecting(): Boolean = remoteConnecting

    fun remoteSessionExpiresAt(): Long? = remoteSession?.expiresAtEpochSeconds

    fun setRemoteLease(leaseId: String?) {
        remoteLeaseId = leaseId?.takeIf { it.isNotBlank() }
    }


    fun selectedCloudInstanceId(): String? = selectedCloudInstanceId

    fun startPairingScan() {
        if (scanInFlight || hasPendingCryptoOperation()) {
            notifyPairingChanged(error = busyOperationMessage())
            return
        }
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
        scanTask = scanner.startScan()
            .addOnSuccessListener { barcode ->
                scanInFlight = false
                // The scanned string carries the pairing seed, so the task that
                // owns the barcode must not outlive this callback.
                scanTask = null
                val raw = barcode.rawValue
                if (raw == null) {
                    notifyPairingChanged(error = "QR에서 페어링 정보를 읽지 못했습니다.")
                    return@addOnSuccessListener
                }
                try {
                    val debugBuild = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
                    val payload = PairingPayload.parse(raw, allowLoopbackHttp = debugBuild)
                    val expectedInstanceId = selectedCloudInstanceId
                    if (!CloudBridgeInput.matchesSelectedInstance(
                            expectedInstanceId,
                            payload.instanceId,
                        )
                    ) {
                        payload.close()
                        notifyPairingChanged(error = "선택한 PC가 아닌 QR입니다. 선택한 PC의 QR을 스캔하세요.")
                        return@addOnSuccessListener
                    }
                    saveScannedPairing(payload, policy)
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
                scanTask = null
                notifyPairingChanged(error = "QR 스캔을 취소했습니다.")
            }
            .addOnFailureListener {
                scanInFlight = false
                scanTask = null
                notifyPairingChanged(error = "QR 스캐너를 시작하지 못했습니다.")
            }
    }

    private fun saveScannedPairing(
        payload: PairingPayload,
        policy: PairingProtectionPolicy,
    ) {
        // The scanner callback outlives this activity: a destroyed instance can
        // never drain a deferred prompt, so its seed would never be wiped.
        if (isDestroyed || isFinishing) {
            payload.close()
            return
        }
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

        if (biometricPromptGate.hasPending) {
            payload.close()
            notifyPairingChanged(error = busyOperationMessage())
            return
        }
        pendingPairing = payload
        pendingClientNonce = clientNonce
        biometricPromptGate.runWhenResumed {
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
                notifyPairingChanged(error = pairingOperationError(error))
            }
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
            if (selectedCloudInstanceId == payload.instanceId) closeRemoteSession()
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
                vault.clearIfMatches(session.request.instanceId, pairingId, clientNonce)
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
                                    session.request.instanceId,
                                    pairingId,
                                    clientNonce,
                                    confirmation.confirmedAtEpochSeconds,
                                )
                                notifyPairingChanged(notice = "데스크톱과 페어링을 확인했습니다.")
                                if (selectedCloudInstanceId == session.request.instanceId) {
                                    connectRemote()
                                }
                            } catch (_: Exception) {
                                notifyPairingChanged(error = "페어링 확인 상태를 저장하지 못했습니다.")
                            }
                        },
                        onFailure = { error ->
                            handlePairingAckFailure(
                                error,
                                session.request.instanceId,
                                pairingId,
                                clientNonce,
                            )
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
        instanceId: String,
        pairingId: String,
        clientNonce: String,
    ) {
        val ackError = error as? PairingAckException
        if (ackError?.pairingInvalidated == true) {
            try {
                vault.clearIfMatches(instanceId, pairingId, clientNonce)
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
            vault.loadMetadata().isNotEmpty()
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
                append("\n\n보호 방식을 바꾸면 저장된 모든 PC 페어링이 삭제됩니다. ")
                append("각 PC를 QR로 다시 페어링해야 합니다.")
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
            if (hadPairing) closeRemoteSession()
            vault.setProtectionPolicy(policy)
            notifyPairingChanged(
                notice = if (hadPairing) {
                    "키 보호 설정을 변경하고 모든 PC 페어링을 삭제했습니다. 다시 페어링하세요."
                } else {
                    "키 보호 설정을 변경했습니다."
                },
            )
        } catch (_: Exception) {
            notifyPairingChanged(error = "키 보호 설정을 변경하지 못했습니다.")
        }
    }

    fun verifyPairingProtection(instanceId: String) {
        if (scanInFlight || hasPendingCryptoOperation()) {
            notifyPairingChanged(error = busyOperationMessage())
            return
        }
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
            vault.prepareDecryption(instanceId)
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

        if (biometricPromptGate.hasPending) {
            pending.close()
            notifyPairingChanged(error = busyOperationMessage())
            return
        }
        pendingDecryption = pending
        pendingDecryptionPurpose = DecryptionPurpose.VERIFY
        biometricPromptGate.runWhenResumed {
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
    }

    fun retryPairingConfirmation(instanceId: String) {
        if (scanInFlight || hasPendingCryptoOperation()) {
            notifyPairingChanged(error = busyOperationMessage())
            return
        }
        val metadata = try {
            vault.loadMetadata().firstOrNull { it.instanceId == instanceId }
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
            vault.prepareDecryption(instanceId)
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

        if (biometricPromptGate.hasPending) {
            pending.close()
            notifyPairingChanged(error = busyOperationMessage())
            return
        }
        pendingDecryption = pending
        pendingDecryptionPurpose = DecryptionPurpose.CONFIRM
        biometricPromptGate.runWhenResumed {
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
    }

    fun connectRemote() {
        if (scanInFlight || hasPendingCryptoOperation() || remoteOpeningSession != null) {
            notifyPairingChanged(error = busyOperationMessage())
            return
        }
        remoteSession?.let { session ->
            if (!session.isExpired()) return
            closeRemoteSession()
        }
        val expectedInstanceId = selectedCloudInstanceId
        if (expectedInstanceId == null) {
            notifyPairingChanged(error = "Cloud 대시보드에서 연결할 PC를 선택하세요.")
            return
        }
        val metadata = try {
            vault.loadMetadata().firstOrNull { it.instanceId == expectedInstanceId }
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
            vault.prepareDecryption(expectedInstanceId)
        } catch (error: Exception) {
            notifyPairingChanged(error = pairingOperationError(error))
            return
        } ?: run {
            notifyPairingChanged(error = "먼저 페어링하세요.")
            return
        }
        // Checked before the generation bumps: rejecting afterwards would strand
        // an earlier CONNECT whose prompt is still up but whose result no longer
        // matches the current generation.
        if (pending.policy != PairingProtectionPolicy.KEYSTORE_ONLY &&
            biometricPromptGate.hasPending
        ) {
            pending.close()
            notifyPairingChanged(error = busyOperationMessage())
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
        biometricPromptGate.runWhenResumed {
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
                        if (remoteConnectionGeneration.get() != connectionGeneration ||
                            !remoteLifecycleActive
                        ) {
                            if (remoteOpeningSession === session) remoteOpeningSession = null
                            session.close()
                            throw RemoteConnectionCancelledException()
                        }
                        session
                    }
                }
                runOnUiThread {
                    val stale = remoteConnectionGeneration.get() != connectionGeneration ||
                        !remoteLifecycleActive || isDestroyed
                    if (stale) {
                        result.getOrNull()?.let { session ->
                            if (remoteOpeningSession === session) remoteOpeningSession = null
                            session.close()
                        }
                        return@runOnUiThread
                    }
                    remoteConnecting = false
                    result.fold(
                        onSuccess = { session ->
                            if (remoteOpeningSession === session) {
                                remoteOpeningSession = null
                            }
                            remoteSession = session
                            showRemoteSurface()
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

    private fun loadRemoteResource(path: String): RemoteResourceResponse? {
        if (path.length > MAX_REMOTE_PATH_LENGTH) return null
        val session = remoteSession ?: return null
        if (!remoteLifecycleActive || session.isExpired()) return null
        val future = try {
            remoteExecutor.submit<RemoteResourceResponse?> {
                if (!remoteLifecycleActive || remoteSession !== session) return@submit null
                val response = e2eRemoteClient.rpc(
                    session,
                    JSONObject().put("kind", "resource").put("path", path),
                )
                if (response.optString("kind") == "error") {
                    val status = response.optInt("status", 500).coerceIn(400, 599)
                    return@submit RemoteResourceResponse.error(
                        status,
                        response.optString("error", "Remote resource failed"),
                    )
                }
                RemoteResourceResponse.parse(response)
            }
        } catch (_: RejectedExecutionException) {
            return null
        }
        return try {
            future.get(REMOTE_RESOURCE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        } catch (error: ExecutionException) {
            handleRemoteFailure(error.cause ?: error, session)
            null
        } catch (error: TimeoutException) {
            future.cancel(true)
            handleRemoteFailure(
                E2eTransportException("Remote UI resource request timed out."),
                session,
            )
            null
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            null
        }
    }

    fun requestRemoteHttp(
        requestId: String,
        method: String,
        path: String,
        bodyJson: String?,
    ) {
        if (!validBridgeId(requestId) || path.length > MAX_REMOTE_PATH_LENGTH ||
            (bodyJson?.length ?: 0) > MAX_REMOTE_HTTP_BODY_CHARS
        ) {
            emitHttpError(requestId, "Invalid Remote request.")
            return
        }
        val body = try {
            bodyJson?.takeIf(String::isNotEmpty)?.let(::JSONObject)
        } catch (_: Exception) {
            emitHttpError(requestId, "Remote request body must be a JSON object.")
            return
        }
        val session = remoteSession
        if (session == null || !remoteLifecycleActive) {
            emitHttpError(requestId, "Secure session is unavailable.")
            return
        }
        try {
            remoteExecutor.execute {
                if (remoteSession !== session || !remoteLifecycleActive) return@execute
                try {
                    val response = e2eRemoteClient.rpc(
                        session,
                        JSONObject()
                            .put("kind", "http")
                            .put("method", method.uppercase())
                            .put("path", path)
                            .put("body", body ?: JSONObject.NULL),
                    )
                    emitHttpResponse(requestId, normalizeHttpResponse(response))
                } catch (_: E2eSessionSuspendedException) {
                    // Foreground resume reloads the authenticated PC-owned page.
                } catch (error: Throwable) {
                    emitHttpError(requestId, remoteErrorMessage(error))
                    handleRemoteFailure(error, session)
                }
            }
        } catch (_: RejectedExecutionException) {
            emitHttpError(requestId, "Secure session is unavailable.")
        }
    }

    private fun normalizeHttpResponse(response: JSONObject): JSONObject {
        if (response.optString("kind") == "http") return response
        if (response.optString("kind") == "error") {
            return JSONObject()
                .put("kind", "http")
                .put("status", response.optInt("status", 500))
                .put(
                    "body",
                    JSONObject().put(
                        "error",
                        response.optString("error", "Remote request failed"),
                    ),
                )
        }
        throw E2eProtocolException("Remote HTTP response is invalid.")
    }

    private fun handleRemoteOutputMessage(raw: String, replyProxy: JavaScriptReplyProxy) {
        val message = try {
            JSONObject(raw)
        } catch (_: Exception) {
            return
        }
        val streamId = message.optString("streamId")
        if (!validBridgeId(streamId)) return
        when (message.optString("type")) {
            "open" -> {
                if (!jsonHasExactKeys(message, setOf("type", "streamId", "terminalId", "leaseId"))) {
                    emitOutputBridgeClose(replyProxy, streamId, "Invalid output request.", true)
                    return
                }
                val terminalId = message.optString("terminalId")
                val leaseId = message.optString("leaseId")
                val session = remoteSession
                if (!validRemoteIdentifier(terminalId) || !validRemoteIdentifier(leaseId) ||
                    session == null || !remoteLifecycleActive
                ) {
                    emitOutputBridgeClose(replyProxy, streamId, "Secure session is unavailable.", true)
                    return
                }
                remoteOutputStreams.remove(streamId)?.disconnect()
                remoteOutputReplies[streamId] = replyProxy
                try {
                    remoteExecutor.execute {
                        try {
                            val socket = E2eOutputSocket(
                                streamId,
                                terminalId,
                                leaseId,
                                session,
                                outputHttpClient,
                                this,
                            )
                            if (!remoteLifecycleActive || remoteSession !== session ||
                                remoteOutputReplies[streamId] !== replyProxy
                            ) {
                                socket.disconnect()
                                return@execute
                            }
                            remoteOutputStreams.put(streamId, socket)?.disconnect()
                            socket.connect()
                        } catch (error: Throwable) {
                            remoteOutputStreams.remove(streamId)
                            if (remoteOutputReplies.remove(streamId, replyProxy)) {
                                emitOutputBridgeClose(
                                    replyProxy,
                                    streamId,
                                    remoteErrorMessage(error),
                                    true,
                                )
                            }
                        }
                    }
                } catch (_: RejectedExecutionException) {
                    remoteOutputReplies.remove(streamId)
                    emitOutputBridgeClose(replyProxy, streamId, "Secure session is unavailable.", true)
                }
            }
            "ack" -> if (jsonHasExactKeys(message, setOf("type", "streamId"))) {
                remoteOutputStreams[streamId]?.acknowledge()
            }
            "close" -> if (jsonHasExactKeys(message, setOf("type", "streamId"))) {
                remoteOutputReplies.remove(streamId)
                remoteOutputStreams.remove(streamId)?.disconnect()
            }
        }
    }

    override fun onOpen(socket: E2eOutputSocket, streamId: String) {
        val reply = remoteOutputReplies[streamId] ?: return
        if (remoteOutputStreams[streamId] !== socket) return
        emitOutputBridgeRecord(reply, streamId, OUTPUT_BRIDGE_OPEN, ByteArray(0))
    }

    override fun onRecord(socket: E2eOutputSocket, streamId: String, plaintext: ByteArray) {
        val reply = remoteOutputReplies[streamId] ?: return
        if (remoteOutputStreams[streamId] !== socket) return
        emitOutputBridgeRecord(reply, streamId, OUTPUT_BRIDGE_MESSAGE, plaintext)
    }

    override fun onClose(
        socket: E2eOutputSocket,
        streamId: String,
        reason: String,
        isError: Boolean,
    ) {
        if (!remoteOutputStreams.remove(streamId, socket)) return
        val reply = remoteOutputReplies.remove(streamId) ?: return
        emitOutputBridgeClose(reply, streamId, reason, isError)
    }

    private fun clearRemoteOutputStreams() {
        remoteOutputReplies.clear()
        remoteOutputStreams.values.toList().forEach(E2eOutputSocket::disconnect)
        remoteOutputStreams.clear()
    }

    private fun suspendRemoteSessionForBackground() {
        remoteConnectionGeneration.incrementAndGet()
        clearRemoteOutputStreams()
        remoteBackgroundExpiry?.cancel(false)
        remoteBackgroundExpiry = null
        remoteOpeningSession?.close()
        remoteOpeningSession = null
        remoteConnecting = false
        val session = remoteSession ?: return
        val leaseId = remoteLeaseId
        if (!leaseId.isNullOrBlank()) {
            try {
                remoteExecutor.execute {
                    if (!remoteLifecycleActive && remoteSession === session) {
                        runCatching { e2eRemoteClient.transitionBackgroundLease(session, leaseId) }
                    }
                    if (!remoteLifecycleActive && remoteSession === session) {
                        session.suspendForBackground()
                        scheduleBackgroundSessionExpiry(session)
                    }
                }
                return
            } catch (_: RejectedExecutionException) {
                // Fall through to immediate local session suspension.
            }
        }
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
            showCloudDashboard()
            showCloudMessage("15분 동안 사용하지 않아 보안 세션이 잠겼습니다.")
            return
        }
        val connectionGeneration = remoteConnectionGeneration.incrementAndGet()
        remoteConnecting = true
        try {
            remoteExecutor.execute {
                val result = runCatching {
                    e2eRemoteClient.resumePending(session)
                    ensureRemoteResumeCurrent(session, connectionGeneration)
                }
                runOnUiThread {
                    val stale = remoteConnectionGeneration.get() != connectionGeneration ||
                        !remoteLifecycleActive || remoteSession !== session || isDestroyed
                    if (stale) return@runOnUiThread
                    remoteConnecting = false
                    result.fold(
                        onSuccess = {
                            showRemoteSurface()
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

    fun disconnectRemote() {
        showCloudDashboard()
    }

    private fun closeRemoteSession() {
        remoteConnectionGeneration.incrementAndGet()
        clearRemoteOutputStreams()
        remoteBackgroundExpiry?.cancel(false)
        remoteBackgroundExpiry = null
        remoteOpeningSession?.close()
        remoteOpeningSession = null
        remoteSession?.close()
        remoteSession = null
        remoteLeaseId = null
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
        runOnUiThread {
            if (::webView.isInitialized && !isDestroyed) showCloudDashboard()
        }
    }

    private fun remoteErrorMessage(error: Throwable): String = when (error) {
        is E2eProtocolException -> error.message ?: "보안 세션이 거부됐습니다."
        is E2eTransportException -> error.message ?: "보안 연결에 실패했습니다."
        is RemoteOperationException -> error.message ?: "원격 작업이 거부됐습니다."
        else -> "종단 암호화 원격 연결에 실패했습니다."
    }

    private fun emitHttpResponse(requestId: String, response: JSONObject) {
        emitWrapperCallback("onHttpResponse", requestId, response.toString())
    }

    private fun emitHttpError(requestId: String, message: String) {
        emitWrapperCallback("onHttpError", requestId, message)
    }

    private fun emitOutputBridgeClose(
        reply: JavaScriptReplyProxy,
        streamId: String,
        reason: String,
        isError: Boolean,
    ) {
        val reasonBytes = reason.toByteArray(StandardCharsets.UTF_8)
        val payload = ByteArray(1 + reasonBytes.size)
        payload[0] = if (isError) 1 else 0
        reasonBytes.copyInto(payload, 1)
        emitOutputBridgeRecord(reply, streamId, OUTPUT_BRIDGE_CLOSE, payload)
    }

    private fun emitOutputBridgeRecord(
        reply: JavaScriptReplyProxy,
        streamId: String,
        event: Byte,
        payload: ByteArray,
    ) {
        val streamBytes = streamId.toByteArray(StandardCharsets.UTF_8)
        if (streamBytes.size > UShort.MAX_VALUE.toInt()) return
        val message = ByteBuffer.allocate(3 + streamBytes.size + payload.size)
            .order(ByteOrder.BIG_ENDIAN)
            .put(event)
            .putShort(streamBytes.size.toShort())
            .put(streamBytes)
            .put(payload)
            .array()
        runOnUiThread {
            if (!::webView.isInitialized || isDestroyed) return@runOnUiThread
            reply.postMessage(message)
        }
    }

    private fun emitWrapperCallback(method: String, vararg arguments: String) {
        val encodedArguments = arguments.joinToString(",") { JSONObject.quote(it) }
        runOnUiThread {
            if (!::webView.isInitialized || isDestroyed) return@runOnUiThread
            webView.evaluateJavascript(
                "window.laymuxAndroidE2e?.$method($encodedArguments);",
                null,
            )
        }
    }

    private fun validBridgeId(value: String): Boolean =
        value.isNotEmpty() && value.length <= MAX_BRIDGE_ID_LENGTH &&
            value.all { it.isLetterOrDigit() || it == '-' || it == '_' }

    private fun validRemoteIdentifier(value: String): Boolean =
        value.isNotEmpty() && value.length <= MAX_REMOTE_IDENTIFIER_LENGTH &&
            value.all { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' }

    private fun jsonHasExactKeys(value: JSONObject, expected: Set<String>): Boolean {
        val actual = mutableSetOf<String>()
        val keys = value.keys()
        while (keys.hasNext()) actual += keys.next()
        return actual == expected
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

    fun forgetPairing(instanceId: String) {
        if (scanInFlight || hasPendingCryptoOperation()) {
            notifyPairingChanged(error = "진행 중인 작업이 끝난 뒤 페어링을 해제하세요.")
            return
        }
        try {
            if (selectedCloudInstanceId == instanceId) closeRemoteSession()
            vault.clear(instanceId)
            notifyPairingChanged(notice = "페어링을 해제했습니다.")
        } catch (_: Exception) {
            notifyPairingChanged(error = "페어링 정보를 삭제하지 못했습니다.")
        }
    }

    private fun hasPendingCryptoOperation(): Boolean =
        pendingPairing != null || pendingDecryption != null || pairingAckInFlight || remoteConnecting

    /**
     * The pairing page clears its error and notice lines the moment a button is
     * tapped, so a guard that returns without a status update leaves a screen
     * with no text and a permanently disabled button. Every guarded entry point
     * says which operation still owns the pairing state instead.
     */
    private fun busyOperationMessage(): String = when {
        scanInFlight -> "QR 스캔이 진행 중입니다."
        pendingPairing != null || pendingDecryption != null ->
            "생체 인증을 마치거나 취소한 뒤 다시 시도하세요."
        pairingAckInFlight -> "데스크톱 페어링 확인을 진행하고 있습니다."
        remoteConnecting || remoteOpeningSession != null -> "보안 세션을 여는 중입니다."
        else -> "이전 작업이 끝난 뒤 다시 시도하세요."
    }

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
            if (!::webView.isInitialized || isDestroyed ||
                localWebSurface != LocalWebSurface.PAIRING
            ) {
                return@runOnUiThread
            }
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
        if (::webView.isInitialized) {
            if (remoteSession == null &&
                webView.url?.startsWith(
                    "https://${LocalContentWebViewClient.REMOTE_WRAPPER_HOST}/",
                ) == true
            ) {
                showCloudDashboard()
            } else {
                notifyPairingChanged()
            }
        }
    }

    override fun onPostResume() {
        super.onPostResume()
        // The scanner runs in its own activity. Its listeners clear `scanTask`,
        // so a completed task still parked here means they never ran and the
        // in-flight flag would block every later scan with no way back.
        if (scanInFlight && scanTask?.isComplete == true) {
            scanInFlight = false
            scanTask = null
        }
        // Drained after the FragmentManager dispatched resume: BiometricPrompt
        // commits a fragment transaction and needs a RESUMED host.
        biometricPromptGate.onResumed()
    }

    override fun onPause() {
        biometricPromptGate.onPaused()
        super.onPause()
    }

    override fun onStop() {
        remoteLifecycleActive = false
        suspendRemoteSessionForBackground()
        // A prompt deferred here would otherwise surface hours later, out of
        // context, still holding the scanned seed. Backgrounding cancels it and
        // `onStart` re-renders the real state when the user comes back.
        if (biometricPromptGate.cancelPending()) {
            pendingPairing?.close()
            pendingPairing = null
            pendingClientNonce = null
            pendingDecryption?.close()
            pendingDecryption = null
            pendingDecryptionPurpose = null
        }
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
        biometricPromptGate.cancelPending()
        scanTask = null
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
        if (::cloudWebView.isInitialized) {
            cloudWebView.removeJavascriptInterface(CLOUD_BRIDGE_NAME)
            cloudWebView.stopLoading()
            cloudWebView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val NATIVE_BRIDGE_NAME = "LaymuxNative"
        private const val CLOUD_BRIDGE_NAME = "LaymuxCloud"
        private const val REMOTE_OUTPUT_BRIDGE_NAME = "LaymuxOutputTransport"
        private const val REMOTE_WRAPPER_ORIGIN = "https://remote.laymux.invalid"
        private const val OUTPUT_BRIDGE_OPEN: Byte = 1
        private const val OUTPUT_BRIDGE_MESSAGE: Byte = 2
        private const val OUTPUT_BRIDGE_CLOSE: Byte = 3
        private const val REMOTE_RESOURCE_TIMEOUT_SECONDS = 20L
        private const val MAX_REMOTE_PATH_LENGTH = 2_048
        private const val MAX_REMOTE_HTTP_BODY_CHARS = 256 * 1024
        private const val MAX_REMOTE_IDENTIFIER_LENGTH = 128
        private const val MAX_BRIDGE_ID_LENGTH = 64
    }

    private enum class DecryptionPurpose {
        VERIFY,
        CONFIRM,
        CONNECT,
    }

    private enum class LocalWebSurface {
        PAIRING,
        REMOTE,
    }

    private class RemoteOperationException(
        val status: Int,
        message: String,
    ) : Exception(message)

    private class RemoteConnectionCancelledException : Exception()
}
