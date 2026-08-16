package com.laymux.android.pairing

import com.google.mlkit.common.MlKitException

internal fun pairingScannerFailureMessage(errorCode: Int?): String = when (errorCode) {
    MlKitException.CODE_SCANNER_UNAVAILABLE ->
        "Google Play 스캐너 모듈을 준비 중입니다. 인터넷에 연결한 채 잠시 기다린 뒤 QR 스캔을 다시 누르세요."
    MlKitException.CODE_SCANNER_GOOGLE_PLAY_SERVICES_VERSION_TOO_OLD ->
        "QR 스캔을 사용하려면 Google Play 서비스를 업데이트한 뒤 다시 시도하세요."
    MlKitException.CODE_SCANNER_CAMERA_PERMISSION_NOT_GRANTED ->
        "Google Play 서비스의 카메라 권한을 허용한 뒤 QR 스캔을 다시 누르세요."
    MlKitException.CODE_SCANNER_TASK_IN_PROGRESS ->
        "QR 스캔이 이미 열려 있습니다. 스캐너를 닫은 뒤 다시 시도하세요."
    MlKitException.CODE_SCANNER_PIPELINE_INITIALIZATION_ERROR,
    MlKitException.CODE_SCANNER_PIPELINE_INFERENCE_ERROR,
    -> "QR 스캐너를 준비하지 못했습니다. 앱을 다시 열고 QR 스캔을 재시도하세요."
    else ->
        "QR 스캐너를 시작하지 못했습니다. 인터넷 연결을 확인하고 잠시 후 다시 시도하세요."
}
