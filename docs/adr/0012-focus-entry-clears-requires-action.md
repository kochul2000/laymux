# 0012. focus/진입은 requiresAction 알림도 해제한다 — 해제 조건은 입력 수단이 아닌 focus

- Status: Accepted
- Date: 2026-06-16
- Source: issue #365 (ADR [0010](0010-notification-dismiss-on-program-focus-entry.md) 의 requiresAction 예외 조항 정정)

## Context

ADR-0010 은 "알림 해제의 기준은 입력 수단이 아니라 프로그램의 진입/포커스 동작"이라고 정했지만, 예외로 `requiresAction` 알림(예: "Claude is waiting for your input")은 진입/포커스만으로 해제하지 않고 명시 클릭/원인 해소 시에만 해제하도록 두었다.

그런데 명시 클릭 경로 중 하나인 알림 네비게이션 키(`Ctrl+Alt+←/→` → `markNotificationsAsRead(ids)`)는 `requiresAction` 알림도 해제했고, focus 기반 경로(`Ctrl+Alt+↑/↓` 워크스페이스 전환, 마우스 진입 → `markWorkspaceAsRead`/`markTerminalAsRead`)는 `requiresAction` 를 보존했다.

결과적으로 **같은 "진입" 행위인데 입력 수단에 따라 해제 여부가 갈리는** 불일치가 생겼다 — `Ctrl+Alt+←/→` 로 들어가면 해제되는데 `Ctrl+Alt+↑/↓`·마우스로 들어가면 해제되지 않는다. `requiresAction` 가 실사용 알림의 대부분(Claude 입력 대기)이라 사용자에게는 "notification 해제가 아예 안 됨"으로 체감됐다(issue #365). 이는 ADR-0010 이 없애려던 바로 그 입력-수단 결합의 재발이다.

## Decision

**focus/진입 기반 해제(`markWorkspaceAsRead` · `markTerminalAsRead`)는 `requiresAction` 알림을 포함해 모든 unread 알림을 해제한다.** 워크스페이스/Pane 에 진입(포커스)하는 것은 "지금 이걸 보고 있다"는 사용자의 명시 신호이며, 네비게이션 키(`markNotificationsAsRead`)가 이미 그렇게 다룬다. 입력 수단(↑↓ / ←→ / 마우스 / 셀렉터 클릭)과 무관하게 동일하게 해제한다.

**`requiresAction` 예외는 오직 `addNotification` 의 도착 시점 auto-dismiss 에만 남는다.** 알림이 활성 워크스페이스에 *도착*하는 순간 자동으로 읽음 처리되면, 사용자가 미처 보기 전에 모달 알림 배지가 사라질 수 있다. 그 한 경우에만 `requiresAction` 를 보존하고, 사용자가 실제로 진입/포커스하면 해제한다.

또한 해제 트리거는 ADR-0010 대로 `AppLayout` 의 두 effect 한 곳에 둔다. 입력 핸들러(`WorkspaceSelectorView.handleSelectWorkspace`)의 핸들러-로컬 `markWorkspaceAsRead` 호출은 제거했다 — 그것이 dismiss 모드(paneFocus/manual)를 무시하고 해제 로직을 다시 흩뿌리던 잔재였다. 셀렉터 클릭도 `setActiveWorkspace` 를 거치므로 effect 가 모드에 맞게 처리한다(백엔드 OS 알림 동기화는 별개 관심사로 핸들러에 남는다).

## Consequences

- `Ctrl+Alt+↑/↓`·마우스·셀렉터 클릭으로 진입해도 `requiresAction` 알림이 해제되어, `Ctrl+Alt+←/→` 와 동작이 일치한다 — 입력 수단에 따른 불일치 제거(issue #365).
- "Claude 입력 대기" 배지는 사용자가 해당 워크스페이스/Pane 에 들어가는 순간 사라진다. 들어가지 않고 다른 곳에 머무는 동안에는 unread 로 유지되며, 도착 시점 auto-dismiss 예외 덕분에 활성 워크스페이스에 갓 도착한 모달 알림이 사용자가 보기 전에 사라지지 않는다.
- ADR-0010 의 트리거/단위/SoT 결정은 그대로 유효하다. 본 ADR 은 그중 `requiresAction` 예외의 범위만 "focus-entry 제외 → 도착-시점 auto-dismiss 한정"으로 좁힌다.
- living doc [architecture/data-flow.md](../architecture/data-flow.md) "알림 시스템" 절이 현재 노출 지점 SoT.
