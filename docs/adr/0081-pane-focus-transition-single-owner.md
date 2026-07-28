# 0081. Pane 포커스 전환은 단일 도메인 액션이 소유한다

- Status: Proposed
- Date: 2026-07-28
- Source: 사용자 요구, issue #578, PR #579 후속, [ADR-0005](0005-display-state-raw-separation-compute.md), [ADR-0020](0020-remote-dock-terminal-navigation.md), [ADR-0039](0039-remote-spatial-notification-step-navigation.md), architecture/api-contracts.md §13.3·§15.4

## Context

현재 pane 포커스는 한 값이 아니라 세 Zustand store의 조합이다. 활성 workspace는 `workspaceStore.activeWorkspaceId`, workspace grid pane은 `gridStore.focusedPaneIndex`, dock pane은 `dockStore.focusedDock`/`focusedDockPaneId`가 각각 소유한다. SoT를 분리한 것 자체는 유효하지만, 전환 시에는 이 값들을 함께 바꿔야 한다.

- workspace pane에 착지하면 대상 workspace와 유효 pane index를 설정하고 dock focus를 비워야 한다.
- dock pane에 착지하면 대상 dock/pane을 설정하고 grid focus를 비워야 한다.
- workspace만 전환할 때도 이전 workspace의 전역 pane index를 그대로 해석하지 말고 대상 workspace에서 다시 착지해야 한다(issue #578).

PR #579는 Remote와 키보드 workspace 전환이 공유 착지 규칙을 사용하게 했지만, `WorkspaceSelectorView`의 행 클릭과 생성·복제 후 전환은 여전히 `setActiveWorkspace`를 직접 호출했다. 이 경로는 dock focus를 남겨 새 workspace를 활성화한 직후 화면과 Remote preferred terminal이 dock pane으로 되돌아갈 수 있었다. 레이아웃의 pane 클릭, dock 클릭, 알림·공간 탐색, Automation focus에도 같은 다중 store 쓰기가 각각 존재해 어느 한 UI만 고쳐서는 불변식을 유지할 수 없다.

범위는 데스크톱 frontend의 workspace/grid/dock **포커스 전환**이다. 각 store의 raw state SoT, Remote HTTP payload, PTY focus, 숨김 상태의 소유권은 바꾸지 않는다. 비활성 workspace의 PTY를 잠시 mount하거나 active-workspace 기반 setter로 비활성 workspace 데이터를 편집하기 위한 내부 활성화/복원은 사용자 포커스 전환이 아니므로 이 범위 밖이다.

## Decision

**workspace·grid·dock pane 포커스의 교차-store 전환은 `ui/src/lib/workspace-transition.ts` 한 곳이 소유하고, UI·키보드·Automation/Remote·공유 navigation은 이 도메인 액션만 호출한다.**

- `focusWorkspacePane(workspaceId, paneIndex)`는 대상 workspace와 pane을 먼저 검증한 뒤 active workspace를 바꾸고 dock focus를 비우며 grid pane을 설정한다. 검증 실패 시 어느 store도 건드리지 않는다.
- `focusDockPane(position, paneId?)`는 실제 dock pane을 먼저 검증한 뒤 dock pane을 설정하고 grid focus를 비운다. 검증 실패 시 어느 store도 건드리지 않는다. Automation이 명시적으로 숨은 dock terminal을 지정하는 기존 계약은 유지한다.
- `switchActiveWorkspace(workspaceId, options?)`는 issue #578의 공유 순수 착지 규칙으로 대상 pane을 다시 계산한다. `dock.arrowFocusPane=false`의 dock-focus 보존 예외도 호출자 분기가 아니라 이 전환 안에서 처리한다.
- React 컴포넌트와 transport adapter는 상태를 읽어 의도를 정할 수 있지만 `setActiveWorkspace`·`setFocusedDock`·`setFocusedPane`를 조합해 전환을 재구현하지 않는다.
- 숨김 fallback, 공간/알림 이동과 selector 클릭처럼 상위 정책이 다른 흐름은 각자 대상을 고르되 최종 포커스 commit은 같은 전환 액션에 맡긴다.
- Automation의 백그라운드 PTY 준비와 새 workspace CWD 적용처럼 화면 포커스를 소유하지 않는 임시 활성화는 raw `setActiveWorkspace`를 쓸 수 있다. 이 경로는 dock/grid focus를 바꾸지 않고 원래 workspace를 복원해야 하며, 사용자 navigation에 사용해서는 안 된다.

## Alternatives Considered

- **Selector의 클릭 핸들러만 고친다.** 당장 재현은 막지만 다른 UI와 Remote/Automation 경로가 계속 세 store를 직접 조합하므로 같은 결함이 재발한다. 기각.
- **각 호출자가 공통 순수 착지 함수만 사용한다.** 계산은 공유돼도 commit 순서와 dock/grid 상호 배타성은 중복된다. PR #579 뒤에도 Selector가 빠진 이유를 해결하지 못한다. 기각.
- **세 store를 하나의 거대 focus store로 합친다.** 전환을 원자적으로 표현하기는 쉽지만 workspace 구조, grid 편집 상태, app-global dock의 기존 SoT와 구독 경계를 모두 바꾸는 큰 마이그레이션이다. 현재 문제에는 과도하므로 기각.
- **workspace store가 다른 store를 직접 갱신한다.** raw workspace 데이터 mutation까지 UI focus 정책에 결합되고 순환 의존 위험이 생긴다. store는 상태 SoT로 유지하고 교차-store orchestration을 도메인 액션에 둔다.

## Consequences

- workspace pane과 dock pane은 동시에 포커스될 수 없고, 모든 사용자/Remote 포커스 진입점이 같은 검증·commit 순서를 따른다.
- UI 컴포넌트는 클릭을 전환 의도로 변환할 뿐 다중 store 정책을 갖지 않는다. 새로운 포커스 진입점도 반드시 `workspace-transition.ts`의 액션을 호출해야 한다.
- 기존 Zustand store와 외부 Automation/Remote 응답 형식은 유지된다. 별도 설정·세션 마이그레이션은 없다.
- `grid.focusPane`도 workspace 포커스 전환이므로 이제 dock focus를 함께 비운다. 이는 `grid.getState`가 문서화한 “grid와 dock 중 하나만 focus” 불변식과 일치한다.
- raw setter는 기존 store API에 남아 있어 정적 타입만으로 우회를 금지하지는 못한다. 프로덕션 호출 검색과 전환 모듈 단위 테스트, Selector/Automation/keyboard 회귀 테스트로 경계를 지킨다.
- 재검토 조건: 여러 surface가 동시에 독립적인 desktop focus를 소유하거나, Zustand store 구조를 하나의 트랜잭션 store로 합칠 때 이 액션 경계를 다시 설계한다.
