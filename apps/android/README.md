# Laymux Android

서버가 내려주는 코드를 실행하지 않는 최소 하이브리드 원격 클라이언트다. APK에 포함된 로컬
HTML/CSS/JavaScript를 WebView로 표시하고 Kotlin 계층이 QR 스캔과 Android Keystore 저장을
담당한다. 설계 정본은 [ADR-0144](../../docs/adr/0144-android-signed-hybrid-client-e2e-foundation.md)와
[Remote UI API §13.0](../../docs/architecture/api-contracts.md)을 본다.

현재 범위는 다음과 같다.

- `laymux://pair/v1` QR 검증
- 32바이트 pairing seed의 AES-256-GCM wrapping 저장
- 기본 auth-per-use 강한 생체 인증과 경고가 있는 명시적 Keystore-only opt-out
- APK 로컬 자산만 허용하는 WebView와 비밀을 반환하지 않는 native bridge
- pairing 상태 확인·교체·보호 검증·삭제 UI

데스크톱 Laymux의 Remote Access 모달은 cloud pairing 뒤 QR을 발급·회전·폐기한다. 다만
scan ACK·자동 만료와 terminal data plane 암호화는 아직 구현하지 않았다. 이 앱을 빌드했다고
기존 cloud/direct remote 연결이 E2E로 바뀌지는 않는다.

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
# QR 계약 JVM 단위 테스트
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
