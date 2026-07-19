# 0039. Remote 공간순서·알림순서 스텝 내비게이션은 데스크톱 프론트엔드가 계산한다

- Status: Accepted
- Date: 2026-07-19
- Source: issue #474, [ADR-0013](0013-direct-remote-mode.md), [ADR-0018](0018-remote-navigation-ui-state.md), [ADR-0019](0019-remote-notification-interactions.md), [ADR-0020](0020-remote-dock-terminal-navigation.md), [ADR-0028](0028-remote-soft-key-toolbar.md) 확장

## Context

리모트(Focused UI)의 pane/workspace 전환 수단은 드로어 리스트 tap 뿐이다. 이슈 #474는 데스크톱 단축키에 대응하는 스텝 이동 버튼을 요구한다:

- **공간순서 전/후**: pane을 워크스페이스 경계를 넘나들며 1D 선형 순회. 데스크톱의 `workspace.prev/next`(Ctrl+Alt+Up/Down)와 `pane.focus`(Alt+Arrow)를 하나의 순회로 통합한 신규 동작이다 — 기존 데스크톱 액션 중 어느 하나도 워크스페이스 경계를 넘는 pane 단위 선형 이동을 제공하지 않는다.
- **알림순서 전/후**: 데스크톱 `notifications.recent/oldest`(Ctrl+Alt+Left/Right)에 대응.

제약: ADR-0018에 따라 `/remote/v1/navigation` payload는 active workspace의 pane만 상세를 담고 inactive workspace는 요약(count)만 담는다. 따라서 리모트 클라이언트는 "워크스페이스를 넘는 다음 pane"을 스스로 계산할 수 없다. 순회 시맨틱의 근거 상태(정렬 순서, hidden 집합, focus, unread 알림)는 모두 데스크톱 프론트엔드 Zustand store가 SoT다.

비목표: 데스크톱 키바인딩·기존 navigation payload 계약 변경, dock 순회 통합.

## Decision

**리모트의 스텝 내비게이션은 데스크톱 프론트엔드가 브릿지 action(`navigation.spatialStep`/`navigation.notificationStep`)으로 계산·실행하고, Rust remote server는 lease 검증·중계·착지 후 mark-read만 수행하는 controller 엔드포인트 2개(`POST /remote/v1/navigation/spatial`, `POST /remote/v1/navigation/notification`)를 추가한다.**

불변식:

1. **공간순서** = (표시순 visible workspace) × (workspace 내 `paneNumber` 오름차순 TerminalView pane)의 순환 1D 리스트. hidden workspace 제외(active-hidden workspace는 앵커로만 사용 — `workspace.prev/next`의 규칙 계승), hidden pane 포함(ADR-0035: 숨김 pane도 grid에서 항상 접근 가능), non-terminal pane(Memo/Settings) 제외, dock 제외(ADR-0020: dock은 app-global이며 리모트에 전용 패널 존재). `terminalLive`는 조건이 아니다 — inactive workspace 터미널은 착지 시 세션이 생성되므로 live 조건을 걸면 방문한 적 없는 workspace가 영구 도달 불가가 된다.
2. **알림 스텝은 데스크톱과 동일한 순수 함수·소비 규칙을 공유한다** (`findNotificationNavTarget`: unread만, `createdAt` 정렬, 동일 terminal 연속 알림 그룹 소비). 두 표면(키보드/리모트)의 시맨틱 분기 금지.
3. **응답은 착지 타깃을 반환하고 리모트 뷰포트는 그 타깃으로 attach를 follow한다.** 이동 불가는 에러가 아니라 `{moved:false, reason}` — 유효한 no-op이다.
4. ADR-0018의 inactive workspace pane 비노출 계약과 ADR-0020의 dock 분리 계약은 불변이다(payload 확장 없음).
5. 스텝 이동도 기존 remote navigation action과 같은 소비 규칙을 따른다: spatial 착지는 해당 terminal unread를 읽음 처리(`notifications.markTerminalRead` best-effort), notification 스텝은 타깃 알림 그룹을 소비. 성공 시 `workspace-state-changed`를 발행한다.
6. **UI 표면은 소프트키 툴바(ADR-0028)의 키셋이다.** 전용 상시 행을 만들지 않고, 툴바 키셋 `step`(기본 활성, 설정 팝오버에서 토글 가능)으로 스텝 키 4개와 4방향 nav flick 패드(상하=공간 스텝, 좌우=알림 스텝)를 제공한다. 이로써 ADR-0028의 툴바 범위를 확장한다: 툴바는 escape 시퀀스 키 외에 **lease-gated controller action 키**도 담을 수 있으며, action 키는 escape 키와 달리 activeTerminal 없이 lease만으로 활성화된다(터미널 없는 workspace 탈출 경로). 알림 키는 unread 0에서 비활성화되고 unread 배지를 하나만 표시한다.

