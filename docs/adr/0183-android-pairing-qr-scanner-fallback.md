# 0183. Android pairing QR은 Play 모듈 선설치와 bundled scanner fallback을 사용한다

- Status: Proposed
- Date: 2026-08-19
- Source: 사용자 요구(Google Code Scanner 모듈을 진행률과 함께 선설치하고, 실패 시 CameraX + bundled ML Kit scanner 제공) · [architecture/api-contracts.md §13](../architecture/api-contracts.md) · [ADR-0144](0144-android-signed-hybrid-client-e2e-foundation.md) · [ADR-0145](0145-android-pairing-authenticated-one-time-ack.md) · [Google Code Scanner](https://developers.google.com/ml-kit/vision/barcode-scanning/code-scanner) · [Google Play services ModuleInstallClient](https://developers.google.com/android/guides/module-install-apis) · [ML Kit barcode scanning](https://developers.google.com/ml-kit/vision/barcode-scanning/android)
- Extends: [ADR-0144](0144-android-signed-hybrid-client-e2e-foundation.md)의 Google Code Scanner 전용 결정

## Context

ADR-0144는 앱이 카메라 권한을 직접 갖지 않는 Google Code Scanner를 pairing QR의 유일한 입력 표면으로 선택했다. 이 scanner의 `barcode_ui` 구현은 Google Play services가 필요할 때 내려받는 optional module이다. Play Store 설치 시 manifest metadata로 선다운로드를 요청할 수 있지만, ADB sideload·다운로드 실패·Play services 내부 오류가 있는 기기에서는 첫 scan이 camera UI를 열기 전에 실패한다. 현재 앱은 사용자가 인터넷 연결 뒤 다시 누르라는 오류만 표시하므로 module이 실제로 설치 중인지, 완료됐는지 알 수 없고 같은 기기에서 pairing을 완주할 보장도 없다.

Pairing payload에는 32바이트 seed가 포함되므로 일반 gallery picker·clipboard·WebView 입력으로 우회하면 QR-only 교환과 native key 경계를 약화한다. 반면 APK에 barcode model을 포함하고 앱 소유 camera surface에서 QR만 판독하면 relay나 WebView에 seed를 노출하지 않은 채 Google Play services 실패를 우회할 수 있다. 이 경로는 앱 자체의 `CAMERA` 권한과 camera lifecycle, 추가 APK 크기를 새로 소유해야 한다.

범위는 Android pairing scan의 scanner 선택, optional module 설치 UX, bundled fallback의 카메라 권한·수명과 QR 결과 전달이다. QR v2 schema, selected instance 검증, Keystore/생체 보호, ACK/E2E protocol, gallery 이미지 import와 범용 barcode 기능은 바꾸지 않는다.

## Decision

**Android pairing QR은 Google Code Scanner module을 명시적으로 확인·설치한 뒤 우선 사용하고, 그 경로를 준비하지 못하면 앱 권한의 CameraX + bundled ML Kit QR scanner로 자동 전환한다.**

1. 사용자가 scan을 시작하면 native scanner coordinator가 attempt generation을 만들고 `ModuleInstallClient.areModulesAvailable(GmsBarcodeScanner)`를 먼저 호출한다. module이 있으면 Google Code Scanner를 즉시 열고, 없으면 같은 attempt에서 urgent `installModules`를 한 번 요청한다. 설치가 완료되면 사용자 재입력 없이 scanner를 자동으로 연다. manifest의 `barcode_ui` install-time 요청도 유지한다.
2. module 확인·설치 중에는 pairing bottom sheet가 scan action을 비활성화하고 indeterminate 또는 downloaded/total 백분율 progress를 표시한다. listener의 completed/failed/canceled terminal state와 Activity 파괴에서 listener를 해제한다. Task와 Activity result는 attempt generation이 일치할 때만 상태를 바꾸며 이전 attempt의 늦은 callback은 무시한다.
3. module 확인 실패, urgent install 실패·취소, Google Code Scanner unavailable/Play services 구버전/pipeline 초기화 실패처럼 primary scanner를 준비하지 못한 경우 bundled fallback으로 자동 전환한다. 사용자가 Google scanner를 명시적으로 취소한 경우와 이미 scanner task가 진행 중이라는 상태 오류는 fallback camera를 갑자기 열지 않고 현재 attempt를 종료한다.
4. fallback은 exported되지 않은 앱 전용 Activity가 소유한다. CameraX preview와 `com.google.mlkit:barcode-scanning`의 bundled model은 후면 camera frame에서 QR 형식만 분석하고 첫 non-null raw value 하나만 결과로 반환한다. camera frame·QR 문자열은 파일, preference, 로그, WebView 또는 network에 기록하지 않으며 결과 전달 직후 analyzer·camera·detector를 닫는다. 오류·취소·Activity 종료도 같은 자원을 닫고 pairing action을 다시 활성화한다.
5. 앱은 fallback을 위해 manifest에 `CAMERA` 권한을 선언하되 Google scanner 정상 경로에서는 요청하지 않는다. fallback 진입 직전에만 runtime permission을 요청하고, 거부되면 설정에서 앱의 카메라 권한을 허용하라는 안내로 fail closed한다. 권한이 없거나 camera가 없다고 gallery/clipboard 입력으로 자동 완화하지 않는다.
6. 두 scanner의 raw result는 같은 `MainActivity.acceptPairingPayload` 경로로만 들어간다. 따라서 strict QR v2 parsing, 현재 Cloud dashboard에서 선택한 instance 일치, expiry, Keystore wrapping, 생체 gate와 ACK가 scanner 종류와 무관하게 동일하게 적용된다. scanner Activity와 module coordinator는 pairing seed를 해석하거나 보관하지 않는다.

## Alternatives Considered

- **Google Code Scanner 재시도 안내만 개선한다.** APK와 권한 증가는 없지만 sideload·GMS module 장애·Google Play services가 없는 기기에서는 pairing 자체가 계속 막힌다.
- **bundled scanner만 사용한다.** 오프라인 가용성은 단순하지만 모든 사용자에게 앱 카메라 권한과 custom camera UI를 요구한다. permissionless Google scanner가 정상인 기기에서는 더 좁은 권한 경계를 유지할 수 있으므로 primary+fallback을 택한다.
- **gallery에서 QR 이미지를 고른다.** camera 없는 환경도 지원하지만 pairing seed가 사진 파일·picker provider·백업에 남을 수 있고 QR-only 실시간 교환의 노출 범위를 넓힌다. 이번 fallback에는 포함하지 않는다.
- **WebView에서 `getUserMedia`로 스캔한다.** pairing UI와 key boundary를 native가 소유한다는 ADR-0144/0178에 어긋나고 camera permission과 QR secret을 server-owned 또는 WebView JavaScript 문맥에 노출한다.
- **module install을 앱 시작 시 항상 수행한다.** scan 전에 준비될 가능성은 높지만 pairing을 쓰지 않는 사용자에게도 network/module 작업을 시작한다. manifest prefetch는 유지하되 명시적 진행률과 urgent install은 사용자의 scan intent 뒤에만 수행한다.

## Consequences

- Google scanner가 정상인 기기는 기존 permissionless UI를 유지하면서 첫 scan 전에 실제 module 준비 상태와 진행률을 알 수 있다. 설치 완료는 자동 재시도로 이어진다.
- Google Play services 또는 network가 실패해도 APK 설치와 앱 camera permission만 있으면 bundled model로 즉시 QR을 판독할 수 있다. bundled barcode model은 공식 문서 기준 APK를 약 2.4 MiB 늘리고 CameraX artifacts의 추가 크기도 든다.
- 앱이 `CAMERA` 위험 권한과 custom preview Activity를 새로 소유한다. 권한은 fallback에서만 요청하고 camera resource는 Activity lifecycle에 묶어 background·취소·destroy에서 닫아야 한다.
- 자동 검증은 scanner state machine의 generation/전환/progress, pairing action 비활성화, permission 결과와 Activity result 계약을 JVM test로 고정하고 Android build/lint로 manifest·resource·CameraX 결합을 확인한다. 실기에서는 module 보유, module 설치, 설치 실패→권한→bundled scan, 권한 거부, QR→생체→ACK를 각각 확인한다.
- Google Code Scanner가 bundled 또는 안정적인 필수 구성요소로 바뀌거나 CameraX/ML Kit가 API 23을 지원하지 않게 되면 이 이중 경로를 재검토한다.
