# Laymux Android

기존 Laymux Cloud landing/dashboard에서 로그인하고 자기 PC를 선택한 뒤, 사용자 PC에 설치된
Laymux가 제공하는 Remote UI를 실행하는 얇은 E2E wrapper다. Cloud WebView에는 Google login과
instance 선택·연결 설정 진입 bridge만 있고, 네이티브 Material pairing sheet와 Kotlin 계층이 QR 스캔·명시적 clipboard 붙여넣기, Android Keystore,
생체 인증과 암호화 transport를 담당한다. APK에는 pairing용 웹 문서를 포함하지 않는다. Remote
문서·자산은 PC Laymux에서 E2E로 받아 검증한 뒤 WebView 전용 synthetic HTTPS origin에 제공한다.
설계 정본은 [ADR-0144](../../docs/adr/0144-android-signed-hybrid-client-e2e-foundation.md),
[ADR-0145](../../docs/adr/0145-android-pairing-authenticated-one-time-ack.md)와
[ADR-0146](../../docs/adr/0146-android-e2e-session-and-encrypted-remote-rpc.md),
[ADR-0149](../../docs/adr/0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md),
[ADR-0154](../../docs/adr/0154-android-multi-instance-pairing-vault.md),
[ADR-0159](../../docs/adr/0159-android-e2e-websocket-output-transport.md),
[ADR-0160](../../docs/adr/0160-android-e2e-tailscale-direct-transport.md),
[ADR-0163](../../docs/adr/0163-android-foreground-preserves-remote-document.md),
[ADR-0178](../../docs/adr/0178-android-pairing-native-material-bottom-sheet.md),
[ADR-0179](../../docs/adr/0179-android-connection-settings-from-dashboard-menu.md),
[Remote UI API §13.0](../../docs/architecture/api-contracts.md)을 본다.

현재 범위는 다음과 같다.

- 기존 Cloud landing/dashboard와 HttpOnly account session
- Android Credential Manager의 Sign in with Google ID token + Cloud session-bound single-use nonce 검증
- dashboard에서 선택한 PC instance와 저장/스캔한 E2E pairing instance 일치 검증
- instance별 다중 pairing 저장·자동 선택과 dashboard `…` 연결 설정의 개별 확인·삭제
- 5분 뒤 만료되는 `laymux://pair/v2` 초대의 QR 스캔 또는 명시적 clipboard 붙여넣기 검증
- 32바이트 pairing seed의 AES-256-GCM wrapping 저장
- 기본 auth-per-use 강한 생체 인증과 경고가 있는 명시적 Keystore-only opt-out
- exact Cloud HTTPS origin만 허용하는 account WebView와 AEAD PC 자산만 허용하는 secure WebView의 분리
- PC 선택 뒤 실제 Cloud dashboard는 하위 WebView로 유지하고, 입력·접근성·Cloud bridge가 비활성인 상태에서 연결 action 전용 네이티브 Material pairing bottom sheet를 위에 표시
- Android dashboard의 PC별 `…` 메뉴에서 별도 native 연결 설정 dialog로 진입
- relay를 통과하는 상호 HMAC scan ACK와 동일 nonce 재시도
- PC별 pending/confirmed 상태 확인·교체·보호 검증·삭제 UI
- 생체 승인 뒤 사용 중에는 유지되고 foreground/background 모두 15분 비활성 시 폐기되는 방향별 HKDF/AES-256-GCM session key
- relay에는 ciphertext만 보이는 PC Remote resource·HTTP와 native WebSocket 기반 V1 output bridge
- Cloud presence의 검증된 Tailscale literal-IP URL이 있으면 고정 Direct E2E route를 우선하고, 최초·열린 session의 socket 네트워크 실패에만 기존 session을 폐기한 뒤 새 Cloud E2E session으로 fallback. runtime 전환은 vault 보호 정책에 따라 생체 인증을 다시 요구할 수 있음
- 일시적 네트워크 실패에는 같은 pending ciphertext만 15분 비활성 deadline 안에서 재시도
- background에서 bridge traffic을 중지하고 현재 deadline까지 최대 15분간 key·pending ciphertext를 보존한 뒤 foreground에서 살아 있는 PC Remote 문서는 유지한 채 HTTP/output transport만 복원(호환되지 않는 문서는 다시 적재)

데스크톱 Laymux의 Remote Access 모달은 cloud pairing 뒤 같은 초대를 QR과 복사 action으로 발급·회전·폐기하고, 첫 Android
client nonce의 ACK를 확인한다. 이후 Android native 계층과 desktop은 같은 seed에서 방향별 session
key를 파생해 Remote UI와 terminal payload를 종단 암호화한다. control/resource는 순차 AEAD RPC를,
terminal output은 stream별 AEAD WebSocket과 origin 제한 binary WebMessage bridge를 사용하며 성공한
RPC마다 15분 비활성 deadline을 갱신한다. terminal 선택·navigation·입출력 UX는 APK가 복제하지 않고 PC가 배포한 기존 Remote page가 소유한다. 기존 browser cloud/direct Remote는 호환을
위한 별도 평문 경로이므로 Android 앱의 열린 보안 session만 E2E로 표시한다.
Android Direct의 `http`/`ws`는 Tailscale WireGuard 구간 안에서만 사용하고, Remote payload는
Cloud 경로와 동일하게 pairing seed에서 파생한 AEAD key로 종단간 암호화한다. 임의
cleartext URL은 native transport에 전달할 수 없고 WebView의 HTTP navigation 차단도 그대로 유지한다.

