# 0010. 알림 해제 기준 — 사용자 입력 종류가 아닌 프로그램의 진입/포커스 동작

- Status: Accepted
- Date: 2026-06-10
- Source: issue #302

## Context

알림 해제(읽음 처리) 로직이 진입 경로마다 흩어져 있었다.

- 화살표 키 진입(`useKeyboardShortcuts`)과 워크스페이스 셀렉터 클릭(`WorkspaceSelectorView`)은 진입 시점에 `markNotificationsAsRead` / `markWorkspaceAsRead` 를 **명시 호출**했다.
- 자동 해제 모드(`workspace` / `paneFocus`)는 `AppLayout` 의 effect 가 `activeWorkspaceId` · `focusedPaneIndex` · `unreadCount` 변화를 **선언적으로 감지**해 해제했다.
- 그러나 마우스 클릭으로 활성 워크스페이스의 pane 에 진입하는 경로(`WorkspaceArea` 의 `onPaneFocus`)에는 해제 로직이 없었다. 기본값인 `workspace` 모드에서는 같은 워크스페이스 내 클릭으로 `activeWorkspaceId` 가 바뀌지 않아 effect 도 재실행되지 않아, 화살표로 진입하면 해제되지만 마우스 클릭으로 진입하면 해제되지 않는 불일치가 생겼다.

해제 기준이 "사용자가 어떤 입력 수단을 썼는가(마우스 vs 화살표)"에 암묵적으로 결합되어 있던 것이 근본 원인이다.

## Decision

**알림 해제의 기준점은 사용자 입력의 종류가 아니라, 프로그램의 진입/포커스 동작 그 자체다.**

워크스페이스/페인으로의 진입(포커스 부여)이라는 *프로그램 동작*이 일어나면, 그 동작을 유발한 입력 수단(마우스 클릭·화살표 키·자동화 API·세션 복원 등)과 무관하게 동일하게 해제한다. 어떤 경로로 진입하든 해제 동작은 같아야 한다.

예외는 다음 두 가지로 고정한다.

- `notificationDismiss === "manual"`: 사용자가 명시적으로 해제할 때만 읽음 처리.
- `requiresAction` 알림(예: Claude 권한 모달): 진입만으로 해제하지 않고, 명시적 클릭 또는 원인 상태가 해소될 때만 해제(ADR 와 무관하게 기존 `markWorkspaceAsRead` 가 보존).

## Consequences

- 마우스 클릭 진입에서도 알림이 해제되어, 입력 수단에 따라 동작이 달라지던 불일치가 사라진다.
- 새 진입 경로를 추가할 때의 규칙이 명확해진다 — "포커스/진입 동작을 일으키는 곳에서 입력 종류와 무관하게 해제"가 SoT다. 입력 핸들러마다 해제 로직을 재발명하지 않는다.
- 진입 경로가 늘면 동일한 해제 호출이 여러 지점에 중복될 수 있다. `markWorkspaceAsRead` 는 이미 멱등(이미 읽은 알림·`requiresAction` 알림은 건드리지 않음)하므로 중복 호출은 무해하다.
- 현재 노출 지점(해제 트리거가 걸린 코드 경로)은 living doc [architecture/data-flow.md](../architecture/data-flow.md) 의 "알림 시스템" 절이 SoT.
