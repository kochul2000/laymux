# 0144. Android E2E 기반은 서명된 로컬 웹 클라이언트와 네이티브 키 경계를 사용한다

- Status: Accepted
- Date: 2026-08-11
- Source: 사용자 요구("QR로 암호키를 교환하고 이후 종단 암호화를 적용할 최소 Android 앱을 모노리포에 추가", "생체 인증을 기본으로 활성화", "대응하는 Laymux 앱 기능도 구현") · [ADR-0013](0013-direct-remote-mode.md) · [ADR-0024](0024-cloud-native-wss-tunnel.md) · [ADR-0091](0091-remote-client-standalone-web-app-manifest.md) · architecture/api-contracts.md §13
- Extends: ADR-0013, ADR-0024, ADR-0091
- Superseded in part by: [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md) — APK가 Remote UI/xterm을 고정 소유한다는 결정에 한함. pairing·Keystore·native key 경계 결정은 유지한다.

## Context

현재 cloud remote는 relay가 `/remote/` HTML과 JavaScript를 브라우저에 전달하고 같은 경로로 터미널 API와 output stream을 중계한다. TLS는 네트워크 구간을 보호하지만 relay가 애플리케이션 평문을 볼 수 있고, 장기적으로 payload만 암호화하더라도 같은 relay가 실행 JavaScript를 매 접속마다 바꿀 수 있다. 서버가 공급한 코드에 복호화 키를 넘기면 침해된 서버가 키나 복호화 결과를 읽는 코드를 내려줄 수 있으므로, 서버와 독립된 코드 신뢰 기준이 없다.

QR로 서버 밖에서 키를 전달하려면 카메라 접근, 키의 OS 보호 저장, 설치 패키지 서명으로 고정되는 클라이언트 코드가 필요하다. OS 저장소만 사용하면 기기를 잠금 해제한 뒤 앱 프로세스가 별도 본인 확인 없이 seed를 사용할 수 있으므로, 사용자의 명시적 키 사용 의도를 확인할 정책도 필요하다. 기존 PWA는 설치 편의를 주지만 서버 공급 코드라는 신뢰 경계는 바꾸지 않는다. 반대로 완전한 네이티브 Android UI로 현재 Remote 터미널·내비게이션 표면을 다시 만들면 기능 중복과 유지 비용이 크다.

범위는 Android 프로젝트의 리포 위치, 하이브리드 코드 신뢰 경계, QR seed 계약, 양 endpoint의 seed 저장 소유권, 데스크톱의 QR 발급·폐기 UI다. 스캔 완료 ACK, relay frame 암호화, 키 파생·세션 회전, replay 방지, terminal API 전환과 iOS 앱은 비목표이며 후속 결정에서 완성한다. 이 단계만으로 기존 cloud/direct remote 트래픽이 E2E 암호화됐다고 표시하지 않는다.

## Decision

**Android 클라이언트는 `apps/android`의 독립 Gradle 앱으로 두고 APK에 서명된 로컬 웹 UI와 네이티브 키 경계를 사용하며, 데스크톱 Laymux는 cloud instance에 결합된 QR seed를 Rust에서 생성해 OS keyring에 저장하고 Remote Access 모달에서 QR로만 표시한다.**

