# 0223. Android 릴리스 채널은 APK를 명시적으로 발행할 때만 전진한다

- Status: Accepted
- Date: 2026-08-31
- Source: 사용자 요구("버전 릴리즈 때마다 Android 앱은 그대로인데도 버전이 앞으로 가는 것이 불만", Android APK 발행 시점 분리 승인) · [ADR-0190](0190-update-release-channels.md) · [ADR-0197](0197-android-update-channel-release-handoff.md) · [architecture/api-contracts.md §10](../architecture/api-contracts.md)
- Corrects: ADR-0190 — 모든 데스크톱 릴리스에서 Android job까지 성공해야 게시하는 정책
- Supersedes: ADR-0197 — 채널 조회·표시 계약은 유지하되 네 Android 매니페스트를 매 데스크톱 릴리스 tag로 전진시키는 발행 결합을 대체한다

## Context

현재 release workflow는 데스크톱 tag를 Android `versionName`·`versionCode`로 그대로 인코딩하고 매번 signed APK를 다시 만든다. 이어서 `android-stable.json`·`android-beta.json`도 같은 tag로 전진하므로, Android 실행 코드가 바뀌지 않은 릴리스도 폰에서는 새 앱 버전과 업데이트 후보가 된다. 소스가 같아도 `BuildConfig.VERSION_NAME`이 달라지므로 산출물은 새 버전으로 보이며 사용자는 의미 없는 재설치를 안내받는다.

데스크톱이 소유하는 Remote 문서와 서버 구현은 APK 교체 없이 Android에서 바로 사용된다. 반면 Android 네이티브 코드·manifest·resource·Gradle release 설정 또는 Android E2E 호환 번호가 달라지면 새 APK가 반드시 필요하다. 배포자가 실수로 이를 누락하면 desktop과 phone 계약이 갈라질 수 있으므로 단순한 선택적 skip만으로는 충분하지 않다.

범위는 GitHub release workflow의 Android 발행 선택, 채널 매니페스트 전진, 누락 방지와 채널 부트스트랩이다. Android 앱의 독립 SemVer, 별도 Android 전용 GitHub Release/tag 계열, Play 배포는 비목표다.

## Decision

**Android APK와 Android 채널 매니페스트는 release dispatch에서 `publish_android=true`로 명시한 릴리스에서만 발행·전진하고, 그 밖의 데스크톱 릴리스에서는 마지막 Android 버전을 그대로 유지한다.**

- `workflow_dispatch.publish_android`는 필수 boolean이며 기본값은 `false`다. `false`이면 Android job은 skip하고 현재 `android-stable.json`·`android-beta.json`을 채널 브랜치에 그대로 보존한다. 새 데스크톱 tag로 APK나 Android 매니페스트를 만들지 않는다.
- `true`이면 기존 서명·테스트·fingerprint 검증을 모두 수행한다. Android `versionName`은 그 데스크톱 릴리스 tag와 같고 `versionCode`는 ADR-0190 인코딩을 유지한다. Android 전용 버전 계열은 만들지 않으므로 실제 Android 릴리스 사이에 버전 번호 공백이 생길 수 있다.
- Android 발행을 요청한 경우 Android job 성공은 계속 게시의 필수 게이트다. `false`로 의도적으로 skip한 경우에만 publish가 skip을 허용한다.
- `false`는 현재 Android 채널이 가리키는 tag 이후 **release APK 입력**이 바뀌지 않았을 때만 허용한다. 비교 범위는 `app/src/main`, app/root Gradle release 설정, ProGuard와 Gradle wrapper 설정이다. 테스트·debug 전용 파일과 문서는 APK 발행을 강제하지 않는다. 범위 안 변경이 있으면 prepare가 draft 생성 전에 실패하고 `publish_android=true` 재실행을 요구한다.
- 모든 데스크톱 tag는 공통 release 문법으로 검증하지만 Android `versionCode` 상한은 `publish_android=true`에서만 검사한다. Android를 발행하지 않는 데스크톱 버전을 Android 인코딩 한계가 막지 않는다.
- `release-channels` 브랜치는 계속 네 파일을 한 트리 커밋으로 보관한다. 다만 Android 미발행 커밋에서는 두 Android 파일의 내용이 바뀌지 않으며 데스크톱 파일만 전진한다. `planReleaseChannelWrites`가 계열별 쓰기 여부를 단일 계산으로 소유한다.
- 채널 부트스트랩은 최신 stable desktop 릴리스와 최신 stable Android APK를 독립적으로 찾는다. 최신 desktop 릴리스에 APK가 없을 수 있으므로, 실제 규칙에 맞는 Android APK asset이 있는 가장 최근 stable 릴리스를 Android seed로 사용한다.
- ADR-0197의 기기-로컬 채널 선택, 매니페스트 스키마·검증, 버전 비교, 배너·설정 표면, GitHub 릴리스 페이지 handoff는 유지한다. 달라지는 것은 Android 매니페스트가 가리키는 최신 릴리스의 전진 시점뿐이다.

## Alternatives Considered

- **Android에 완전히 독립된 SemVer와 `android-vX.Y.Z` tag를 둔다.** 제품별 버전 의미가 가장 명확하지만 Android 클라이언트의 version↔tag URL 검증, 채널 생성기, GitHub latest 의미와 운영 절차를 모두 바꿔야 한다. 현재 문제는 불필요한 발행이므로 실제 발행 시 기존 공통 tag 버전을 사용하는 쪽이 작다.
- **경로 diff만으로 Android 발행을 자동 결정한다.** 조작이 없다는 장점이 있지만 release 입력 범위 밖의 호환성 판단이나 의도적인 재발행을 표현하기 어렵다. 명시적 선택을 SoT로 두고, path diff는 위험한 누락만 거절하는 게이트로 사용한다.
- **매번 새 릴리스에 이전 APK를 다시 첨부한다.** 다운로드 위치는 최신 릴리스에 모이지만 APK 내부 버전과 릴리스 tag가 달라지고 Android 매니페스트의 version↔tag 불변식을 깨뜨린다. 마지막 Android 매니페스트 자체를 보존한다.
- **Android job만 skip하고 Android 매니페스트는 데스크톱 tag로 전진시킨다.** 폰을 존재하지 않는 APK가 있는 릴리스 페이지로 보내므로 허용하지 않는다.

## Consequences

- Android 네이티브 앱이 바뀌지 않은 데스크톱 릴리스는 폰에 업데이트 후보를 만들지 않고 빌드 시간과 서명 키 노출도 줄인다.
- Android 버전은 예를 들어 `0.12.4 → 0.13.0`처럼 중간 데스크톱 번호를 건너뛸 수 있다. Android가 요구하는 것은 증가하는 `versionCode`이지 연속 번호가 아니다.
- 배포자는 Android 변경이 있는 릴리스에서 체크박스를 켜야 한다. 누락하면 게시 전 검사가 실패하므로 잘못된 desktop-only 릴리스가 공개되지는 않는다.
- release APK 입력 allowlist는 새 build input이 추가될 때 함께 갱신해야 한다. 누락 가능성이 생기면 전용 manifest 파일을 SoT로 옮기는 것을 재검토한다.
- 채널 브랜치가 유실되어도 최신 desktop과 최신 Android APK가 서로 다른 릴리스인 상태에서 복구할 수 있다.
- 검증은 채널 쓰기 계획 단위 테스트, workflow 계약 테스트, 실제 stable release에서 Android 발행/미발행 양쪽의 채널 버전 관측을 포함한다.
