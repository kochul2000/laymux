# 0152. Android 앱 서명 키는 GitHub와 Play 배포에서 공유하고 업로드 키만 분리한다

- Status: Accepted
- Date: 2026-08-13
- Source: 사용자 요구("APK는 GitHub로 배포", "사이닝키는 동일하게 두고 업로드 키만 Google Play 쪽에 별도로") · [ADR-0144](0144-android-signed-hybrid-client-e2e-foundation.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md) · `apps/android/README.md`
- Extends: [ADR-0144](0144-android-signed-hybrid-client-e2e-foundation.md), [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)

## Context

Android 패키지 서명은 앱 업데이트의 신원이며 QR·Keystore·native E2E 경계를 배포된 코드에 결합한다. Laymux Android는 먼저 GitHub Releases의 sideload APK로 배포하고 나중에 Google Play에도 올릴 수 있어야 한다. 같은 `com.laymux.android`라도 GitHub와 Play 최종 설치본의 앱 서명 인증서가 다르면 Android가 서로를 업데이트로 인정하지 않고, 사용자는 앱 삭제와 pairing 재설정을 거쳐야 한다.

Play App Signing은 사용자에게 전달할 APK를 앱 서명 키로 서명하고, 개발자가 제출하는 AAB의 신원은 별도 업로드 키로 검증한다. 업로드 키는 재설정할 수 있지만 앱 서명 키는 기존 설치의 연속성을 결정하므로 더 강한 보관 정책이 필요하다. CI 편의를 위해 두 키를 혼용하거나 debug key를 최초 공개 APK에 사용하면 이후 배포 경로를 되돌리기 어렵다.

범위는 `com.laymux.android`의 GitHub APK 서명, 향후 Play App Signing 등록, Play 업로드 키 분리, release version과 CI 검증이다. Play Console 등록·스토어 설명·심사·자동 게시와 데스크톱 release version 정책은 비목표다.

## Decision

**Laymux Android의 GitHub APK와 Google Play 최종 설치본은 하나의 장기 앱 서명 키를 공유하고, Play 제출용 AAB만 별도의 교체 가능한 업로드 키로 서명한다.**

- 앱 서명 키는 `com.laymux.android`의 영구 배포 신원이다. 최초 GitHub release APK를 이 키로 서명하고 Play App Signing 등록 시 같은 키의 사본을 Google에 안전하게 이전한다. Google이 임의 생성한 다른 앱 서명 키를 선택하지 않는다.
- 앱 서명 키 원본과 비밀번호는 서로 분리된 오프라인 복구 매체에 보관한다. GitHub Actions secret의 base64 keystore와 비밀번호는 release 자동화를 위한 운영 사본이며 유일한 복구본이 아니다. 저장소·artifact·log에는 private key나 비밀번호를 넣지 않는다.
- Play 업로드 키는 앱 서명 키와 다른 RSA 키다. 향후 AAB build/submission workflow만 이 키를 사용한다. GitHub APK를 업로드 키로 서명하거나 앱 서명 키로 Play 제출 자동화를 일반화하지 않는다.
- Google OAuth의 Android package certificate 등록과 다른 서명 연동은 사용자에게 최종 전달되는 앱 서명 인증서 SHA-1/SHA-256을 사용한다. Play 업로드 키 fingerprint를 runtime client identity로 등록하지 않는다.
- GitHub `release` workflow는 semantic version tag에서 `versionName`을 만들고 `major * 1,000,000 + minor * 1,000 + patch`로 `versionCode`를 계산한다. 각 segment는 1000 미만이고 계산값은 Play 상한 이하이며 양수여야 한다.
- workflow는 production Cloud origin과 server Web client ID를 주입하고 JVM unit test 뒤 minified release APK를 만든다. `apksigner`로 서명 유효성과 고정된 공개 SHA-256 certificate fingerprint를 검사한 뒤 universal APK와 SHA-256 checksum만 같은 GitHub Release에 첨부한다.
- GitHub APK workflow는 AAB를 만들지 않는다. Play 등록 뒤 별도 workflow가 별도 upload-key secret으로 AAB를 만들고 제출 전에 upload certificate를 검증한다.
- release signing 값이 일부만 주입된 Gradle 실행은 실패한다. 전부 없으면 개발자가 unsigned release를 분석용으로 만들 수 있지만, GitHub release workflow는 모든 값과 signer fingerprint가 없으면 실패 닫힘한다.

## Alternatives Considered

- **GitHub와 Play에 서로 다른 앱 서명 키를 사용한다.** 키 노출 영역은 분리되지만 Android가 두 설치본을 같은 업데이트 계보로 보지 않아 교차 설치 시 삭제가 필요하므로 기각했다.
- **Google이 Play 앱 서명 키를 새로 만들고 GitHub에는 별도 키를 쓴다.** Play의 키 보관은 편하지만 GitHub sideload를 먼저 배포하는 제품 경로와 업데이트 호환을 잃으므로 선택하지 않았다.
- **앱 서명 키를 Play 업로드 키로도 사용한다.** 키 수는 줄지만 CI·Play 제출 경로의 노출이 영구 앱 신원까지 위협하고 업로드 키의 재설정 가능성도 활용하지 못하므로 분리한다.
- **debug keystore로 먼저 APK를 배포한다.** 즉시 빌드할 수 있지만 공개 설치가 debug key 계보에 고정되고 production key로 전환할 때 삭제가 필요하므로 금지한다.
- **AAB만 배포하고 Play에서 universal APK를 내려받아 GitHub에 복제한다.** 최종 서명 일치는 보장하지만 최초 배포부터 Play Console에 종속되고 GitHub 우선 배포 요구를 충족하지 못한다.

## Consequences

- GitHub 설치본과 Play 설치본이 같은 package/signing identity로 서로 업데이트될 수 있고 pairing·Keystore 데이터가 유지된다.
- 앱 서명 키 분실은 GitHub 직접 배포 연속성을 잃는 중대한 사고다. Play 업로드 키와 달리 단순 reset으로 해결되지 않으므로 최초 공개 전에 오프라인 복구를 검증해야 한다.
- Play App Signing 등록에서는 기존 앱 서명 키 제공 절차를 선택해야 하며, 업로드 키를 별도로 생성·등록한다. Google Play 밖에서도 직접 서명할 수 있도록 원본 앱 키를 계속 보유한다.
- CI는 private signing material을 잠시 runner 파일로 복원하므로 GitHub Actions와 저장소 관리자 권한이 서명 공급망의 일부가 된다. job 종료 시 파일을 삭제하고 certificate fingerprint를 별도 공개 변수와 대조하지만, 오프라인 서명보다 공격면은 넓다.
- 자동 검증은 Gradle version/signing 주입, secret 완전성, unit test, APK signature, signer certificate 고정, checksum과 release 첨부를 포함한다. Play workflow는 Console 등록과 upload key가 준비될 때 별도로 검증한다.
- 재검토 조건은 Play의 cross-store signing 정책 변경, Android key rotation 도입, CI 대신 hardware/offline signer 사용, package id 변경이다.