- Android 앱은 데스크톱 Tauri workspace나 `src-tauri`의 mobile target이 아니다. PTY·OS integration 의존성을 mobile build에 끌어오지 않는 독립 앱 모듈이며, 루트 리포가 버전·문서·프로토콜 변경을 함께 소유한다.
- WebView main document와 script/style은 APK `assets`에서 `WebViewAssetLoader`의 HTTPS origin으로만 읽는다. 서버의 `/remote/` HTML/JavaScript를 main frame·iframe·동적 script로 실행하지 않으며 외부 navigation과 network subresource를 막는다. 앱 업데이트와 Android package signature가 실행 코드의 신뢰 기준이다.
- 네이티브 bridge는 `scanPairingQr`, 안전한 pairing metadata 조회, 생체 보호 설정, 키 보호 확인, pairing 삭제처럼 좁은 동작만 노출한다. QR secret 원문이나 Keystore wrapping key를 JavaScript로 반환하는 메서드는 두지 않는다. 향후 transport도 평문 키를 넘기기보다 native encrypt/decrypt·socket 경계를 우선한다.
- QR v1은 `laymux://pair/v1?endpoint=<encoded-origin>&instance=<id>&secret=<base64url>&label=<optional>`이다. `secret`은 padding 없는 base64url 32바이트 seed이고, `endpoint`는 query·fragment·userinfo가 없는 HTTPS origin이다. 개발 빌드만 loopback `http://127.0.0.1`/`http://[::1]` origin을 받을 수 있다. 필드 누락·중복·미등록 필드·버전 불일치는 fail closed한다.
- 앱은 한 시점에 pairing 하나만 저장한다. seed는 앱 전용 private storage에 AES-256-GCM ciphertext로 기록하고, wrapping key는 `AndroidKeyStore`에서 비추출 키로 생성한다. backup은 끈다. 표시 가능한 endpoint·instance·label은 암호문 envelope의 비밀이 아닌 metadata로 분리해 상태 조회 시 키를 복호화하지 않고 WebView에 전달한다.
- 기본 보호 정책은 강한 생체 인증(`BIOMETRIC_STRONG`)이다. wrapping key는 인증 유효시간 0초인 auth-per-use 키로 만들고 QR seed 저장과 이후 seed 사용 각각에 `BiometricPrompt.CryptoObject`가 승인한 동일 `Cipher`를 요구한다. PIN·패턴·기기 자격 증명으로 자동 대체하지 않으며, 생체 하드웨어가 없거나 강한 생체 정보가 등록되지 않았으면 보호된 pairing을 fail closed한다.
- 사용자는 경고를 확인하고 생체 보호를 명시적으로 끌 수 있다. 이 경우에만 별도 Keystore-only wrapping key를 사용한다. 보호 정책 변경은 기존 seed를 백그라운드에서 재포장하지 않고 pairing과 두 정책의 key alias를 삭제하므로 QR로 다시 pairing해야 한다. 생체 정보 등록 집합이 바뀌면 생체 wrapping key를 무효화하며 역시 해제 후 재pairing한다.
- QR 스캔은 camera permission을 앱에 직접 주지 않는 Google Code Scanner UI를 사용하고 QR 형식만 허용한다. 지원 최소 버전은 Android API 23이다.
- 데스크톱은 cloud pairing이 확정한 `cloudServerBaseUrl` HTTPS origin과 `cloudInstanceId`만 QR endpoint·instance로 사용한다. debug 빌드만 기존 QR 계약과 동일하게 loopback HTTP를 허용한다. UI가 전달한 임의 endpoint·instance로 QR을 만드는 IPC는 두지 않는다.
- 데스크톱 Rust는 OS CSPRNG로 seed 32바이트를 만들고 OS keyring service `laymux`(debug는 `laymux-dev`), account `android-pairing-v1`에 version·endpoint·instance와 함께 저장한다. 새 QR 발급은 기존 record를 교체하고 명시적 폐기는 record를 삭제한다. QR 원문과 seed는 Tauri IPC로 반환하지 않고 Rust가 만든 SVG와 비밀이 아닌 상태 metadata만 반환한다. 모달을 닫으면 SVG는 frontend runtime에서 사라지며 자동으로 다시 표시하지 않는다.
- QR 생성의 cloud identity 조회부터 keyring 저장까지, cloud identity 교체, cloud disconnect, 명시적 폐기는 하나의 desktop pairing lifecycle mutex로 직렬화한다. 락은 `AppState.remote_access`보다 먼저 획득하며, identity 폐기 뒤 진행 중이던 생성이 옛 seed를 다시 저장할 수 없다.
- 스캔 완료 ACK가 아직 없으므로 QR을 스캔 직후 자동 폐기됐다고 주장하지 않는다. 현재의 보안 수명은 새 QR 발급·명시적 폐기·cloud identity 폐기로 끝나며, 일회성 교환과 만료는 authenticated handshake를 정할 후속 ADR에서 완성한다.
- v1 QR seed는 후속 E2E 세션 키 파생의 입력일 뿐, 곧바로 Remote bearer token·cloud device token·controller lease를 대체하지 않는다. 방향별 key derivation, nonce/replay/rotation 정책, ciphertext relay envelope는 후속 ADR에서 함께 정한다.

## Alternatives Considered

