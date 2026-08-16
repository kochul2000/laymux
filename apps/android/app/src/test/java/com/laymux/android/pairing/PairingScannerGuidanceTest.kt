package com.laymux.android.pairing

import com.google.mlkit.common.MlKitException
import org.junit.Assert.assertEquals
import org.junit.Test

class PairingScannerGuidanceTest {
    @Test
    fun unavailableScannerExplainsModulePreparationAndRetry() {
        assertEquals(
            "Google Play 스캐너 모듈을 준비 중입니다. 인터넷에 연결한 채 잠시 기다린 뒤 QR 스캔을 다시 누르세요.",
            pairingScannerFailureMessage(MlKitException.CODE_SCANNER_UNAVAILABLE),
        )
    }

    @Test
    fun outdatedPlayServicesExplainsTheRequiredUpdate() {
        assertEquals(
            "QR 스캔을 사용하려면 Google Play 서비스를 업데이트한 뒤 다시 시도하세요.",
            pairingScannerFailureMessage(
                MlKitException.CODE_SCANNER_GOOGLE_PLAY_SERVICES_VERSION_TOO_OLD,
            ),
        )
    }

    @Test
    fun deniedCameraPermissionExplainsWherePermissionIsNeeded() {
        assertEquals(
            "Google Play 서비스의 카메라 권한을 허용한 뒤 QR 스캔을 다시 누르세요.",
            pairingScannerFailureMessage(
                MlKitException.CODE_SCANNER_CAMERA_PERMISSION_NOT_GRANTED,
            ),
        )
    }

    @Test
    fun unknownFailureKeepsAnActionableRetry() {
        assertEquals(
            "QR 스캐너를 시작하지 못했습니다. 인터넷 연결을 확인하고 잠시 후 다시 시도하세요.",
            pairingScannerFailureMessage(null),
        )
    }
}
