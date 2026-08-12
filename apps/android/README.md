# Laymux Android

서버가 내려주는 코드를 실행하지 않는 최소 하이브리드 원격 클라이언트다. APK에 포함된 로컬
HTML/CSS/JavaScript를 WebView로 표시하고 Kotlin 계층이 QR 스캔과 Android Keystore 저장을
담당한다. 설계 정본은 [ADR-0144](../../docs/adr/0144-android-signed-hybrid-client-e2e-foundation.md),
[ADR-0145](../../docs/adr/0145-android-pairing-authenticated-one-time-ack.md)와
[ADR-0146](../../docs/adr/0146-android-e2e-session-and-encrypted-remote-rpc.md),
[Remote UI API §13.0](../../docs/architecture/api-contracts.md)을 본다.

현재 범위는 다음과 같다.

- 5분 뒤 만료되는 `laymux://pair/v2` QR 검증
- 32바이트 pairing seed의 AES-256-GCM wrapping 저장
- 기본 auth-per-use 강한 생체 인증과 경고가 있는 명시적 Keystore-only opt-out
- APK 로컬 자산만 허용하는 WebView와 비밀을 반환하지 않는 native bridge
- relay를 통과하는 상호 HMAC scan ACK와 동일 nonce 재시도
- pending/confirmed 상태 확인·교체·보호 검증·삭제 UI
- 생체 승인 뒤 사용 중에는 유지되고 foreground/background 모두 15분 비활성 시 폐기되는 방향별 HKDF/AES-256-GCM session key
- relay에는 ciphertext만 보이는 terminal 목록·입력·resize·출력 polling
- 일시적 네트워크 실패에는 같은 pending ciphertext만 15분 비활성 deadline 안에서 재시도
- background에서 poll·heartbeat를 중지하고 최대 15분간 key·pending ciphertext를 보존한 뒤 foreground에서 lease·snapshot을 재획득하는 로컬 xterm UI

데스크톱 Laymux의 Remote Access 모달은 cloud pairing 뒤 QR을 발급·회전·폐기하고, 첫 Android
client nonce의 ACK를 확인한다. 이후 Android native 계층과 desktop은 같은 seed에서 방향별 session
key를 파생해 terminal payload를 종단 암호화하고 성공한 RPC마다 15분 비활성 deadline을 갱신한다. 기존 browser cloud/direct Remote는 호환을
위한 별도 평문 경로이므로 Android 앱의 열린 보안 session만 E2E로 표시한다.

## 빌드

JDK 17과 Android SDK 36이 필요하다. Android Studio에서 이 디렉터리를 프로젝트로 열거나 다음을
실행한다.

```powershell
cd apps/android
.\gradlew.bat :app:assembleDebug
```

APK는 `app/build/outputs/apk/debug/app-debug.apk`에 생성된다.

## 테스트

```powershell
# QR·공통 암호 벡터·session state JVM 단위 테스트
.\gradlew.bat :app:testDebugUnitTest

# API 23+ emulator/실기에서 Keystore round-trip 테스트
.\gradlew.bat :app:connectedDebugAndroidTest
```

앱은 생체 인증을 기본으로 켠다. PIN·패턴 fallback 없이 QR 키를 저장하거나 사용할 때마다 강한
생체 인증을 요구한다. 강한 생체 인증을 쓸 수 없는 기기는 보호된 pairing을 막으며, 사용자가
경고를 확인해 설정을 끈 경우에만 앱 전용 Android Keystore 키만 사용한다. 보호 설정을 바꾸거나
생체 등록 정보가 변경되면 기존 키를 재포장하지 않고 다시 pairing해야 한다.

Google Code Scanner는 Google Play services의 on-device scanner UI를 사용한다. 앱 자체는 camera
permission을 선언하지 않는다. Google Play services가 없는 기기 지원은 현재 범위 밖이다.
