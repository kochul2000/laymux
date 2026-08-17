# 0173. Remote 화면 설정은 PC가 소유하고 변경은 controller lease로 제한한다

- Status: Accepted
- Date: 2026-08-17
- Source: 사용자 요구("PC가 소유하는 settings.remote에 Remote 터미널 화면 글자 크기와 입력 컴포저 글자 크기를 저장", "Remote 화면과 PC Settings 양쪽에서 같은 값을 조회·수정", "Direct/Android E2E 경로 모두 기존 Remote 인증·권한 경계를 유지") · [architecture/api-contracts.md §10·§13](../architecture/api-contracts.md) · [ADR-0013](0013-direct-remote-mode.md) · [ADR-0015](0015-remote-terminal-state-ownership.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)
- Extends: ADR-0013, ADR-0015, ADR-0149

## Context

Remote 터미널과 입력 컴포저는 PC가 제공하는 같은 Remote 문서 안에 있지만 글자 크기의 기존 출처는 서로 달랐다. 터미널은 desktop profile 폰트 크기를 따라가고 컴포저는 Remote CSS의 고정값을 사용했다. 따라서 휴대폰 화면에 맞춘 크기를 PC Settings에서 미리 정하거나 Remote 화면에서 조정한 뒤 다른 Direct/Android 접속에 일관되게 적용할 수 없었다.

Remote 화면의 기존 기기 로컬 Display 선택은 브라우저별 chrome 소비 여부처럼 호스트 설정이 아닌 상태를 `localStorage`에 둔다. 반면 글자 크기는 PC Settings와 여러 Remote 클라이언트가 같은 값을 읽고 바꿔야 하므로 기기 로컬 상태로 둘 수 없다. Remote에서 PC 설정을 바꾸는 새 API는 일반 열람과 달리 호스트 상태를 영속 변경하므로 기존 bearer/IP/Origin 또는 Android E2E session 인증에 더해 controller 권한 경계를 지켜야 한다.

범위는 Remote 터미널 글자 크기와 Remote 입력 컴포저 글자 크기의 소유권·조회·변경 계약이다. 폰트 family, desktop terminal/profile 크기, 기기 로컬 위젯 표시 선택, composer 초안/history의 비영속 경계는 바꾸지 않는다.

## Decision

**Remote 터미널과 입력 컴포저의 글자 크기는 PC의 `settings.remote`가 단일 진실원이며, Remote 조회는 기존 접속 인증을, 영속 변경은 그 인증과 active controller lease를 모두 요구한다.**

- 설정 키는 `settings.remote.terminalFontSize`와 `settings.remote.composerFontSize`다. 기본값은 각각 14와 16이고 둘 다 6~72 범위의 정수다. terminal 값은 Remote surface에만 적용하며 desktop profile/profileDefaults나 pane override를 바꾸지 않는다.
- PC Settings는 기존 Remote 항목을 `Remote Connection`과 `Remote Display`로 나눈다. 연결·인증·host·Cloud 정책은 전자에, terminal/composer 크기와 기존 Remote 표시·스크롤 설정은 후자에 둔다. 두 화면은 같은 `settings.remote` 객체의 서로 겹치지 않는 필드를 수정한다.
- Remote v1은 `GET /remote/v1/display-settings`와 `PUT /remote/v1/display-settings`를 제공한다. GET과 성공한 PUT은 `{ terminalFontSize, composerFontSize, revision }`을 반환하고, PUT body는 `{ leaseId, expectedRevision, terminalFontSize, composerFontSize }`다. `revision`은 전체 settings의 충돌 감지용 opaque 값일 뿐 endpoint는 전체 settings나 token·Cloud metadata를 반환하지 않는다.
- GET은 기존 Remote route의 enabled + Direct bearer/IP/Origin gate 또는 Android E2E session/AEAD RPC gate를 통과하면 lease 없이 허용한다. PUT은 같은 transport/auth gate에 더해 active controller lease를 요구한다. read-only 접속, stale/missing lease, 허용되지 않은 Android inner method/path는 실패 닫힘한다.
- PUT은 desktop frontend의 공통 settings snapshot/apply bridge를 `expectedRevision` CAS와 함께 사용한다. revision이 달라지면 `409 Conflict`로 거절하고 Remote 문서는 GET으로 최신 두 값과 revision을 다시 읽는다. 따라서 stale Remote가 함께 전송한 다른 필드로 PC나 다른 client의 변경을 되돌리지 않으며, 전체 파일을 backend가 독자적으로 덮어쓰지 않고 semantic validation, Zustand 갱신, `settings.json` 저장과 runtime remote snapshot 갱신을 기존 경로 하나로 수행한다.
- active lease 검증과 PUT 완료 사이에는 owner gate에 lease mutation permit을 등록한다. permit 등록이 release·reclaim·expiry보다 먼저 선형화되면 owner handoff가 저장 완료까지 drain하고, 전환이 먼저 시작됐으면 PUT을 거절한다. 따라서 검증 직후 lease가 바뀐 stale controller의 저장이 새 owner 뒤에 commit되지 않는다.
- Android APK는 새 설정 UI나 값을 소유하지 않는다. PC가 제공한 같은 Remote 문서가 native encrypted HTTP bridge로 동일 endpoint를 호출하며, APK inner path allowlist에는 exact GET/PUT 두 조합만 추가한다.
- Remote에서 저장한 값은 현재 문서의 terminal/composer에 즉시 적용한다. PC나 다른 client에서 바뀐 값은 Remote Settings 화면을 열거나 연결을 구성할 때 다시 조회한다. 기기 로컬 widget toggle과 composer 내용/history는 기존 저장 경계를 유지한다.