## 빌드

JDK 17과 Android SDK 36이 필요하다. Android Studio에서 이 디렉터리를 프로젝트로 열거나 다음을
실행한다.

```powershell
cd apps/android
.\gradlew.bat :app:assembleDebug
```

APK는 `app/build/outputs/apk/debug/app-debug.apk`에 생성된다.

Cloud origin과 Google server Web client ID는 Gradle property 또는 환경 변수로 주입한다. Cloud
origin은 path가 없는 HTTPS origin이어야 한다. client ID가 비어 있으면 앱은 빌드되지만 native
Google login은 fail closed한다.

```powershell
$env:LAYMUX_CLOUD_BASE_URL='https://app.laymux.com'
$env:LAYMUX_GOOGLE_WEB_CLIENT_ID='<server-web-client-id>.apps.googleusercontent.com'
.\gradlew.bat :app:assembleDebug
```

## 배포 서명

공개 APK는 debug key를 사용하지 않는다. GitHub Releases APK와 Google Play가 사용자에게 전달하는
APK는 `com.laymux.android`의 같은 장기 앱 서명 키를 사용한다. Play App Signing에는 이 기존 키를
등록하고, Play에 AAB를 제출하는 업로드 키만 별도로 생성한다. 이 구성이어야 GitHub 설치본과 Play
설치본이 서로를 업데이트하면서 pairing·Keystore 데이터를 유지한다([ADR-0152](../../docs/adr/0152-android-cross-store-signing-and-release.md)).

GitHub `release` workflow는 다음 repository secret을 사용한다.

- `ANDROID_APP_SIGNING_KEYSTORE_BASE64`
- `ANDROID_APP_SIGNING_KEYSTORE_PASSWORD`
- `ANDROID_APP_SIGNING_KEY_ALIAS`
- `ANDROID_APP_SIGNING_KEY_PASSWORD`

공개 repository variable `ANDROID_APP_SIGNING_CERT_SHA256`은 기대 signer 인증서를 고정하고,
`ANDROID_GOOGLE_WEB_CLIENT_ID`는 production Credential Manager audience를 주입한다. workflow는 JVM
테스트와 minified release build 뒤 `apksigner` 검증을 통과한 universal APK와 SHA-256 checksum을
같은 GitHub Release에 첨부한다. 앱 서명 keystore와 비밀번호의 오프라인 복구본은 서로 분리해
보관하며 GitHub secret을 유일한 사본으로 사용하지 않는다. Play upload key/AAB workflow는 Play
Console 등록 뒤 별도로 연결한다.

Google Cloud Console에는 `com.laymux.android` Android OAuth client와 실제 debug/release signing
certificate SHA-1을 등록하고, 위 값에는 Cloud 서버가 검증하는 Web application client ID를 쓴다.
ID token은 앱 JavaScript나 WebView request에 전달되지 않고 별도 native HTTPS stack이 고정 Cloud
endpoint로 POST한다. 성공 응답의 bounded HttpOnly cookie만 Android cookie store로 넘긴다.

## 테스트

```powershell
# 페어링 초대·공통 암호 벡터·session state JVM 단위 테스트
.\gradlew.bat :app:testDebugUnitTest

# API 23+ emulator/실기에서 Keystore round-trip 테스트
.\gradlew.bat :app:connectedDebugAndroidTest
```

debug APK에서 네이티브 pairing sheet나 연결 설정 dialog만 결정적으로 띄워 gesture·back·접근성과 스크린샷을
검증하려면 다음 intent extra를 사용한다. release 빌드는 이 값을 무시한다.

```powershell
adb shell am start -n com.laymux.android/.MainActivity --ez laymux.previewPairingSheet true
adb shell am start -n com.laymux.android/.MainActivity --ez laymux.previewConnectionSettings true
```

앱은 생체 인증을 기본으로 켠다. PIN·패턴 fallback 없이 페어링 키를 저장하거나 사용할 때마다 강한
생체 인증을 요구한다. 강한 생체 인증을 쓸 수 없는 기기는 보호된 pairing을 막으며, 사용자가
경고를 확인해 설정을 끈 경우에만 앱 전용 Android Keystore 키만 사용한다. 이 상태에서는 pairing
화면의 `보호 설정 열기`가 dashboard와 분리된 native 연결 설정 dialog로 이동해 opt-out 절차를 표시한다. 보호 설정을
바꾸거나 생체 등록 정보가 변경되면 기존 키를 재포장하지 않고 다시 pairing해야 한다. API 28의
`androidx.biometric`도 내부 AppCompat dialog를 사용하므로 Activity theme은 AppCompat 계열을 유지한다.

Google Code Scanner는 Google Play services의 on-device scanner UI를 사용한다. 앱 자체는 camera
permission을 선언하지 않는다. 최초 실행에서 scanner module이 아직 설치되지 않았다면 인터넷에
연결한 채 module 준비를 기다린 뒤 QR 스캔을 다시 누르라고 안내한다. Google Play services가 오래된
경우에는 업데이트를, 카메라 권한이 거부된 경우에는 Google Play services의 권한 허용을 각각
안내한다. Google Play services가 없거나 카메라를 쓸 수 없으면 PC에서 `페어링 값 복사`를 누른 뒤
native pairing sheet의 `페어링 값 붙여넣기`를 사용한다. 앱은 사용자가 action을 누르기 전에 clipboard를
읽지 않으며, 붙여넣은 값도 QR과 같은 instance·만료·HMAC 검증을 통과해야 한다.