- **기존 `/remote/`를 여는 얇은 WebView 앱.** 가장 빠르고 현재 UI를 그대로 쓰지만 서버가 실행 코드를 바꿀 수 있어 QR secret을 서버로부터 보호하지 못한다. E2E 신뢰 경계의 목적과 충돌한다.
- **기존 PWA에 Web Crypto와 QR 스캔만 추가.** 배포가 쉽지만 PWA 설치 후에도 기본 실행 코드는 서버 응답이며, service worker를 두지 않는 ADR-0091 경계도 바꿔야 한다. 서버 독립 코드 신뢰를 만들지 못한다.
- **Tauri Android target으로 기존 앱 전체를 빌드.** React 자산 재사용은 좋지만 현재 Rust backend는 PTY, Windows/Linux process, native dialog 등 데스크톱 책임을 포함한다. mobile 전용 조건부 컴파일과 backend 분리가 최소 셸보다 큰 선행 리팩터가 된다.
- **완전 네이티브 Kotlin UI와 terminal renderer.** 키 경계는 명확하지만 xterm 기반 Remote 표면을 중복 구현해야 한다. 네이티브 보안/transport와 로컬 웹 표시를 나누는 하이브리드보다 유지 비용이 크다.
- **Android Keystore에 QR seed 자체를 import.** 일부 기기·provider에서 raw AES import 지원과 hardware backing이 일관되지 않고, seed를 향후 HKDF 입력으로 읽어야 할 수 있다. 비추출 wrapping key로 seed ciphertext를 보호하는 방식이 호환성과 역할 분리가 낫다.
- **생체 인증을 기본 off 또는 기기 PIN fallback으로 제공.** 초기 진입 마찰은 줄지만 사용자가 보호 설정을 발견하기 전에는 앱 프로세스의 키 사용에 별도 승인이 없고, PIN fallback은 생체 사용 의도를 약화한다. 강한 생체 인증을 기본으로 두고 사용할 수 없는 기기에서만 경고가 있는 명시적 opt-out을 제공한다.
- **정책 변경 시 기존 seed를 즉시 재포장.** 생체 보호를 켤 때는 인증되지 않은 기존 key를 읽어야 하고 끌 때는 보호 강도를 조용히 낮출 위험이 있다. 내부 개발 단계에는 마이그레이션 호환성보다 삭제 후 QR 재pairing이라는 단순한 경계를 택한다.
- **데스크톱 frontend Web Crypto로 seed·QR 생성.** 구현은 단순하지만 원문 seed가 JavaScript state와 Tauri IPC 인자에 남고, OS keyring 저장 실패 전에 사용자가 QR을 스캔할 수 있다. Rust가 생성→QR 인코딩→keyring 저장을 한 작업으로 소유하고 SVG만 반환한다.
- **QR을 표시한 뒤 짧은 타이머로 자동 폐기.** 스캔 성공을 데스크톱이 인증해 알 방법이 없는 현재 계약에서는 Android만 seed를 저장하고 데스크톱은 버리는 불일치가 생긴다. ACK를 갖춘 후속 프로토콜 전에는 명시적 rotate/revoke만 제공한다.
- **Direct Remote의 HTTP host를 endpoint로 발급.** production Android가 요구하는 HTTPS origin을 깨고 LAN 공격면을 늘린다. 이미 transport 인증과 canonical origin을 가진 cloud pairing을 선행 조건으로 둔다.

## Consequences

- relay가 침해돼도 다음 앱 버전을 설치시키지 않는 한 실행 중인 UI 코드를 바꿔 QR 키를 탈취할 수 없다. 다만 OS·APK 자체 또는 앱 프로세스 침해는 이 결정의 방어 범위 밖이다.
- Remote UI가 당분간 두 구현으로 존재한다. 브라우저는 기존 8천 줄 self-hosted page를 계속 쓰고 Android는 pairing shell부터 시작한다. 후속 E2E transport를 넣기 전에 필요한 Remote 표시 코드를 빌드 가능한 공유 자산으로 추출해야 한다.
- Google Play services가 없는 Android 기기에서는 현재 scanner가 동작하지 않는다. 그 수요가 확인되면 bundled ML Kit/CameraX 또는 독립 QR scanner로 교체한다.
- Keystore wrapping은 at-rest 추출 난도를 높이고 기본 생체 gate는 정상 앱 경로의 매 key 사용을 승인받게 하지만, 인증 직후 seed 평문은 앱 프로세스 메모리에 잠시 존재한다. 사용 후 byte buffer를 지우고 로그·exception·WebView·backup에 싣지 않는 규칙을 유지한다. rooted OS·앱 프로세스 침해를 막는 경계는 아니다.
- 기본 정책 때문에 강한 생체 인증이 없는 기기는 바로 pairing할 수 없다. 사용자가 UI 경고를 읽고 opt-out해야 하며, 보호 정책 전환과 생체 등록 변경에는 재pairing 비용이 든다.
- 데스크톱은 cloud pairing 전에는 QR을 발급할 수 없다. seed가 OS keyring에 남는 동안 QR 자체는 일회용이라고 부를 수 없으며 사용자는 새 발급으로 rotate하거나 명시적으로 폐기해야 한다.
- 이번 단계의 자동 검증은 Android QR parser·보호 정책 JVM unit test, Keystore round-trip instrumentation test, 데스크톱 QR 계약·keyring lifecycle Rust test와 Remote Access UI test다. 실제 scanner·BiometricPrompt·WebView·양 endpoint 교환은 API 23 이상 실기 또는 emulator 검증이 추가로 필요하다.
- 재검토 조건은 iOS 지원, Google Play services 없는 배포, 여러 데스크톱 pairing, 기기 자격 증명 fallback 요구, 공유 Remote UI 추출, E2E frame/ratchet 프로토콜 결정이다.