## Alternatives Considered

- **브라우저 `localStorage`에 두 값을 저장한다.** 구현은 작지만 PC Settings와 값이 갈리고 기기마다 달라져 PC 소유·양방향 편집 요구를 만족하지 못한다.
- **desktop profile 폰트 크기와 composer CSS를 계속 사용한다.** 새 계약은 없지만 Remote 전용 화면 밀도를 독립적으로 조정할 수 없고 두 값의 소유자가 계속 갈린다.
- **Remote에 범용 settings GET/PATCH를 노출한다.** 재사용 범위는 넓지만 auth token·Cloud metadata 같은 민감 필드와 미래 설정까지 원격 표면에 열며 최소 권한 원칙을 어기므로 두 필드의 좁은 projection만 제공한다.
- **PUT도 bearer/E2E 인증만 요구한다.** 화면을 볼 수 있는 read-only client가 PC 영속 설정을 바꿀 수 있어 기존 Remote mutation의 controller lease 경계보다 넓어지므로 기각했다.
- **Rust가 settings 파일을 직접 load-modify-save한다.** frontend draft/store와 경합해 다른 설정을 잃을 수 있고 공통 revision/apply 경로를 우회하므로 기존 settings bridge를 사용한다.

## Consequences

- Direct browser와 Android E2E가 같은 PC 설정과 Remote page 코드를 사용하므로 표시 동작이 경로별로 갈리지 않는다.
- Remote 글자 크기는 desktop profile 크기에서 독립된다. 기존 설정 파일은 serde 기본값 14/16으로 동작하며 내부 개발 단계 정책에 따라 별도 마이그레이션은 없다.
- Remote 화면에서 크기를 바꾸면 현재 terminal grid가 다시 fit되어 active lease로 PTY resize가 한 번 발생할 수 있다. 이는 글자 크기 변경에 필요한 surface-local reflow이며 terminal contents나 desktop renderer 설정을 공유하지 않는다.
- 새 외부 계약과 Android inner allowlist를 함께 유지해야 한다. 자동 검증은 설정 기본값/범위/round-trip, terminal appearance override, Direct route gate 배치, PUT lease 거절과 owner handoff drain, revision 충돌 시 409·재조회, Android exact method/path 허용, Remote page의 조회·수정·즉시 적용, PC Settings 분리를 포함한다.
- 향후 font family나 다른 Remote 표시 설정을 공유하려면 민감 정보가 섞이지 않는 projection과 lease 요구를 유지하면서 이 ADR의 범위를 새 ADR로 확장한다.
