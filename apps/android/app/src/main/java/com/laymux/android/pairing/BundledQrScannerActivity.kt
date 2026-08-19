package com.laymux.android.pairing

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import androidx.annotation.StringRes
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.mlkit.vision.MlKitAnalyzer
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.fragment.app.FragmentActivity
import com.google.android.material.button.MaterialButton
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.laymux.android.R

/** App-owned offline QR scanner used only when Google Code Scanner cannot start. */
class BundledQrScannerActivity : FragmentActivity() {
    private lateinit var cameraController: LifecycleCameraController
    private lateinit var barcodeScanner: BarcodeScanner
    private var completed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            finishWithError(R.string.pairing_scanner_camera_permission_denied)
            return
        }

        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_bundled_qr_scanner)
        applyInsets(findViewById(R.id.bundled_scanner_root))
        findViewById<MaterialButton>(R.id.bundled_scanner_cancel).setOnClickListener {
            finishCanceled()
        }
        startCamera(findViewById(R.id.bundled_scanner_preview))
    }

    override fun onDestroy() {
        if (::cameraController.isInitialized) {
            cameraController.clearImageAnalysisAnalyzer()
        }
        if (::barcodeScanner.isInitialized) barcodeScanner.close()
        super.onDestroy()
    }

    private fun applyInsets(root: View) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safe = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout(),
            )
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        }
    }

    private fun startCamera(preview: PreviewView) {
        try {
            barcodeScanner = BarcodeScanning.getClient(
                BarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                    .build(),
            )
            cameraController = LifecycleCameraController(this).apply {
                cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA
                setImageAnalysisAnalyzer(
                    ContextCompat.getMainExecutor(this@BundledQrScannerActivity),
                    MlKitAnalyzer(
                        listOf(barcodeScanner),
                        ImageAnalysis.COORDINATE_SYSTEM_ORIGINAL,
                        ContextCompat.getMainExecutor(this@BundledQrScannerActivity),
                    ) { result ->
                        if (completed) return@MlKitAnalyzer
                        if (result?.getThrowable(barcodeScanner) != null) {
                            finishWithError(R.string.bundled_scanner_analysis_error)
                            return@MlKitAnalyzer
                        }
                        val raw = result?.getValue(barcodeScanner)
                            ?.firstOrNull()
                            ?.rawValue
                            ?: return@MlKitAnalyzer
                        finishWithPayload(raw)
                    },
                )
                bindToLifecycle(this@BundledQrScannerActivity)
            }
            preview.scaleType = PreviewView.ScaleType.FILL_CENTER
            preview.controller = cameraController
        } catch (_: Exception) {
            finishWithError(R.string.bundled_scanner_camera_error)
        }
    }

    private fun finishWithPayload(raw: String) {
        if (completed) return
        completed = true
        setResult(
            RESULT_OK,
            Intent().putExtra(EXTRA_PAIRING_PAYLOAD, raw),
        )
        finish()
    }

    private fun finishWithError(@StringRes message: Int) {
        if (completed) return
        completed = true
        setResult(
            RESULT_SCANNER_ERROR,
            Intent().putExtra(EXTRA_ERROR_MESSAGE, getString(message)),
        )
        finish()
    }

    private fun finishCanceled() {
        if (completed) return
        completed = true
        setResult(RESULT_CANCELED)
        finish()
    }

    companion object {
        const val EXTRA_PAIRING_PAYLOAD = "com.laymux.android.extra.PAIRING_PAYLOAD"
        const val EXTRA_ERROR_MESSAGE = "com.laymux.android.extra.SCANNER_ERROR"
        const val RESULT_SCANNER_ERROR = RESULT_FIRST_USER
    }
}
