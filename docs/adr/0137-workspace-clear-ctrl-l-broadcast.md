# 0137. 워크스페이스 클리어는 activity 판정 없이 Ctrl+L 브로드캐스트로 단순화하고, 단일 pane 클리어는 폐지한다

- Status: Accepted
- Date: 2026-08-06
- Source: 사용자 판단(Alt+L 은 Ctrl+L 과 동일해 무의미한 기능이었다는 지적) — [ADR-0113](0113-workspace-clear-activity-owned.md), [ADR-0121](0121-single-pane-clear-user-pointed-scope.md) 정정

## Context

[ADR-0113](0113-workspace-clear-activity-owned.md) 은 워크스페이스 클리어(`Ctrl+Alt+L`)가 pane 마다 activity handler 에게 "무엇을 칠지"(`clear`/`cls`/`/clear`)와 "지금 쳐도 되는가"(busy policy: skip/interrupt/restart)를 묻게 했다. [ADR-0121](0121-single-pane-clear-user-pointed-scope.md) 은 같은 판정을 포커스된 pane 하나에 적용하는 단일 pane 클리어(`Alt+L`)를 추가했다.

단일 pane 클리어는 실제로는 무의미했다 — 포커스된 pane 에서 사용자가 그냥 `Ctrl+L` 을 누르면 shell 이든 Claude Code 든 Codex 든 동일한 결과를 얻는다. `Alt+L` 이 별도로 존재해야 할 이유가 없었다.

워크스페이스 클리어도 다시 보면 activity 판정이 굳이 필요하지 않다. `Ctrl+L` 은 shell 의 표준 클리어 키이고 Claude Code·Codex 도 이를 화면 클리어로 처리하며, 전용 handler 가 없는 interactive app(vim·htop·less 등)에도 안전하다 — `/clear` 같은 텍스트를 잘못된 곳에 흘려 넣는 위험이 원래부터 없는 입력이다. activity handler 계약(`clearInput`/`isBusy`), busy policy, shell 명령 설정은 이 위험을 막기 위해 존재했는데, 위험 자체가 없으므로 전부 불필요한 복잡도였다.

## Decision

**단일 pane 클리어(`pane.clearTerminal`, `Alt+L`)는 폐지한다. 워크스페이스 클리어(`workspace.clearTerminals`, `Ctrl+Alt+L`, 아이콘·단축키 유지)는 activity 판정과 `settings.workspaceClear` 설정을 모두 제거하고, 워크스페이스의 모든 `TerminalView` pane 에 `Ctrl+L`(`\x0c`) 하나를 그대로 브로드캐스트하는 동작으로 바꾼다.**

- **단일 pane 클리어는 코드에서 완전히 삭제한다.** 키바인딩(`pane.clearTerminal`), pane 컨트롤 바의 빗자루 아이콘, `clearPane()`/`runPaneClearFromUi()`, Automation 라우트(`POST /api/v1/panes/{paneId}/clear`)를 포함해 ADR-0121 이 추가한 모든 표면을 제거한다. 대체 동작(포커스된 pane 에서 `Ctrl+L`)이 이미 터미널 표준 동작이므로 마이그레이션이 필요 없다.
- **워크스페이스 클리어는 activity 판정 없이 `Ctrl+L` 하나를 쓴다.** `ActivityHandler.clearInput()`/`isBusy()`, `isRegisteredInteractiveApp()`, busy policy(skip/interrupt/restart)를 모두 제거한다. 세션이 아직 없는 pane(`notReady`)만 건너뛴다 — busy 여부는 더 이상 판정하지 않는다: `Ctrl+L` 은 작업 중인 pane 에 보내도 안전하다.
- **`settings.workspaceClear` 를 통째로 없앤다.** `shellCommand`/`busyPolicy`/`interruptRounds`/`settleMs` 는 더 이상 존재할 이유가 없는 설정이다 — 클리어 동작에 사용자가 조정할 여지가 남지 않는다.
- **Automation 응답은 `cleared`/`skipped`/`failed` 세 필드로 줄어든다.** `interrupted`/`restarted`/`waitCapped`/`interruptRounds`/`settleMs` 는 그 판정 자체가 없어졌으므로 응답에서도 사라진다. 대기 캡(`AUTOMATION_CLEAR_WAIT_BUDGET_MS`)과 절대 deadline(`AUTOMATION_CLEAR_DEADLINE_MS`)도 함께 제거한다 — 라운드가 여러 번인 interrupt 체인이 없으므로 캡할 대상이 없다.

## Alternatives Considered

- **`Alt+L` 은 없애고 워크스페이스 클리어의 activity 판정은 유지한다.** 판정 자체가 실제로는 불필요한 위험 회피였다는 지적을 절반만 반영하는 선택이라, 설정과 코드의 복잡도가 그대로 남는다.
- **`workspaceClear` 설정은 남기고 기본 동작만 바꾼다.** 조정할 대상(shell 명령, busy 정책)이 사라졌는데 설정 스키마만 남기면 아무도 안 쓰는 죽은 설정이 된다.

## Consequences

- ADR-0113 · ADR-0121 은 이 결정으로 대체된다(Status 를 "Superseded by 0137" 로 갱신). 두 문서의 본문은 append-only 원칙에 따라 고치지 않고, 왜 폐기됐는지는 이 문서가 SoT 다.
- `docs/architecture/api-contracts.md` 의 "터미널 클리어 설정" 절은 이 ADR 을 반영해 다시 쓴다 — 설정 예시·busy policy 표·Automation 캡 설명을 모두 제거한다.
- 재검토 조건: `Ctrl+L` 을 클리어로 해석하지 않는 앱(커스텀 TUI 등)이 늘어나 오작동 신고가 들어오면, 그 앱만을 위한 opt-out 판정을 다시 넣을 근거가 된다 — 다만 그 경우에도 "모든 앱을 위한 전역 activity 판정"으로 되돌리기보다 국지적 예외로 시작한다.
