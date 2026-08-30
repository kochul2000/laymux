package com.laymux.android

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ContentResolver
import android.content.ContentValues
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.provider.MediaStore
import android.util.Base64
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.credentials.CustomCredential
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.gms.common.moduleinstall.InstallStatusListener
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallClient
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate
import com.google.android.gms.tasks.Task
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.mlkit.common.MlKitException
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.laymux.android.pairing.BiometricAvailability
import com.laymux.android.pairing.BiometricGate
import com.laymux.android.pairing.ConnectionSettingsActions
import com.laymux.android.pairing.ConnectionSettingsDialog
import com.laymux.android.pairing.ConnectionSettingsState
import com.laymux.android.pairing.PairingAckClient
import com.laymux.android.pairing.PairingAckException
import com.laymux.android.pairing.PairingAckSession
import com.laymux.android.pairing.PairingHandshake
import com.laymux.android.pairing.PairingKeyInvalidatedException
import com.laymux.android.pairing.PairingPayload
import com.laymux.android.pairing.PairingProtectionPolicy
import com.laymux.android.pairing.PairingBottomSheet
import com.laymux.android.pairing.PairingSheetActions
import com.laymux.android.pairing.PairingSheetItem
import com.laymux.android.pairing.PairingSheetState
import com.laymux.android.pairing.PairingVault
import com.laymux.android.pairing.PendingPairingDecryption
import com.laymux.android.pairing.ResumeGatedRunner
import com.laymux.android.pairing.pairingScannerFailureMessage
import com.laymux.android.remote.E2eProtocolException
import com.laymux.android.remote.E2eOutputSocket
import com.laymux.android.remote.E2eOutputSocketCallbacks
import com.laymux.android.remote.E2eOutputStreamReservations
import com.laymux.android.remote.E2eRemoteClient
import com.laymux.android.remote.E2eSessionSuspendedException
import com.laymux.android.remote.E2eTransport
import com.laymux.android.remote.E2eTransportException
import com.laymux.android.remote.E2eTransportFailureKind
import com.laymux.android.remote.E2eTransportKind
import com.laymux.android.remote.E2eTransportPolicy
import com.laymux.android.remote.OauthLoopbackRelay
import com.laymux.android.remote.RemoteHttpRequestRegistry
import com.laymux.android.remote.RemoteHttpResumeTracker
import com.laymux.android.remote.RemoteSession
import com.laymux.android.remote.remoteHttpBodyWithinLimit
import com.laymux.android.update.AppUpdateController
import com.laymux.android.update.AvailableUpdate
import com.laymux.android.update.SharedPreferencesUpdateStore
import com.laymux.android.update.UpdateBannerActions
import com.laymux.android.update.UpdateBannerView
import com.laymux.android.update.UpdateChannel
import com.laymux.android.update.UpdateSchedule
import com.laymux.android.update.UpdateState
import com.laymux.android.update.UpdateSurface
import com.laymux.android.web.JsDialogChromeClient
import com.laymux.android.web.LocalContentWebViewClient
import com.laymux.android.web.RemoteBackGuard
import com.laymux.android.web.RemoteBridge
import com.laymux.android.web.RemoteDocumentAuthority
import com.laymux.android.web.RemoteDownloadPolicy
import com.laymux.android.web.RemoteLoadProgress
import com.laymux.android.web.RemoteOutputOpen
import com.laymux.android.web.RemoteResourceCache
import com.laymux.android.web.RemoteResourceLoadResult
import com.laymux.android.web.RemoteResourceResponse
import com.laymux.android.web.RemoteSurfaceResumeAction
import com.laymux.android.web.RemoteSurfaceResumePolicy
import com.laymux.android.web.SinglePendingResult
import com.laymux.android.web.VisibleWebSurface
import com.laymux.android.web.WebSurfaceLayers
import com.laymux.android.web.WebSurfaceLayerPolicy
import com.laymux.android.web.scheduleRemoteInputFocus
import com.laymux.android.web.stringWebMessagePayload
import com.laymux.android.web.CloudBridge
import com.laymux.android.web.CloudBridgeInput
import com.laymux.android.web.CloudAuthClient
import com.laymux.android.web.CloudAuthException
import com.laymux.android.web.CloudCookieInstaller
import com.laymux.android.web.CloudDocumentLoadState
import com.laymux.android.web.CloudDocumentPresentation
import com.laymux.android.web.CloudLoadOverlayView
import com.laymux.android.web.CloudNavigationPolicy
import com.laymux.android.web.CloudWebViewClient
import com.laymux.android.web.ExternalUrlPolicy
import com.laymux.android.web.beginCloudDocumentNavigation
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicLong
import java.io.IOException
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
    private data class RemoteOutputBridgeEntry(
        val token: Long,
        val generation: Long,
        val reply: JavaScriptReplyProxy,
    )

    private data class PendingOauthCallback(
        val documentGeneration: Long,
        val pathAndQuery: String,
    )

    private lateinit var webView: WebView
    private lateinit var cloudWebView: WebView
    private lateinit var root: FrameLayout
    private lateinit var vault: PairingVault
    private lateinit var pairingSheet: PairingBottomSheet
    private lateinit var connectionSettingsDialog: ConnectionSettingsDialog
    private lateinit var updateController: AppUpdateController
    private lateinit var updateBanner: UpdateBannerView
    private lateinit var cloudBridge: CloudBridge
    private lateinit var cloudNavigation: CloudNavigationPolicy
    private lateinit var credentialManager: CredentialManager
    private val cloudAuthClient = CloudAuthClient()
    private lateinit var scanner: GmsBarcodeScanner
    private lateinit var scannerModuleInstaller: ModuleInstallClient
    private lateinit var biometricGate: BiometricGate
    private val pairingAckClient = PairingAckClient()
    private val e2eRemoteClient = E2eRemoteClient()
    private val outputHttpClient = OkHttpClient()
    private val pairingExecutor = Executors.newSingleThreadExecutor()
    private val remoteExecutor = Executors.newSingleThreadScheduledExecutor()
    private val biometricPromptGate = ResumeGatedRunner()
    private var scanTask: Task<Barcode>? = null
    private var scanInFlight = false
    private var scannerModuleListener: InstallStatusListener? = null
    private var pairingAckInFlight = false
    private var activePairingAckSession: PairingAckSession? = null
    private var pendingPairing: PairingPayload? = null
    private var pendingClientNonce: String? = null
    private var pendingDecryption: PendingPairingDecryption? = null
    private var pendingDecryptionPurpose: DecryptionPurpose? = null
    private var policyDialog: AlertDialog? = null
    private var remoteJsDialogs: JsDialogChromeClient? = null
    private var cloudJsDialogs: JsDialogChromeClient? = null
    private val pendingFileChooser = SinglePendingResult<Array<Uri>>()
    private var selectedCloudInstanceId: String? = null
    private var selectedTailscaleUrl: String? = null
    private var connectionSettingsInstanceId: String? = null
    @Volatile private var cloudFallbackActive = false
    @Volatile private var visibleWebSurface = VisibleWebSurface.CLOUD
    private var debugPairingPreviewActive = false
    private var debugConnectionSettingsPreviewActive = false
    private var googleSignInInFlight = false
    @Volatile private var remoteSession: RemoteSession? = null
    @Volatile private var remoteOpeningSession: RemoteSession? = null
    @Volatile private var remoteConnecting = false
    @Volatile private var remoteLeaseId: String? = null
    private var oauthRelay: OauthLoopbackRelay? = null
    private var oauthRelayDocumentGeneration: Long? = null
    private var pendingOauthCallback: PendingOauthCallback? = null
    private var remoteBackgroundExpiry: ScheduledFuture<*>? = null
    private val remoteOutputStreams = ConcurrentHashMap<String, E2eOutputSocket>()
    private val remoteOutputEntries = ConcurrentHashMap<String, RemoteOutputBridgeEntry>()
    private val remoteOutputReservations = E2eOutputStreamReservations()
    private val remoteHttpRequests = RemoteHttpRequestRegistry()
    private val remoteHttpResumeTracker = RemoteHttpResumeTracker()
    private val remoteResourceCache = RemoteResourceCache()
    private val remoteBackGuard = RemoteBackGuard()
    private var remoteBackEvaluationGeneration: Long? = null
    private var remoteLoadProgress = RemoteLoadProgress()
    private lateinit var remoteLoadingOverlay: LinearLayout
    private lateinit var remoteLoadingStatus: TextView
    private lateinit var cloudLoadOverlay: CloudLoadOverlayView
    private val cloudDocumentLoadState = CloudDocumentLoadState()
    private var cloudDocumentPresentation = CloudDocumentPresentation.LOADING
    private var cloudWebViewGeneration = 0L
    private val remoteConnectionGeneration = AtomicLong()
    private val remoteDocumentAuthority = RemoteDocumentAuthority()
    private var secureWebViewGeneration = 0L
    @Volatile private var remoteLifecycleActive = false

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        pendingFileChooser.complete(
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data),
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        vault = PairingVault(this)
        biometricGate = BiometricGate(this)
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
        scannerModuleInstaller = ModuleInstall.getClient(this)
        pairingSheet = PairingBottomSheet(
            this,
            object : PairingSheetActions {
                override fun scanPairingQr() = startPairingScan()

                override fun pastePairingValue() = pastePairingValueFromClipboard()

                override fun openConnectionSettings(instanceId: String) =
                    showConnectionSettings(instanceId)

                override fun connectRemote() = this@MainActivity.connectRemote()

                override fun cancelRemoteConnection() =
                    this@MainActivity.cancelRemoteConnection()

                override fun disconnectRemote() = this@MainActivity.disconnectRemote()

                override fun dismissPairing() = showCloudDashboard()
            },
        )
        connectionSettingsDialog = ConnectionSettingsDialog(
            this,
            object : ConnectionSettingsActions {
                override fun setBiometricRequired(required: Boolean) {
                    this@MainActivity.setBiometricRequired(required)
                }

                override fun verifyPairingProtection(instanceId: String) {
                    this@MainActivity.verifyPairingProtection(instanceId)
                }

                override fun retryPairingConfirmation(instanceId: String) {
                    this@MainActivity.retryPairingConfirmation(instanceId)
                }

                override fun forgetPairing(instanceId: String) {
                    this@MainActivity.forgetPairing(instanceId)
                }

                override fun dismissConnectionSettings() =
                    this@MainActivity.dismissConnectionSettings()

                override fun setUpdateChannel(channel: UpdateChannel) {
                    updateController.setChannel(channel)
                }

                override fun checkForUpdate() {
                    updateController.check(UpdateSchedule.Trigger.MANUAL)
                }

                override fun openReleasePage(url: String) {
                    this@MainActivity.openReleasePage(url)
                }
            },
        )
        updateController = AppUpdateController(
            store = SharedPreferencesUpdateStore(this),
            currentVersionName = BuildConfig.VERSION_NAME,
            checkEnabledBuild = BuildConfig.UPDATE_CHECK_ENABLED,
            // `onDestroy` 가 실행기를 내리므로 그 뒤의 확인 요청은 조용히 버린다.
            // 앱이 사라진 뒤 도착한 응답도 화면에 반영하지 않는다 (ADR-0197).
            runOnWorker = { task ->
                if (!isDestroyed && !remoteExecutor.isShutdown) remoteExecutor.execute(task)
            },
            runOnMain = { task -> if (!isDestroyed) runOnUiThread(task) },
        )
        updateController.onStateChanged = { state -> renderUpdateState(state) }
        webView = createWebView()
        cloudWebView = createCloudWebView()
        remoteLoadingOverlay = createRemoteLoadingOverlay()
        cloudLoadOverlay = CloudLoadOverlayView(this, ::retryCloudDocument)
        root = FrameLayout(this).apply {
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
            addView(
                remoteLoadingOverlay,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
            addView(
                cloudLoadOverlay,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        updateBanner = UpdateBannerView(
            this,
            root,
            object : UpdateBannerActions {
                override fun openReleasePage(url: String) {
                    this@MainActivity.openReleasePage(url)
                }

                override fun dismissUpdateBanner() {
                    updateController.dismissAvailable()
                }
            },
        )
        root.addView(
            updateBanner.view,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP,
            ).apply {
                val density = resources.displayMetrics.density
                val margin = (12 * density).toInt()
                leftMargin = margin
                rightMargin = margin
                topMargin = margin
            },
        )
        setContentView(root)
        applySystemBarInsets(root)
        applyWebSurfaceLayers(VisibleWebSurface.CLOUD)
        installRemoteBackGuard()
        loadCloudDocument(cloudNavigation.startUrl, replaceWebView = false)
        // Only on a genuine cold start: a recreation (density/locale change,
        // process restore) redelivers the same VIEW intent, and replaying the
        // payload would overwrite the vault with a fresh nonce, get a 409
        // from the already-confirmed desktop, and tear the pairing down.
        renderUpdateState(updateController.state())
        if (savedInstanceState == null) {
            handleDebugPairingIntent(intent)
            showDebugNativeSurfacePreviewIfRequested()
        }
    }

    /**
     * 배너와 열려 있는 설정 섹션은 같은 상태의 두 투영이다 (ADR-0197). 한쪽만
     * 갱신하면 다이얼로그가 옛 후보를 들고 남는다.
     */
    private fun renderUpdateState(state: UpdateState) {
        if (!::updateBanner.isInitialized) return
        updateBanner.render(state)
        // Remote 로 가는 전환에서 WebView 가 앞으로 나오므로, 배너는 그 뒤에도
        // 최상위 자식으로 남아야 다음 복귀에서 가려지지 않는다.
        if (state.surface != UpdateSurface.REMOTE) updateBanner.view.bringToFront()
        val instanceId = connectionSettingsInstanceId
        if (instanceId != null && connectionSettingsDialog.isShowing) {
            connectionSettingsDialog.render(connectionSettingsState(instanceId))
        }
    }

    /**
     * 릴리스 페이지로 넘기는 것이 이 기능의 종결 동작이다 (ADR-0197). URL 은
     * 매니페스트 파싱 단계에서 이 저장소의 릴리스 tag 주소로 좁혀졌고, 여기서는
     * 브라우저로 나가는 형식만 한 번 더 확인한다.
     */
    private fun openReleasePage(url: String) {
        val browsable = ExternalUrlPolicy.browsableUrl(url) ?: return
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(browsable)).apply {
            addCategory(Intent.CATEGORY_BROWSABLE)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            showCloudMessage(getString(R.string.update_open_browser_missing))
        }
    }

    /** Debug-only deterministic surface for emulator screenshot/accessibility checks. */
    private fun showDebugNativeSurfacePreviewIfRequested() {
        val debugBuild = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (!debugBuild) return
        // 배너는 확인 결과에 딸린 표시라 네트워크 없이는 재현되지 않는다. 후보를
        // 주입해 결정적으로 띄운다 (ADR-0197).
        if (intent.getBooleanExtra(DEBUG_UPDATE_BANNER_PREVIEW, false)) {
            updateController.injectAvailableForPreview(
                AvailableUpdate(
                    version = DEBUG_UPDATE_PREVIEW_VERSION,
                    releaseUrl = "https://github.com/kochul2000/laymux/releases/tag/v" +
                        DEBUG_UPDATE_PREVIEW_VERSION,
                ),
            )
        }
        when {
            intent.getBooleanExtra(DEBUG_CONNECTION_SETTINGS_PREVIEW, false) -> {
                debugConnectionSettingsPreviewActive = true
                connectionSettingsInstanceId = DEBUG_PAIRING_INSTANCE_ID
                applyWebSurfaceLayers(VisibleWebSurface.CONNECTION_SETTINGS)
                connectionSettingsDialog.show(
                    connectionSettingsState(DEBUG_PAIRING_INSTANCE_ID),
                )
            }
            intent.getBooleanExtra(DEBUG_PAIRING_SHEET_PREVIEW, false) -> {
                debugPairingPreviewActive = true
                selectedCloudInstanceId = DEBUG_PAIRING_INSTANCE_ID
                applyWebSurfaceLayers(VisibleWebSurface.PAIRING)
                pairingSheet.show(pairingSheetState())
            }
        }
    }

    /**
     * The PC-owned Remote document gets first refusal on system back so native
     * does not duplicate its viewer/drawer hierarchy (ADR-0219). With no
     * dismissible page layer, the existing two-press disconnect guard applies.
     */
    private fun installRemoteBackGuard() {
        onBackPressedDispatcher.addCallback(
            this,
            object : androidx.activity.OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (visibleWebSurface == VisibleWebSurface.REMOTE && !isDestroyed) {
                        dismissRemoteLayerOrGuardDisconnect()
                        return
                    }
                    isEnabled = false
                    try {
                        onBackPressedDispatcher.onBackPressed()
                    } finally {
                        isEnabled = true
                    }
                }
            },
        )
    }

    private fun dismissRemoteLayerOrGuardDisconnect() {
        if (!::webView.isInitialized || remoteBackEvaluationGeneration != null) return
        val targetWebView = webView
        val documentGeneration = secureWebViewGeneration
        remoteBackEvaluationGeneration = documentGeneration
        targetWebView.evaluateJavascript(REMOTE_DISMISS_TOP_LAYER_SCRIPT) { result ->
            if (remoteBackEvaluationGeneration == documentGeneration) {
                remoteBackEvaluationGeneration = null
            }
            if (isDestroyed || targetWebView !== webView ||
                !remoteBridgeActionsEnabled(documentGeneration)
            ) {
                return@evaluateJavascript
            }
            when (
                remoteBackGuard.onBackPressed(
                    SystemClock.elapsedRealtime(),
                    remoteLayerDismissed = result == "true",
                )
            ) {
                RemoteBackGuard.Action.DISMISS -> Unit
                RemoteBackGuard.Action.WARN -> Toast.makeText(
                    this@MainActivity,
                    "한 번 더 누르면 연결을 끊고 대시보드로 이동합니다.",
                    Toast.LENGTH_SHORT,
                ).show()
                RemoteBackGuard.Action.LEAVE -> disconnectRemote()
            }
        }
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
        // A replacement Remote document must never receive the result for a
        // chooser opened by the document it superseded.
        cancelPendingFileChooser()
        val documentGeneration = remoteDocumentAuthority.installFreshDocument()
        secureWebViewGeneration = documentGeneration
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
            webViewClient = LocalContentWebViewClient(
                { path -> loadRemoteResource(documentGeneration, path) },
                { onRemoteDocumentLoaded(documentGeneration) },
                { onRemoteMainDocumentUnavailable(documentGeneration) },
            )
            webChromeClient = JsDialogChromeClient(
                this@MainActivity,
                ::showWebFileChooser,
            ).also {
                remoteJsDialogs?.dismissActive()
                remoteJsDialogs = it
            }
            addJavascriptInterface(
                RemoteBridge(this@MainActivity, documentGeneration),
                NATIVE_BRIDGE_NAME,
            )
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
            ) {
                WebViewCompat.addWebMessageListener(
                    this,
                    REMOTE_OUTPUT_BRIDGE_NAME,
                    setOf(REMOTE_WRAPPER_ORIGIN),
                ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
                    if (remoteBridgeActionsEnabled(documentGeneration) &&
                        isMainFrame && sourceOrigin == Uri.parse(REMOTE_WRAPPER_ORIGIN)
                    ) {
                        stringWebMessagePayload(
                            message.type,
                            WebMessageCompat.TYPE_STRING,
                        ) { message.data }?.let { handleRemoteOutputMessage(it, replyProxy) }
                    }
                }
            }
        }
    }

    private fun showWebFileChooser(
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ) {
        cancelPendingFileChooser()
        if (isFinishing || isDestroyed) {
            callback.onReceiveValue(null)
            return
        }
        val intent = try {
            params.createIntent().addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: ActivityNotFoundException) {
            callback.onReceiveValue(null)
            return
        }
        pendingFileChooser.replace(callback::onReceiveValue)
        try {
            fileChooserLauncher.launch(intent)
        } catch (_: ActivityNotFoundException) {
            pendingFileChooser.cancel()
        }
    }

    private fun cancelPendingFileChooser() {
        pendingFileChooser.cancel()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createCloudWebView(): WebView {
        cloudWebViewGeneration += 1
        val documentGeneration = cloudWebViewGeneration
        return WebView(this).apply {
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
            webViewClient = CloudWebViewClient(
                cloudNavigation,
                documentGeneration,
                cloudDocumentLoadState,
                ::onCloudDocumentPresentationChanged,
            )
            webChromeClient = JsDialogChromeClient(
                this@MainActivity,
                ::showWebFileChooser,
            ).also {
                cloudJsDialogs?.dismissActive()
                cloudJsDialogs = it
            }
            addJavascriptInterface(cloudBridge, CLOUD_BRIDGE_NAME)
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
        }
    }

    /**
     * Covers the WebView while the Remote document and its assets stream in as
     * serial encrypted RPCs (ADR-0168). Clickable so touches cannot reach the
     * stale document underneath.
     */
    private fun createRemoteLoadingOverlay(): LinearLayout {
        val density = resources.displayMetrics.density
        remoteLoadingStatus = TextView(this).apply {
            setTextColor(Color.parseColor("#f2f5f7"))
            textSize = 14f
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, (16 * density).toInt(), 0, 0)
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#e6101418"))
            visibility = View.GONE
            // Clickable blocks touches from reaching the stale document below.
            // NOT focusable: taking view focus here leaves the WebView unfocused
            // once the overlay hides, and the first tap on the Remote page then
            // only restores view focus instead of raising the soft keyboard.
            isClickable = true
            isFocusable = false
            addView(
                ProgressBar(this@MainActivity),
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ),
            )
            addView(
                remoteLoadingStatus,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ),
            )
            addView(
                Button(this@MainActivity).apply {
                    text = "연결 취소"
                    setOnClickListener { cancelRemoteConnection() }
                },
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = (20 * density).toInt() },
            )
        }
    }

    private fun onCloudDocumentPresentationChanged(
        presentation: CloudDocumentPresentation,
    ) {
        cloudDocumentPresentation = presentation
        if (!::cloudLoadOverlay.isInitialized) return
        cloudLoadOverlay.render(presentation)
        applyCloudDocumentLayers(
            WebSurfaceLayerPolicy.forSurface(visibleWebSurface, presentation),
        )
    }

    private fun applyCloudDocumentLayers(layers: WebSurfaceLayers) {
        if (!::cloudWebView.isInitialized) return
        cloudWebView.isEnabled = layers.cloudInteractive
        cloudWebView.isFocusable = layers.cloudInteractive
        cloudWebView.isFocusableInTouchMode = layers.cloudInteractive
        cloudWebView.importantForAccessibility = if (layers.cloudAccessible) {
            View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        } else {
            View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        if (!layers.cloudInteractive) cloudWebView.clearFocus()
        cloudLoadOverlay.visibility = if (layers.cloudLoadOverlayVisible) {
            View.VISIBLE
        } else {
            View.GONE
        }
    }

    private fun retryCloudDocument() {
        if (!::cloudWebView.isInitialized || isDestroyed) return
        val retryUrl = cloudWebView.url
            ?.takeIf(cloudNavigation::isAllowed)
            ?: cloudNavigation.startUrl
        loadCloudDocument(retryUrl, replaceWebView = true)
    }

    private fun loadCloudDocument(url: String, replaceWebView: Boolean) {
        if (!::cloudWebView.isInitialized || isDestroyed) return
        if (replaceWebView) replaceCloudWebView()
        val documentGeneration = cloudWebViewGeneration
        beginCloudDocumentNavigation(
            state = cloudDocumentLoadState,
            generation = documentGeneration,
            url = url,
            publish = ::onCloudDocumentPresentationChanged,
            navigate = { cloudWebView.loadUrl(url) },
        )
    }

    private fun updateRemoteLoadProgress(update: (RemoteLoadProgress) -> RemoteLoadProgress) {
        runOnUiThread {
            if (isDestroyed) return@runOnUiThread
            remoteLoadProgress = update(remoteLoadProgress)
            if (remoteLoadingOverlay.visibility == View.VISIBLE) {
                remoteLoadingStatus.text = remoteLoadProgress.statusText()
            }
        }
    }

    /**
     * The handshake happens while the pairing sheet is still on screen with no
     * motion of its own, so the overlay covers the whole connection — transport
     * stage first, then the resource counters once the document loads.
     */
    private fun showRemoteConnectStage(stage: String) {
        runOnUiThread {
            if (isDestroyed) return@runOnUiThread
            remoteLoadingStatus.text = stage
            remoteLoadingOverlay.bringToFront()
            remoteLoadingOverlay.visibility = View.VISIBLE
        }
    }

    private fun hideRemoteLoadingOverlay() {
        runOnUiThread {
            if (isDestroyed) return@runOnUiThread
            remoteLoadingOverlay.visibility = View.GONE
        }
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
                loadCloudDocument(cloudNavigation.dashboardUrl, replaceWebView = true)
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

    fun selectCloudInstance(instanceId: String, tailscaleUrl: String?) {
        if (!cloudBridgeActionsEnabled()) return
        if (selectedCloudInstanceId != instanceId || selectedTailscaleUrl != tailscaleUrl) {
            closeRemoteSession()
        }
        selectedCloudInstanceId = instanceId
        selectedTailscaleUrl = tailscaleUrl
        cloudFallbackActive = false
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
                notifyPairingChanged(
                    notice = "선택한 PC의 E2E QR을 스캔하거나 페어링 값을 붙여넣으세요.",
                )
            }
        }
    }

    fun showCloudDashboard() {
        closeRemoteSession()
        debugPairingPreviewActive = false
        debugConnectionSettingsPreviewActive = false
        selectedCloudInstanceId = null
        selectedTailscaleUrl = null
        connectionSettingsInstanceId = null
        cloudFallbackActive = false
        if (!::cloudWebView.isInitialized || isDestroyed) return
        if (::pairingSheet.isInitialized) pairingSheet.dismiss()
        if (::connectionSettingsDialog.isInitialized) connectionSettingsDialog.dismiss()
        loadCloudDocument(cloudNavigation.dashboardUrl, replaceWebView = true)
        applyWebSurfaceLayers(VisibleWebSurface.CLOUD)
    }

    private fun showPairingSurface() {
        if (!::pairingSheet.isInitialized || isDestroyed) return
        applyWebSurfaceLayers(VisibleWebSurface.PAIRING)
        pairingSheet.show(pairingSheetState())
    }

    fun openConnectionSettings(instanceId: String) {
        if (!cloudBridgeActionsEnabled()) return
        showConnectionSettings(instanceId)
    }

    private fun showConnectionSettings(instanceId: String) {
        if (!::connectionSettingsDialog.isInitialized || isDestroyed) return
        if (::pairingSheet.isInitialized) pairingSheet.dismiss()
        connectionSettingsInstanceId = instanceId
        applyWebSurfaceLayers(VisibleWebSurface.CONNECTION_SETTINGS)
        connectionSettingsDialog.show(connectionSettingsState(instanceId))
    }

    fun dismissConnectionSettings() {
        if (visibleWebSurface != VisibleWebSurface.CONNECTION_SETTINGS) return
        debugConnectionSettingsPreviewActive = false
        connectionSettingsInstanceId = null
        applyWebSurfaceLayers(VisibleWebSurface.CLOUD)
    }

    private fun showRemoteSurface() {
        if (!::webView.isInitialized || isDestroyed) return
        if (!remoteDocumentAuthority.authorize(secureWebViewGeneration)) {
            closeRemoteSession()
            showCloudDashboard()
            return
        }
        pairingSheet.dismiss()
        connectionSettingsDialog.dismiss()
        connectionSettingsInstanceId = null
        applyWebSurfaceLayers(VisibleWebSurface.REMOTE)
        // The fresh secure WebView stays below this overlay until the authenticated
        // Remote document and its assets finish crossing the relay.
        remoteLoadProgress = RemoteLoadProgress()
        remoteLoadingStatus.text = remoteLoadProgress.statusText()
        remoteLoadingOverlay.visibility = View.VISIBLE
        webView.loadUrl(LocalContentWebViewClient.REMOTE_START_URL)
    }

    private fun onRemoteDocumentLoaded(documentGeneration: Long) {
        if (!remoteBridgeActionsEnabled(documentGeneration)) return
        remoteLoadingOverlay.visibility = View.GONE
        // Let the overlay visibility/layout change settle before restoring the
        // touch-derived WebView focus used to create its editable InputConnection.
        // Recheck the document identity inside the posted turn: the user can leave
        // Remote while the callback is queued, replacing this secure WebView.
        val loadedWebView = webView
        scheduleRemoteInputFocus(
            post = loadedWebView::post,
            canFocus = {
                !isDestroyed &&
                    visibleWebSurface == VisibleWebSurface.REMOTE &&
                    webView === loadedWebView &&
                    remoteBridgeActionsEnabled(documentGeneration)
            },
            requestFocusFromTouch = loadedWebView::requestFocusFromTouch,
        )
    }

    private fun onRemoteMainDocumentUnavailable(documentGeneration: Long) {
        runOnUiThread {
            if (!remoteLifecycleActive || !remoteBridgeActionsEnabled(documentGeneration)) {
                return@runOnUiThread
            }
            showCloudDashboard()
            showCloudMessage("PC 원격 화면을 불러올 수 없어 대시보드로 돌아왔습니다.")
        }
    }

    private fun resumeRemoteSurfaceAfterBackground(
        session: RemoteSession,
        connectionGeneration: Long,
        completion: RemoteHttpResumeTracker.Completion?,
    ) {
        if (!::webView.isInitialized || isDestroyed) return
        val action = RemoteSurfaceResumePolicy.action(
            remoteSurfaceInstalled = webView.url?.startsWith(
                "https://${LocalContentWebViewClient.REMOTE_WRAPPER_HOST}/",
            ) == true,
            currentUrl = webView.url,
        )
        if (action == RemoteSurfaceResumeAction.RELOAD_DOCUMENT) {
            showRemoteSurface()
            return
        }
        webView.evaluateJavascript(remoteForegroundResumeScript(completion)) { handled ->
            if (handled == "true") return@evaluateJavascript
            val stale = remoteConnectionGeneration.get() != connectionGeneration ||
                !remoteLifecycleActive || remoteSession !== session || isDestroyed
            if (!stale) showRemoteSurface()
        }
    }

    private fun remoteForegroundResumeScript(
        completion: RemoteHttpResumeTracker.Completion?,
    ): String {
        val response = completion?.response
        val deliverResponse = if (completion != null && response != null) {
            "if(typeof receiver.onHttpResponse!=='function')return false;" +
                "receiver.onHttpResponse(" +
                "${JSONObject.quote(completion.requestId)},${JSONObject.quote(response.toString())});"
        } else {
            ""
        }
        return "(function(){var receiver=window.laymuxAndroidE2e;" +
            "if(!receiver)return false;" + deliverResponse +
            "if(typeof receiver.onNativeForeground!=='function')return false;" +
            "return receiver.onNativeForeground()===true;})()"
    }

    private fun applyWebSurfaceLayers(surface: VisibleWebSurface) {
        if (surface != VisibleWebSurface.REMOTE) {
            revokeRemoteDocument()
            if (visibleWebSurface == VisibleWebSurface.REMOTE) replaceSecureWebView()
        }
        val layers = WebSurfaceLayerPolicy.forSurface(surface, cloudDocumentPresentation)
        visibleWebSurface = surface
        if (surface != VisibleWebSurface.REMOTE) {
            remoteLoadingOverlay.visibility = View.GONE
            remoteBackEvaluationGeneration = null
            // A warning armed on the Remote surface must not carry into the
            // next visit — re-entering within the window would treat a single
            // back press as the confirmed second one.
            remoteBackGuard.reset()
        }
        cloudWebView.visibility = if (layers.cloudVisible) View.VISIBLE else View.GONE
        webView.visibility = if (layers.secureVisible) View.VISIBLE else View.GONE
        applyCloudDocumentLayers(layers)
        if (layers.secureVisible) {
            webView.bringToFront()
            webView.requestFocus()
            // bringToFront reorders the WebView past the loading overlay, which
            // must stay the topmost child or the connect progress never shows.
            remoteLoadingOverlay.bringToFront()
        }
        if (::updateController.isInitialized) {
            updateController.setSurface(
                if (surface == VisibleWebSurface.REMOTE) {
                    UpdateSurface.REMOTE
                } else {
                    UpdateSurface.OTHER
                },
            )
        }
    }

    private fun revokeRemoteDocument() {
        remoteDocumentAuthority.revoke()
        oauthRelay?.stop()
        oauthRelay = null
        oauthRelayDocumentGeneration = null
        pendingOauthCallback = null
    }

    private fun replaceSecureWebView() {
        if (!::root.isInitialized || !::webView.isInitialized || isDestroyed) return
        val previous = webView
        val replacement = createWebView().apply {
            visibility = View.GONE
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        root.removeView(previous)
        previous.removeJavascriptInterface(NATIVE_BRIDGE_NAME)
        previous.stopLoading()
        previous.destroy()
        webView = replacement
        root.addView(
            replacement,
            1,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
    }

    private fun replaceCloudWebView() {
        if (!::root.isInitialized || !::cloudWebView.isInitialized || isDestroyed) return
        cancelPendingFileChooser()
        val previous = cloudWebView
        val replacement = createCloudWebView()
        val layers = WebSurfaceLayerPolicy.forSurface(
            visibleWebSurface,
            cloudDocumentPresentation,
        )
        replacement.visibility = if (layers.cloudVisible) View.VISIBLE else View.GONE
        root.removeView(previous)
        previous.removeJavascriptInterface(CLOUD_BRIDGE_NAME)
        previous.stopLoading()
        previous.destroy()
        cloudWebView = replacement
        root.addView(
            replacement,
            0,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        applyCloudDocumentLayers(layers)
    }

    private fun cloudBridgeActionsEnabled(): Boolean =
        WebSurfaceLayerPolicy.forSurface(
            visibleWebSurface,
            cloudDocumentPresentation,
        ).cloudBridgeEnabled

    private fun remoteBridgeActionsEnabled(documentGeneration: Long): Boolean =
        remoteDocumentAuthority.allows(
            documentGeneration,
            WebSurfaceLayerPolicy.forSurface(visibleWebSurface).remoteBridgeEnabled,
        )

    private fun showCloudMessage(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    fun rejectInvalidTailscaleRoute() {
        if (!cloudBridgeActionsEnabled()) return
        showCloudMessage("PC가 알린 Tailscale 주소가 올바르지 않아 연결을 중단했습니다.")
    }

    fun biometricAvailability(): BiometricAvailability = biometricGate.availability()

    fun remoteConnected(): Boolean = remoteSession?.isExpired() == false

    fun remoteConnecting(): Boolean = remoteConnecting

    fun remoteSessionExpiresAt(): Long? = remoteSession?.expiresAtEpochSeconds

    fun setRemoteLease(documentGeneration: Long, leaseId: String?) {
        if (!remoteBridgeActionsEnabled(documentGeneration)) return
        remoteLeaseId = leaseId?.takeIf { it.isNotBlank() }
    }

    /**
     * The Remote document cannot open a link itself: the secure WebView has no multiple-window
     * support and its navigation allowlist rejects every off-origin URL. Native starts the OS
     * browser instead, after re-validating the terminal-controlled URL.
     */
    fun openExternalUrl(documentGeneration: Long, rawUrl: String) {
        val url = ExternalUrlPolicy.browsableUrl(rawUrl) ?: return
        runOnUiThread {
            if (!remoteBridgeActionsEnabled(documentGeneration)) return@runOnUiThread
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addCategory(Intent.CATEGORY_BROWSABLE)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            try {
                startActivity(intent)
            } catch (_: ActivityNotFoundException) {
                showCloudMessage("링크를 열 브라우저를 찾지 못했습니다.")
            }
        }
    }

    /**
     * Save a file the Remote FileViewer downloaded (ADR-0185).
     *
     * The secure WebView has no download handler, so the browser's `<a download>` path is a
     * silent no-op here. Native writes the bytes into the shared Downloads collection, which
     * needs no runtime permission — but only from Android 10, where `MediaStore.Downloads`
     * appeared. Older devices are told instead of being handed a silent failure.
     */
    fun saveRemoteFile(
        documentGeneration: Long,
        name: String,
        mediaType: String,
        base64: String,
    ) {
        if (!remoteBridgeActionsEnabled(documentGeneration)) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            runOnUiThread { showCloudMessage("파일 저장은 Android 10 이상에서 지원됩니다.") }
            return
        }
        if (!RemoteDownloadPolicy.isEncodedPayloadWithinBound(base64.length)) {
            runOnUiThread { showCloudMessage("파일이 전송 한도를 넘었습니다.") }
            return
        }
        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (_: IllegalArgumentException) {
            runOnUiThread { showCloudMessage("파일 데이터를 해석하지 못했습니다.") }
            return
        }
        if (!RemoteDownloadPolicy.isWithinBound(bytes.size)) {
            runOnUiThread { showCloudMessage("파일이 전송 한도를 넘었습니다.") }
            return
        }
        val displayName = RemoteDownloadPolicy.safeDisplayName(name)
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, displayName)
            put(
                MediaStore.Downloads.MIME_TYPE,
                mediaType.ifBlank { "application/octet-stream" },
            )
            // IS_PENDING keeps the entry invisible to other apps until the bytes are all
            // there, so a failed write never leaves a truncated file behind.
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = contentResolver
        // Every ContentResolver call here can throw beyond IOException — OEM providers raise
        // SecurityException and IllegalArgumentException too. An escape would leave the entry
        // stuck at IS_PENDING=1, invisible to every app and impossible for the user to find
        // or delete, with no message explaining why. So each call fails into a reported error.
        val uri = try {
            resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        } catch (_: RuntimeException) {
            null
        }
        if (uri == null) {
            runOnUiThread { showCloudMessage("저장 위치를 만들지 못했습니다.") }
            return
        }
        val written = try {
            resolver.openOutputStream(uri)?.use { stream -> stream.write(bytes) } != null
        } catch (_: IOException) {
            false
        } catch (_: RuntimeException) {
            false
        }
        if (!written) {
            discardPendingDownload(resolver, uri)
            runOnUiThread { showCloudMessage("파일을 저장하지 못했습니다.") }
            return
        }
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        val published = try {
            resolver.update(uri, values, null, null) > 0
        } catch (_: RuntimeException) {
            false
        }
        if (!published) {
            // The bytes are on disk but the entry never became visible. Removing it is the
            // only outcome the user can act on — a hidden file they cannot see or delete is
            // worse than no file.
            discardPendingDownload(resolver, uri)
            runOnUiThread { showCloudMessage("저장한 파일을 공개하지 못했습니다.") }
            return
        }
        runOnUiThread { showCloudMessage("$displayName 을(를) 다운로드에 저장했습니다.") }
    }

    /** Best-effort cleanup of a still-pending Downloads entry; never throws. */
    private fun discardPendingDownload(resolver: ContentResolver, uri: Uri) {
        try {
            resolver.delete(uri, null, null)
        } catch (_: RuntimeException) {
            // Nothing further to try: the entry stays pending and invisible, and the caller
            // already reports the failure to the user.
        }
    }

    /**
     * OAuth loopback relay (ADR-0175): bind the phone's `localhost:{port}`,
     * open the OS browser on the auth URL, and hand the provider's redirect
     * back to the Remote document, which forwards it to the PC listener over
     * the authenticated transport. Every parameter is Remote-document input,
     * so it is re-validated here like the other bridge entry points.
     *
     * The redirect arrives while the OS browser is frontmost — this activity
     * is stopped and the E2E session is suspended, so new RPCs are refused
     * (ADR-0146). The callback is therefore parked in [pendingOauthCallback]
     * and delivered to the Remote document on the next onStart; the browser
     * already got its "return to the app" page from the listener.
     */
    fun beginOauthRelay(
        documentGeneration: Long,
        sessionId: String,
        portValue: String,
        expectedPath: String,
        authUrl: String,
    ) {
        if (!validBridgeId(sessionId)) return
        val port = portValue.toIntOrNull() ?: return
        if (port < 1024 || port > 65535) return
        if (expectedPath.isEmpty() || expectedPath.length > MAX_REMOTE_PATH_LENGTH ||
            !expectedPath.startsWith('/')
        ) {
            return
        }
        val url = ExternalUrlPolicy.browsableUrl(authUrl) ?: return
        runOnUiThread {
            if (!remoteBridgeActionsEnabled(documentGeneration)) return@runOnUiThread
            oauthRelay?.stop()
            oauthRelayDocumentGeneration = documentGeneration
            val relay = OauthLoopbackRelay(
                port = port,
                expectedPath = expectedPath,
                onCallback = { pathAndQuery ->
                    deliverOauthCallback(documentGeneration, pathAndQuery)
                },
                onError = { message ->
                    dispatchOauthRelayEvent(documentGeneration, "onError", message)
                },
            )
            if (!relay.start()) {
                oauthRelay = null
                oauthRelayDocumentGeneration = null
                dispatchOauthRelayEvent(
                    documentGeneration,
                    "onError",
                    "Could not open the sign-in relay port on this device.",
                )
                return@runOnUiThread
            }
            oauthRelay = relay
            openExternalUrl(documentGeneration, url)
        }
    }

    fun cancelOauthRelay(documentGeneration: Long) {
        // Called from the WebView JS bridge thread. The relay fields are
        // otherwise touched only on the UI thread (beginOauthRelay,
        // deliverOauthCallback, flushPendingOauthCallback, onDestroy), so hop
        // there to avoid racing a parked-callback delivery/flush. stop() is
        // itself AtomicBoolean-safe; the field writes are the race.
        runOnUiThread {
            if (!remoteBridgeActionsEnabled(documentGeneration)) return@runOnUiThread
            if (oauthRelayDocumentGeneration != documentGeneration) return@runOnUiThread
            oauthRelay?.stop()
            oauthRelay = null
            oauthRelayDocumentGeneration = null
            pendingOauthCallback = null
        }
    }

    private fun deliverOauthCallback(documentGeneration: Long, pathAndQuery: String) {
        runOnUiThread {
            if (!remoteBridgeActionsEnabled(documentGeneration) ||
                oauthRelayDocumentGeneration != documentGeneration
            ) {
                return@runOnUiThread
            }
            oauthRelay = null
            oauthRelayDocumentGeneration = null
            if (remoteLifecycleActive) {
                dispatchOauthRelayEvent(documentGeneration, "onCallback", pathAndQuery)
            } else {
                // The OS browser is frontmost with the "return to the app"
                // page. Park the callback and pull this task back to the
                // front so the forward runs without the user pressing Back;
                // onStart flushes the parked callback. Best-effort — a denied
                // background-activity launch just leaves the manual Back path.
                pendingOauthCallback = PendingOauthCallback(documentGeneration, pathAndQuery)
                bringTaskToForeground()
            }
        }
    }

    private fun bringTaskToForeground() {
        try {
            val intent = Intent(this, MainActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_NEW_TASK,
                )
            }
            startActivity(intent)
        } catch (_: Exception) {
        }
    }

    private fun flushPendingOauthCallback() {
        val callback = pendingOauthCallback ?: return
        pendingOauthCallback = null
        dispatchOauthRelayEvent(
            callback.documentGeneration,
            "onCallback",
            callback.pathAndQuery,
        )
    }

    private fun dispatchOauthRelayEvent(
        documentGeneration: Long,
        method: String,
        vararg arguments: String,
    ) {
        val encodedArguments = arguments.joinToString(",") { JSONObject.quote(it) }
        runOnUiThread {
            if (!::webView.isInitialized || isDestroyed ||
                !remoteBridgeActionsEnabled(documentGeneration)
            ) {
                return@runOnUiThread
            }
            webView.evaluateJavascript(
                "window.laymuxOauthRelay?.$method($encodedArguments);",
                null,
            )
        }
    }

    fun selectedCloudInstanceId(): String? = selectedCloudInstanceId

    /**
     * Shared entry gate for accepting a new pairing payload — from the QR
     * scanner or the debug deep link. Null means the attempt was refused and
     * the pairing status already carries the reason.
     */
    private fun preparePairingPolicy(): PairingProtectionPolicy? {
        if (scanInFlight || hasPendingCryptoOperation()) {
            notifyPairingChanged(error = busyOperationMessage())
            return null
        }
        val policy = try {
            vault.protectionPolicy()
        } catch (_: Exception) {
            notifyPairingChanged(error = "키 보호 설정을 읽지 못했습니다.")
            return null
        }
        if (policy == PairingProtectionPolicy.BIOMETRIC) {
            val availability = biometricAvailability()
            if (availability != BiometricAvailability.AVAILABLE) {
                notifyPairingChanged(error = requireNotNull(availability.userMessage))
                return null
            }
        }
        return policy
    }

    fun startPairingScan() {
        val policy = preparePairingPolicy() ?: return

        scanInFlight = true
        notifyPairingChanged(notice = "Google QR 스캐너를 준비하고 있습니다.")
        val listener = object : InstallStatusListener {
            override fun onInstallStatusUpdated(update: ModuleInstallStatusUpdate) {
                if (scannerModuleListener !== this || !scanInFlight) return
                when (update.installState) {
                    ModuleInstallStatusUpdate.InstallState.STATE_COMPLETED -> {
                        clearScannerModuleListener(this)
                        launchPairingScanner(policy)
                    }
                    ModuleInstallStatusUpdate.InstallState.STATE_DOWNLOAD_PAUSED,
                    ModuleInstallStatusUpdate.InstallState.STATE_CANCELED,
                    ModuleInstallStatusUpdate.InstallState.STATE_FAILED,
                    -> failScannerModuleInstall(this)
                }
            }
        }
        scannerModuleListener = listener
        val request = ModuleInstallRequest.newBuilder()
            .addApi(scanner)
            .setListener(listener)
            .build()
        scannerModuleInstaller.installModules(request)
            .addOnSuccessListener { response ->
                if (scannerModuleListener !== listener || !scanInFlight) {
                    return@addOnSuccessListener
                }
                if (response.areModulesAlreadyInstalled()) {
                    clearScannerModuleListener(listener)
                    launchPairingScanner(policy)
                }
            }
            .addOnFailureListener { failScannerModuleInstall(listener) }
    }

    private fun pastePairingValueFromClipboard() {
        val policy = preparePairingPolicy() ?: return
        val raw = try {
            val clipboard = getSystemService(ClipboardManager::class.java)
            val clip = clipboard.primaryClip
            if (clip == null || clip.itemCount == 0) null else {
                clip.getItemAt(0).text?.toString()?.trim()
            }
        } catch (_: Exception) {
            null
        }
        if (raw.isNullOrEmpty()) {
            notifyPairingChanged(error = "클립보드에 페어링 값이 없습니다.")
            return
        }
        acceptPairingPayload(raw, policy)
    }

    private fun failScannerModuleInstall(expected: InstallStatusListener) {
        if (scannerModuleListener !== expected || !scanInFlight) return
        clearScannerModuleListener(expected)
        scanInFlight = false
        if (!isDestroyed) notifyPairingChanged(error = pairingScannerFailureMessage(null))
    }

    private fun clearScannerModuleListener(expected: InstallStatusListener? = null) {
        val listener = scannerModuleListener ?: return
        if (expected != null && listener !== expected) return
        scannerModuleListener = null
        scannerModuleInstaller.unregisterListener(listener)
    }

    private fun launchPairingScanner(policy: PairingProtectionPolicy) {
        if (!scanInFlight || isDestroyed || isFinishing ||
            visibleWebSurface != VisibleWebSurface.PAIRING
        ) {
            scanInFlight = false
            return
        }
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
                acceptPairingPayload(raw, policy)
            }
            .addOnCanceledListener {
                scanInFlight = false
                scanTask = null
                notifyPairingChanged(error = "QR 스캔을 취소했습니다.")
            }
            .addOnFailureListener { error ->
                scanInFlight = false
                scanTask = null
                notifyPairingChanged(
                    error = pairingScannerFailureMessage(
                        (error as? MlKitException)?.errorCode,
                    ),
                )
            }
    }

    /** Validate and persist one pairing payload string (scanner, clipboard, or debug deep link). */
    private fun acceptPairingPayload(raw: String, policy: PairingProtectionPolicy) {
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
                notifyPairingChanged(
                    error = "선택한 PC의 페어링 값이 아닙니다. 선택한 PC에서 새 값을 받으세요.",
                )
                return
            }
            saveAcceptedPairing(payload, policy)
        } catch (error: IllegalArgumentException) {
            notifyPairingChanged(
                error = error.message ?: "지원하지 않는 페어링 값입니다.",
            )
        } catch (error: Exception) {
            notifyPairingChanged(error = pairingOperationError(error))
        }
    }

    /**
     * Debug-only camera bypass (emulators have no usable scanner): the desktop
     * dev MCP tool `create_android_pairing_payload` returns the pairing value, and
     * `adb shell am start -a android.intent.action.VIEW -d "<payload>"`
     * delivers it here. The intent-filter exists only in the debug manifest
     * overlay, and this guard keeps the path inert even if a release build
     * somehow receives the intent.
     */
    private fun handleDebugPairingIntent(intent: Intent?) {
        val debugBuild = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (!debugBuild) return
        if (intent?.action != Intent.ACTION_VIEW) return
        val data = intent.data ?: return
        if (data.scheme != "laymux" || data.host != "pair") return
        val policy = preparePairingPolicy() ?: return
        acceptPairingPayload(data.toString(), policy)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDebugPairingIntent(intent)
    }

    private fun saveAcceptedPairing(
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
            notifyPairingChanged(
                error = "페어링 값이 만료됐습니다. 새 값을 스캔하거나 붙여넣으세요.",
            )
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

    /**
     * Whether an expired-in-background session can be re-opened in place
     * (biometric re-auth on the Remote surface) instead of dropping to the
     * dashboard: a PC is still selected, its pairing is confirmed, and — for
     * the biometric policy — a biometric is available.
     */
    private fun canReauthenticateExpiredRemote(): Boolean {
        val instanceId = selectedCloudInstanceId ?: return false
        val confirmed = try {
            vault.loadMetadata().firstOrNull { it.instanceId == instanceId }
                ?.confirmedAtEpochSeconds != null
        } catch (_: Exception) {
            false
        }
        if (!confirmed) return false
        val policy = try {
            vault.protectionPolicy()
        } catch (_: Exception) {
            return false
        }
        return policy != PairingProtectionPolicy.BIOMETRIC ||
            biometricAvailability() == BiometricAvailability.AVAILABLE
    }

    fun connectRemote(reauthFallback: (() -> Unit)? = null) {
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
            reauthFallback?.invoke()
            return
        }
        val metadata = try {
            vault.loadMetadata().firstOrNull { it.instanceId == expectedInstanceId }
        } catch (error: Exception) {
            notifyPairingChanged(error = pairingOperationError(error))
            reauthFallback?.invoke()
            return
        }
        if (metadata?.confirmedAtEpochSeconds == null) {
            notifyPairingChanged(error = "먼저 데스크톱과 페어링을 확인하세요.")
            reauthFallback?.invoke()
            return
        }
        val policy = try {
            vault.protectionPolicy()
        } catch (error: Exception) {
            notifyPairingChanged(error = pairingOperationError(error))
            reauthFallback?.invoke()
            return
        }
        if (policy == PairingProtectionPolicy.BIOMETRIC) {
            val availability = biometricAvailability()
            if (availability != BiometricAvailability.AVAILABLE) {
                notifyPairingChanged(error = requireNotNull(availability.userMessage))
                reauthFallback?.invoke()
                return
            }
        }
        val pending = try {
            vault.prepareDecryption(expectedInstanceId)
        } catch (error: Exception) {
            notifyPairingChanged(error = pairingOperationError(error))
            reauthFallback?.invoke()
            return
        } ?: run {
            notifyPairingChanged(error = "먼저 페어링하세요.")
            reauthFallback?.invoke()
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
            completeRemoteConnection(pending, pending.cipher, connectionGeneration, reauthFallback)
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
                            completeRemoteConnection(
                                current,
                                cipher,
                                connectionGeneration,
                                reauthFallback,
                            )
                        }
                    },
                    onError = { message ->
                        pendingDecryption?.close()
                        pendingDecryption = null
                        pendingDecryptionPurpose = null
                        if (remoteConnectionGeneration.get() == connectionGeneration) {
                            remoteConnecting = false
                            notifyPairingChanged(error = message)
                            reauthFallback?.invoke()
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
                    reauthFallback?.invoke()
                }
            }
        }
    }

    private fun completeRemoteConnection(
        pending: PendingPairingDecryption,
        authorizedCipher: Cipher,
        connectionGeneration: Long,
        reauthFallback: (() -> Unit)? = null,
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
            reauthFallback?.invoke()
            return
        }
        try {
            val directUrl = selectedTailscaleUrl?.takeUnless { cloudFallbackActive }
            showRemoteConnectStage(
                if (directUrl != null) {
                    "Tailscale 직접 연결 시도 중…"
                } else {
                    "보안 세션 여는 중…"
                },
            )
            remoteExecutor.execute {
                val result = runCatching {
                    stored.use { material ->
                        ensureRemoteConnectionCurrent(connectionGeneration)
                        val session = E2eTransportPolicy.connectDirectFirst(
                            direct = directUrl?.let(E2eTransport::tailscale),
                            openDirect = { direct ->
                                e2eRemoteClient.open(material, direct) {
                                    ensureRemoteConnectionCurrent(connectionGeneration)
                                }
                            },
                            beforeCloudFallback = {
                                ensureRemoteConnectionCurrent(connectionGeneration)
                                showRemoteConnectStage("Cloud 릴레이로 연결 중…")
                            },
                            openCloud = {
                                e2eRemoteClient.open(material) {
                                    ensureRemoteConnectionCurrent(connectionGeneration)
                                }
                            },
                        )
                        remoteOpeningSession = session
                        try {
                            ensureRemoteConnectionCurrent(connectionGeneration)
                        } catch (error: RemoteConnectionCancelledException) {
                            if (remoteOpeningSession === session) remoteOpeningSession = null
                            session.close()
                            throw error
                        }
                        session
                    }
                }
                runOnUiThread {
                    val stale = remoteConnectionGeneration.get() != connectionGeneration ||
                        !remoteLifecycleActive || isDestroyed
                    if (stale) {
                        hideRemoteLoadingOverlay()
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
                            if (directUrl != null &&
                                session.transport.kind == E2eTransportKind.CLOUD_RELAY
                            ) {
                                cloudFallbackActive = true
                            }
                            remoteSession = session
                            showRemoteSurface()
                        },
                        onFailure = { error ->
                            closeRemoteSession()
                            hideRemoteLoadingOverlay()
                            if (error !is RemoteConnectionCancelledException) {
                                notifyPairingChanged(error = remoteErrorMessage(error))
                                reauthFallback?.invoke()
                            }
                        },
                    )
                }
            }
        } catch (_: RejectedExecutionException) {
            stored.close()
            remoteConnecting = false
            hideRemoteLoadingOverlay()
            notifyPairingChanged(error = "보안 연결 작업을 시작하지 못했습니다.")
            reauthFallback?.invoke()
        }
    }

    private fun ensureRemoteConnectionCurrent(connectionGeneration: Long) {
        if (remoteConnectionGeneration.get() != connectionGeneration || !remoteLifecycleActive) {
            throw RemoteConnectionCancelledException()
        }
    }

    private fun loadRemoteResource(
        documentGeneration: Long,
        path: String,
    ): RemoteResourceLoadResult {
        if (!remoteBridgeActionsEnabled(documentGeneration) || !remoteLifecycleActive) {
            return RemoteResourceLoadResult.Cancelled
        }
        if (path.length > MAX_REMOTE_PATH_LENGTH) return RemoteResourceLoadResult.Unavailable
        val session = remoteSession ?: return RemoteResourceLoadResult.Unavailable
        if (session.isExpired()) return RemoteResourceLoadResult.Unavailable
        remoteResourceCache.get(session.instanceId, path)?.let { cached ->
            updateRemoteLoadProgress(RemoteLoadProgress::cacheHit)
            return RemoteResourceLoadResult.Response(cached)
        }
        val future = try {
            remoteExecutor.submit<RemoteResourceLoadResult> {
                if (!remoteBridgeActionsEnabled(documentGeneration) ||
                    !remoteLifecycleActive || remoteSession !== session
                ) {
                    return@submit RemoteResourceLoadResult.Cancelled
                }
                val response = e2eRemoteClient.rpc(
                    session,
                    JSONObject().put("kind", "resource").put("path", path),
                )
                if (!remoteBridgeActionsEnabled(documentGeneration) ||
                    !remoteLifecycleActive || remoteSession !== session
                ) {
                    return@submit RemoteResourceLoadResult.Cancelled
                }
                if (response.optString("kind") == "error") {
                    val status = response.optInt("status", 500).coerceIn(400, 599)
                    return@submit RemoteResourceLoadResult.Response(
                        RemoteResourceResponse.error(
                            status,
                            response.optString("error", "Remote resource failed"),
                        ),
                    )
                }
                val resource = RemoteResourceResponse.parse(response).also { parsed ->
                    // put() keeps only responses the desktop explicitly marked
                    // cacheable; everything else passes through untouched.
                    remoteResourceCache.put(session.instanceId, path, parsed)
                }
                RemoteResourceLoadResult.Response(resource)
            }
        } catch (_: RejectedExecutionException) {
            return RemoteResourceLoadResult.Unavailable
        }
        updateRemoteLoadProgress { it.fetching(path) }
        return try {
            val result = future.get(REMOTE_RESOURCE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            if (!remoteBridgeActionsEnabled(documentGeneration) ||
                !remoteLifecycleActive || remoteSession !== session
            ) {
                return RemoteResourceLoadResult.Cancelled
            }
            updateRemoteLoadProgress {
                if (result is RemoteResourceLoadResult.Response) {
                    it.fetched(result.value.body.size)
                } else {
                    it.fetchFailed()
                }
            }
            result
        } catch (error: ExecutionException) {
            updateRemoteLoadProgress(RemoteLoadProgress::fetchFailed)
            if (!remoteBridgeActionsEnabled(documentGeneration) ||
                !remoteLifecycleActive || remoteSession !== session
            ) {
                return RemoteResourceLoadResult.Cancelled
            }
            handleRemoteFailure(error.cause ?: error, session)
            RemoteResourceLoadResult.Unavailable
        } catch (error: TimeoutException) {
            future.cancel(true)
            updateRemoteLoadProgress(RemoteLoadProgress::fetchFailed)
            if (!remoteBridgeActionsEnabled(documentGeneration) ||
                !remoteLifecycleActive || remoteSession !== session
            ) {
                return RemoteResourceLoadResult.Cancelled
            }
            handleRemoteFailure(
                E2eTransportException(
                    "Remote UI resource request timed out.",
                    failureKind = E2eTransportFailureKind.NETWORK,
                ),
                session,
            )
            RemoteResourceLoadResult.Unavailable
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            RemoteResourceLoadResult.Cancelled
        }
    }

    fun requestRemoteHttp(
        documentGeneration: Long,
        requestId: String,
        method: String,
        path: String,
        bodyJson: String?,
    ) {
        if (!remoteBridgeActionsEnabled(documentGeneration)) return
        if (!validBridgeId(requestId) || path.length > MAX_REMOTE_PATH_LENGTH ||
            !remoteHttpBodyWithinLimit(bodyJson)
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
        val ticket = remoteHttpRequests.register(requestId)
        if (ticket == null) {
            emitHttpError(requestId, "Remote request id is already active.")
            return
        }
        val connectionGeneration = remoteConnectionGeneration.get()
        try {
            remoteExecutor.execute {
                var resumeAttempt: RemoteHttpResumeTracker.Attempt? = null
                var retainForResume = false
                try {
                    if (!remoteHttpRequestIsCurrent(ticket, session, connectionGeneration)) {
                        return@execute
                    }
                    val currentResumeAttempt = remoteHttpResumeTracker.begin(
                        requestId,
                        session,
                        connectionGeneration,
                    )
                    if (currentResumeAttempt == null) {
                        emitHttpError(requestId, "Secure Remote request is already resuming.")
                        return@execute
                    }
                    resumeAttempt = currentResumeAttempt
                    val response = e2eRemoteClient.rpc(
                        session,
                        JSONObject()
                            .put("kind", "http")
                            .put("method", method.uppercase())
                            .put("path", path)
                            .put("body", body ?: JSONObject.NULL),
                    )
                    val normalizedResponse = normalizeHttpResponse(response)
                    if (remoteHttpRequestIsCurrent(ticket, session, connectionGeneration)) {
                        emitHttpResponse(requestId, normalizedResponse)
                    } else if (remoteHttpRequestCanResume(currentResumeAttempt)) {
                        retainForResume = remoteHttpResumeTracker.retain(
                            currentResumeAttempt,
                            normalizedResponse,
                        )
                    }
                } catch (_: E2eSessionSuspendedException) {
                    resumeAttempt?.let { attempt ->
                        if (remoteHttpRequestCanResume(attempt)) {
                            retainForResume = remoteHttpResumeTracker.retain(attempt)
                        }
                    }
                } catch (error: Throwable) {
                    if (remoteHttpRequestIsCurrent(ticket, session, connectionGeneration)) {
                        emitHttpError(requestId, remoteErrorMessage(error))
                    }
                    handleRemoteFailure(error, session)
                } finally {
                    remoteHttpRequests.complete(ticket)
                    if (!retainForResume) resumeAttempt?.let(remoteHttpResumeTracker::finish)
                }
            }
        } catch (_: RejectedExecutionException) {
            if (remoteHttpRequests.complete(ticket)) {
                emitHttpError(requestId, "Secure session is unavailable.")
            }
        }
    }

    fun cancelRemoteHttp(documentGeneration: Long, requestId: String) {
        if (!remoteBridgeActionsEnabled(documentGeneration)) return
        if (validBridgeId(requestId)) {
            remoteHttpRequests.cancel(requestId)
            remoteHttpResumeTracker.cancel(requestId)
        }
    }

    private fun remoteHttpRequestIsCurrent(
        ticket: RemoteHttpRequestRegistry.Ticket,
        session: RemoteSession,
        connectionGeneration: Long,
    ): Boolean = remoteHttpRequests.isCurrent(ticket) &&
        remoteLifecycleActive && remoteSession === session &&
        remoteConnectionGeneration.get() == connectionGeneration

    private fun remoteHttpRequestCanResume(
        attempt: RemoteHttpResumeTracker.Attempt,
    ): Boolean = remoteSession === attempt.session &&
        remoteConnectionGeneration.get() != attempt.generation

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
                if (!RemoteOutputOpen.hasAcceptedKeys(message)) {
                    emitOutputBridgeClose(replyProxy, streamId, "Invalid output request.", true)
                    return
                }
                val terminalId = message.optString("terminalId")
                val leaseId = message.optString("leaseId")
                val historyKib = RemoteOutputOpen.historyKib(message)
                val session = remoteSession
                if (!validRemoteIdentifier(terminalId) || !validRemoteIdentifier(leaseId) ||
                    session == null || !remoteLifecycleActive
                ) {
                    emitOutputBridgeClose(replyProxy, streamId, "Secure session is unavailable.", true)
                    return
                }
                val token = remoteOutputReservations.reserve(streamId)
                if (token == null) {
                    emitOutputBridgeClose(
                        replyProxy,
                        streamId,
                        "Secure output stream limit was exceeded.",
                        true,
                    )
                    return
                }
                val entry = RemoteOutputBridgeEntry(
                    token = token,
                    generation = remoteConnectionGeneration.get(),
                    reply = replyProxy,
                )
                remoteOutputEntries[streamId] = entry
                try {
                    remoteExecutor.execute {
                        var socket: E2eOutputSocket? = null
                        try {
                            val created = E2eOutputSocket(
                                streamId,
                                terminalId,
                                leaseId,
                                session,
                                outputHttpClient,
                                this,
                                historyKib,
                            )
                            socket = created
                            if (!remoteOutputEntryIsCurrent(streamId, entry, session)
                            ) {
                                created.disconnect()
                                removeRemoteOutputEntry(streamId, entry)
                                return@execute
                            }
                            if (remoteOutputStreams.putIfAbsent(streamId, created) != null) {
                                created.disconnect()
                                removeRemoteOutputEntry(streamId, entry)
                                return@execute
                            }
                            if (!remoteOutputEntryIsCurrent(streamId, entry, session)) {
                                remoteOutputStreams.remove(streamId, created)
                                created.disconnect()
                                removeRemoteOutputEntry(streamId, entry)
                                return@execute
                            }
                            created.connect()
                        } catch (error: Throwable) {
                            socket?.let { remoteOutputStreams.remove(streamId, it) }
                            if (removeRemoteOutputEntry(streamId, entry)) {
                                emitOutputBridgeClose(
                                    replyProxy,
                                    streamId,
                                    remoteErrorMessage(error),
                                    true,
                                )
                            }
                            val failureKind = (error as? E2eTransportException)?.failureKind
                            if (failureKind != null) {
                                requestCloudSessionFallback(session, failureKind)
                            }
                        }
                    }
                } catch (_: RejectedExecutionException) {
                    if (removeRemoteOutputEntry(streamId, entry)) {
                        emitOutputBridgeClose(
                            replyProxy,
                            streamId,
                            "Secure session is unavailable.",
                            true,
                        )
                    }
                }
            }
            "ack" -> if (jsonHasExactKeys(message, setOf("type", "streamId"))) {
                remoteOutputStreams[streamId]?.acknowledge()
            }
            "close" -> if (jsonHasExactKeys(message, setOf("type", "streamId"))) {
                remoteOutputEntries.remove(streamId)?.let { entry ->
                    remoteOutputReservations.release(streamId, entry.token)
                }
                remoteOutputStreams.remove(streamId)?.disconnect()
            }
        }
    }

    private fun remoteOutputEntryIsCurrent(
        streamId: String,
        entry: RemoteOutputBridgeEntry,
        session: RemoteSession,
    ): Boolean = remoteLifecycleActive &&
        remoteSession === session &&
        remoteConnectionGeneration.get() == entry.generation &&
        remoteOutputEntries[streamId] === entry &&
        remoteOutputReservations.isCurrent(streamId, entry.token)

    private fun removeRemoteOutputEntry(
        streamId: String,
        entry: RemoteOutputBridgeEntry,
    ): Boolean {
        if (!remoteOutputEntries.remove(streamId, entry)) return false
        remoteOutputReservations.release(streamId, entry.token)
        return true
    }

    override fun onOpen(socket: E2eOutputSocket, streamId: String) {
        val entry = remoteOutputEntries[streamId] ?: return
        if (remoteOutputStreams[streamId] !== socket) return
        emitOutputBridgeRecord(entry.reply, streamId, OUTPUT_BRIDGE_OPEN, ByteArray(0))
    }

    override fun onRecord(socket: E2eOutputSocket, streamId: String, plaintext: ByteArray) {
        val entry = remoteOutputEntries[streamId] ?: return
        if (remoteOutputStreams[streamId] !== socket) return
        emitOutputBridgeRecord(entry.reply, streamId, OUTPUT_BRIDGE_MESSAGE, plaintext)
    }

    override fun onClose(
        socket: E2eOutputSocket,
        streamId: String,
        reason: String,
        isError: Boolean,
        failureKind: E2eTransportFailureKind?,
    ) {
        if (!remoteOutputStreams.remove(streamId, socket)) return
        val entry = remoteOutputEntries[streamId] ?: return
        if (!removeRemoteOutputEntry(streamId, entry)) return
        emitOutputBridgeClose(entry.reply, streamId, reason, isError)
        if (failureKind != null) {
            requestCloudSessionFallback(socket.remoteSession(), failureKind)
        }
    }

    private fun clearRemoteOutputStreams() {
        remoteOutputEntries.clear()
        remoteOutputReservations.clear()
        remoteOutputStreams.values.toList().forEach(E2eOutputSocket::disconnect)
        remoteOutputStreams.clear()
    }

    private fun suspendRemoteSessionForBackground() {
        remoteConnectionGeneration.incrementAndGet()
        remoteHttpRequests.clear()
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
            // Session key expired in the background. Instead of dropping to the
            // dashboard, keep the selected PC and re-open the secure session in
            // place: connectRemote() re-decrypts the seed (biometric prompt),
            // re-establishes, and showRemoteSurface() reattaches via the desktop
            // checkpoint. A canceled/failed re-auth falls back to the dashboard.
            closeRemoteSession()
            if (canReauthenticateExpiredRemote()) {
                showCloudMessage("보안 세션이 잠겨 다시 인증이 필요합니다.")
                connectRemote(reauthFallback = { showCloudDashboard() })
            } else {
                showCloudDashboard()
                showCloudMessage("15분 동안 사용하지 않아 보안 세션이 잠겼습니다.")
            }
            return
        }
        val connectionGeneration = remoteConnectionGeneration.incrementAndGet()
        remoteConnecting = true
        try {
            remoteExecutor.execute {
                val result = runCatching {
                    val resumedResponse = e2eRemoteClient.resumePending(session)
                        ?.let(::normalizeHttpResponse)
                    remoteHttpResumeTracker.captureResumedResponse(session, resumedResponse)
                    ensureRemoteResumeCurrent(session, connectionGeneration)
                }
                runOnUiThread {
                    val stale = remoteConnectionGeneration.get() != connectionGeneration ||
                        !remoteLifecycleActive || remoteSession !== session || isDestroyed
                    if (stale) return@runOnUiThread
                    remoteConnecting = false
                    result.fold(
                        onSuccess = {
                            val completion = remoteHttpResumeTracker.take(session)
                            resumeRemoteSurfaceAfterBackground(
                                session,
                                connectionGeneration,
                                completion,
                            )
                        },
                        onFailure = failure@{ error ->
                            val failureKind = (error as? E2eTransportException)?.failureKind
                            if (failureKind != null &&
                                requestCloudSessionFallback(session, failureKind)
                            ) {
                                return@failure
                            }
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

    fun disconnectRemoteFromWeb(documentGeneration: Long) {
        runOnUiThread {
            if (remoteBridgeActionsEnabled(documentGeneration)) disconnectRemote()
        }
    }

    /**
     * Aborts an in-progress connection: the biometric/handshake phase on the
     * pairing surface and the resource-streaming phase behind the loading
     * overlay. The active generation bump makes the in-flight open observe
     * cancellation; an already-established idle session is left to
     * disconnect/expiry instead.
     */
    fun cancelRemoteConnection() {
        val opening = remoteConnecting || remoteOpeningSession != null
        val streamingRemoteUi = remoteSession != null &&
            ::remoteLoadingOverlay.isInitialized &&
            remoteLoadingOverlay.visibility == View.VISIBLE
        if (!opening && !streamingRemoteUi) return
        // A pending CONNECT decryption must die with the attempt — a late
        // biometric success would otherwise revive the cancelled connection.
        if (pendingDecryptionPurpose == DecryptionPurpose.CONNECT) {
            pendingDecryption?.close()
            pendingDecryption = null
            pendingDecryptionPurpose = null
        }
        closeRemoteSession()
        hideRemoteLoadingOverlay()
        if (visibleWebSurface == VisibleWebSurface.REMOTE) {
            showPairingSurface()
        }
        notifyPairingChanged(notice = "보안 세션 연결을 취소했습니다.")
    }

    private fun closeRemoteSession() {
        remoteConnectionGeneration.incrementAndGet()
        remoteHttpRequests.clear()
        remoteHttpResumeTracker.clear()
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
        val failureKind = (error as? E2eTransportException)?.failureKind
        if (failureKind != null && requestCloudSessionFallback(failedSession, failureKind)) return
        closeRemoteSession()
        runOnUiThread {
            if (::webView.isInitialized && !isDestroyed) showCloudDashboard()
        }
    }

    private fun requestCloudSessionFallback(
        failedSession: RemoteSession,
        failureKind: E2eTransportFailureKind,
    ): Boolean {
        if (!E2eTransportPolicy.shouldFallbackActiveSession(
                failedSession.transport.kind,
                failureKind,
            )
        ) {
            return false
        }
        runOnUiThread {
            if (remoteSession !== failedSession || !remoteLifecycleActive || isDestroyed) {
                return@runOnUiThread
            }
            cloudFallbackActive = true
            closeRemoteSession()
            showPairingSurface()
            showCloudMessage("Tailscale 연결이 끊겨 Cloud 종단간 암호화로 다시 연결합니다.")
            connectRemote()
        }
        return true
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
            remoteResourceCache.clear(instanceId)
            vault.clear(instanceId)
            notifyPairingChanged(notice = "페어링을 해제했습니다.")
        } catch (_: Exception) {
            notifyPairingChanged(error = "페어링 정보를 삭제하지 못했습니다.")
        }
    }

    private fun hasPendingCryptoOperation(): Boolean =
        pendingPairing != null || pendingDecryption != null || pairingAckInFlight || remoteConnecting

    /**
     * Every step the pairing sheet can be waiting on. The sheet turns this into
     * its notice spinner, so "an action is refused because something is running"
     * and "the sheet says something is running" cannot disagree.
     */
    private fun pairingOperationInProgress(): Boolean =
        scanInFlight || hasPendingCryptoOperation()

    /** Native pairing surfaces restore disabled actions from each published state update. */
    private fun busyOperationMessage(): String = when {
        scanInFlight -> "QR 스캔이 진행 중입니다."
        pendingPairing != null || pendingDecryption != null ->
            "생체 인증을 마치거나 취소한 뒤 다시 시도하세요."
        pairingAckInFlight -> "데스크톱 페어링 확인을 진행하고 있습니다."
        remoteConnecting || remoteOpeningSession != null -> "보안 세션을 여는 중입니다."
        else -> "이전 작업이 끝난 뒤 다시 시도하세요."
    }

    private fun pairingOperationError(error: Exception): String = when {
        error is PairingKeyInvalidatedException && error.recoverySucceeded ->
            "생체 정보가 변경되어 기존 모든 PC 페어링을 폐기했습니다. 새 키로 다시 페어링하세요."
        error is PairingKeyInvalidatedException ->
            "생체 정보가 변경됐지만 무효화된 키를 정리하지 못했습니다. 다시 시도하세요."
        else -> "페어링 키를 안전하게 처리하지 못했습니다."
    }

    fun notifyPairingChanged(
        error: String? = null,
        notice: String? = null,
    ) {
        runOnUiThread {
            if (isDestroyed) return@runOnUiThread
            when (visibleWebSurface) {
                VisibleWebSurface.PAIRING -> if (::pairingSheet.isInitialized) {
                    pairingSheet.render(pairingSheetState(error, notice))
                }
                VisibleWebSurface.CONNECTION_SETTINGS -> {
                    val instanceId = connectionSettingsInstanceId ?: return@runOnUiThread
                    if (::connectionSettingsDialog.isInitialized) {
                        connectionSettingsDialog.render(
                            connectionSettingsState(instanceId, error, notice),
                        )
                    }
                }
                VisibleWebSurface.CLOUD,
                VisibleWebSurface.REMOTE,
                -> Unit
            }
        }
    }

    private fun connectionSettingsState(
        instanceId: String,
        error: String? = null,
        notice: String? = null,
    ): ConnectionSettingsState {
        if (debugConnectionSettingsPreviewActive) {
            return ConnectionSettingsState(
                instanceId = DEBUG_PAIRING_INSTANCE_ID,
                pairing = PairingSheetItem(
                    endpoint = "https://app.laymux.com/",
                    instanceId = DEBUG_PAIRING_INSTANCE_ID,
                    confirmedAtEpochSeconds = 1L,
                    label = "미리보기 PC",
                ),
                protectionPolicy = PairingProtectionPolicy.KEYSTORE_ONLY,
                biometricAvailability = BiometricAvailability.AVAILABLE,
                error = error,
                notice = notice,
                update = updateController.state(),
            )
        }
        return try {
            val pairing = vault.loadMetadata()
                .firstOrNull { it.instanceId == instanceId }
                ?.let { metadata ->
                    PairingSheetItem(
                        endpoint = metadata.endpoint,
                        instanceId = metadata.instanceId,
                        confirmedAtEpochSeconds = metadata.confirmedAtEpochSeconds,
                        label = metadata.label,
                    )
                }
            ConnectionSettingsState(
                instanceId = instanceId,
                pairing = pairing,
                protectionPolicy = vault.protectionPolicy(),
                biometricAvailability = biometricAvailability(),
                error = error,
                notice = notice,
                update = updateController.state(),
            )
        } catch (_: Exception) {
            ConnectionSettingsState(
                instanceId = instanceId,
                pairing = null,
                protectionPolicy = PairingProtectionPolicy.BIOMETRIC,
                biometricAvailability = biometricAvailability(),
                error = error ?: "이 PC의 연결 설정을 읽지 못했습니다.",
                notice = notice,
                update = updateController.state(),
            )
        }
    }

    private fun pairingSheetState(
        error: String? = null,
        notice: String? = null,
    ): PairingSheetState {
        if (debugPairingPreviewActive) {
            return PairingSheetState(
                selectedInstanceId = DEBUG_PAIRING_INSTANCE_ID,
                pairings = listOf(
                    PairingSheetItem(
                        endpoint = "https://app.laymux.com/",
                        instanceId = DEBUG_PAIRING_INSTANCE_ID,
                        confirmedAtEpochSeconds = 1L,
                        label = "미리보기 PC",
                    ),
                ),
                protectionPolicy = PairingProtectionPolicy.KEYSTORE_ONLY,
                biometricAvailability = BiometricAvailability.AVAILABLE,
                remoteConnected = false,
                remoteConnecting = false,
                busy = false,
                error = error,
                notice = notice,
            )
        }
        return try {
            PairingSheetState(
                selectedInstanceId = selectedCloudInstanceId,
                pairings = vault.loadMetadata().map { metadata ->
                    PairingSheetItem(
                        endpoint = metadata.endpoint,
                        instanceId = metadata.instanceId,
                        confirmedAtEpochSeconds = metadata.confirmedAtEpochSeconds,
                        label = metadata.label,
                    )
                },
                protectionPolicy = vault.protectionPolicy(),
                biometricAvailability = biometricAvailability(),
                remoteConnected = remoteConnected(),
                remoteConnecting = remoteConnecting(),
                busy = pairingOperationInProgress(),
                error = error,
                notice = notice,
            )
        } catch (_: Exception) {
            PairingSheetState(
                selectedInstanceId = selectedCloudInstanceId,
                pairings = emptyList(),
                protectionPolicy = PairingProtectionPolicy.BIOMETRIC,
                biometricAvailability = biometricAvailability(),
                remoteConnected = false,
                remoteConnecting = remoteConnecting(),
                busy = pairingOperationInProgress(),
                error = error ?: "저장된 페어링 정보를 읽지 못했습니다.",
                notice = notice,
            )
        }
    }

    override fun onStart() {
        super.onStart()
        remoteLifecycleActive = true
        // 콜드 스타트와 전면 복귀가 유일한 트리거다. 6시간 throttle 은 컨트롤러가
        // 지키므로 여기서는 조건 없이 부른다 (ADR-0197).
        updateController.check(UpdateSchedule.Trigger.PERIODIC)
        resumeRemoteSessionAfterBackground()
        // A sign-in redirect caught while the OS browser was frontmost waits
        // here: the E2E session resumes above, and the Remote document
        // retries the forward if the transport needs another moment.
        flushPendingOauthCallback()
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
        if (scannerModuleListener != null) {
            scanInFlight = false
            clearScannerModuleListener()
        }
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
        revokeRemoteDocument()
        cancelPendingFileChooser()
        if (::pairingSheet.isInitialized) pairingSheet.dismiss()
        if (::connectionSettingsDialog.isInitialized) connectionSettingsDialog.dismiss()
        policyDialog?.dismiss()
        policyDialog = null
        remoteJsDialogs?.dismissActive()
        remoteJsDialogs = null
        cloudJsDialogs?.dismissActive()
        cloudJsDialogs = null
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
        // 확인 결과를 옮길 화면이 사라졌으므로 구독을 먼저 끊는다. `runOnMain`
        // 가드와 겹치지만, 소유권이 여기서 끝난다는 것을 코드로 남긴다.
        if (::updateController.isInitialized) updateController.onStateChanged = null
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
        private const val REMOTE_DISMISS_TOP_LAYER_SCRIPT =
            "(function(){var ui=window.laymuxRemoteUi;" +
                "return !!ui&&typeof ui.dismissTopLayer==='function'&&" +
                "ui.dismissTopLayer()===true;})()"
        private const val MAX_REMOTE_PATH_LENGTH = 2_048
        private const val MAX_REMOTE_IDENTIFIER_LENGTH = 128
        private const val MAX_BRIDGE_ID_LENGTH = 64
        private const val DEBUG_PAIRING_SHEET_PREVIEW = "laymux.previewPairingSheet"
        private const val DEBUG_CONNECTION_SETTINGS_PREVIEW =
            "laymux.previewConnectionSettings"
        private const val DEBUG_PAIRING_INSTANCE_ID = "preview-desktop"
        private const val DEBUG_UPDATE_BANNER_PREVIEW = "laymux.previewUpdateBanner"
        private const val DEBUG_UPDATE_PREVIEW_VERSION = "9.9.9"
    }

    private enum class DecryptionPurpose {
        VERIFY,
        CONFIRM,
        CONNECT,
    }

    private class RemoteOperationException(
        val status: Int,
        message: String,
    ) : Exception(message)

    private class RemoteConnectionCancelledException : Exception()
}
