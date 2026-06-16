# 0010. 알림 해제 기준 — 사용자 입력 종류가 아닌 프로그램의 진입/포커스 동작

- Status: Accepted (requiresAction 예외 조항은 [0012](0012-focus-entry-clears-requires-action.md) 가 정정)
- Date: 2026-06-10
- Source: issue #302

## Context

알림 해제(읽음 처리)에 두 가지 결함이 있었다.

**1) 트리거가 입력 수단에 결합** — 화살표/단축키 진입(`useKeyboardShortcuts`)과 워크스페이스 셀렉터 클릭(`WorkspaceSelectorView`)은 해제했지만, 마우스 클릭으로 활성 워크스페이스의 pane 에 진입하는 경로에는 해제가 걸리지 않았다. 화살표로 진입하면 해제되는데 마우스 클릭으로 진입하면 안 되는 불일치가 생겼다(issue #302).

**2) 해제 단위가 모드와 어긋남** — 설정의 `paneFocus` 모드("Pane 포커스 시 자동 해제")는 *그 pane* 의 알림만 해제해야 하는데, `AppLayout` 의 effect 와 `addNotification` 자동 해제가 모두 `markWorkspaceAsRead` 로 **워크스페이스 전체**를 읽음 처리했다. 그 결과 paneFocus 모드가 사실상 workspace 모드와 같아져 모드 구분이 무의미했다. 알림 모델은 `Notification.terminalId` 로 pane(터미널 인스턴스) 단위 추적을 이미 지원하는데도 이를 활용하지 않은 것이 원인이다.

## Decision

**(트리거) 알림 해제의 기준점은 사용자 입력의 종류가 아니라, 프로그램의 진입/포커스 동작 그 자체다.** 진입(포커스 부여)이라는 프로그램 동작이 일어나면, 그것을 유발한 입력 수단(마우스·화살표·자동화 API·세션 복원)과 무관하게 동일하게 해제한다.

**(단위) 해제 범위는 `notificationDismiss` 모드를 따른다.**

| 모드 | 트리거 | 해제 범위 |
|------|--------|-----------|
| `workspace` | 워크스페이스 진입 / 활성 워크스페이스의 아무 pane 포커스 | 워크스페이스 전체 (`markWorkspaceAsRead`) |
| `paneFocus` | pane 포커스 | 그 pane(터미널 인스턴스)만 (`markTerminalAsRead`) |
| `manual` | 알림 클릭 / 알림 네비게이션 | 해당 알림만 |

**(SoT) focus 기반 자동 해제는 `AppLayout` 의 두 effect 한 곳에서만 수행한다.** 마우스 클릭과 화살표 이동 모두 `focusedPaneIndex` / `activeWorkspaceId` 를 거치므로, 입력 핸들러(예: `WorkspaceArea` 의 `onPaneFocus`)에 해제 로직을 흩뿌리지 않는다.

예외 두 가지는 모든 모드에 공통이다.

- `notificationDismiss === "manual"`: 사용자가 명시적으로 해제할 때만 읽음 처리.
- `requiresAction` 알림(예: Claude 권한 모달): 진입/포커스만으로 해제하지 않고, 명시 클릭 또는 원인 상태 해소 시에만 해제. `markWorkspaceAsRead` · `markTerminalAsRead` 모두 이를 보존한다.

## Consequences

- 마우스 클릭 진입에서도 알림이 해제되어 입력 수단에 따른 불일치가 사라진다.
- paneFocus 모드가 의도대로 pane 단위로 동작한다 — pane A 에 포커스 중이면 pane B 의 새 알림은 unread 로 남는다.
- 해제 트리거가 `AppLayout` effect 한 곳에 모여, 새 진입 경로(입력 핸들러)를 추가해도 해제 로직을 재발명하지 않는다. `markWorkspaceAsRead` · `markTerminalAsRead` 는 멱등(이미 읽은 알림·`requiresAction` 보존)하므로 중복 트리거도 무해하다.
- 현재 노출 지점은 living doc [architecture/data-flow.md](../architecture/data-flow.md) 의 "알림 시스템" 절이 SoT.