## Alternatives Considered

- **footer 위 전용 상시 버튼 행**: 최초 구현안. 연결 시 상시 노출되는 4버튼 행은 발견성이 좋지만 모바일 세로 공간을 상시 소모(약 44px)해 터미널 뷰포트를 잠식한다는 사용자 피드백으로 기각. 소프트키 툴바 통합이 세로 비용 0(토글 시에만 노출) + 사용자 구성 가능(키셋/커스텀)이라는 기존 체계를 재사용한다.
- **리모트 클라이언트 계산 (ADR-0028 방식, 새 API 없음)**: navigation payload의 active workspace pane geometry + notifications로 page.html이 다음 타깃을 계산하고 기존 `/workspaces/active`·`/terminals/{id}/focus`를 호출. 기각 — inactive workspace pane 정보가 없어 경계를 넘는 순회를 완성할 수 없고(ADR-0018 계약을 깨는 payload 확장 필요), 정렬·hidden·소비 로직을 vanilla JS로 중복 구현해 데스크톱과 시맨틱이 갈라질 위험. ADR-0028의 soft-key는 클라이언트 전용 escape 시퀀스라 새 API를 피한 것이고, 본 건은 호스트 상태를 바꾸는 controller action이라 ADR-0018/0019/0020 범주다.
- **payload에 전체 workspace pane 상세 포함**: 리모트 계산은 가능해지나 ADR-0018 축약 계약을 뒤집고, focus·hidden·알림 소비의 SoT(프론트 store)와 계산 위치가 갈라진다. 기각.
- **Rust 서버 계산**: 서버는 store 스냅샷을 bridge query로만 얻으므로 계산-실행 사이 레이스가 생기고, 순회 규칙이 프론트(키보드)와 Rust 두 곳에 존재하게 된다. 기각.

## Consequences

- 리모트 계약 표면 +2 엔드포인트 (문서: api-contracts.md §13.3). direction 파라미터는 화이트리스트 검증(400), lease 없으면 409, bridge 실패 502.
- 데스크톱 키보드 오케스트레이션(`navigateByNotification` 등)을 `useKeyboardShortcuts.ts`에서 공유 모듈(`ui/src/lib/navigation-actions.ts`)로 추출 — 키보드·브릿지가 같은 코드를 소비해 분기 위험 제거.
- 신규 순수 함수(`ui/src/lib/spatial-navigation.ts`)가 공간순서의 단일 정의가 된다. 데스크톱에 같은 1D 순회 단축키를 추가할 때 이 정의를 재사용한다(재검토 조건: 데스크톱 도입 시 키바인딩 레지스트리 등록).
- 착지 터미널 세션 준비를 기다리기 위해 `navigation.spatialStep`은 async 브릿지 경로(`waitForTerminalSessionReady`)를 사용 — 응답 시점에 attach 가능함을 보장.
- 테스트·문서 후속: 순수 함수 unit, 브릿지 handler, Rust route, page.rs 마크업 테스트, §13.3 갱신.
