# 0158. 단일 pane 실제 클리어는 activity handler가 소유하고 Alt+L로 실행한다

- Status: Accepted
- Date: 2026-08-15
- Source: 사용자 요구(2026-08-15, PR #742의 activity별 단일 pane 클리어 복구), [PR #742](https://github.com/kochul2000/laymux/pull/742), [PR #778](https://github.com/kochul2000/laymux/pull/778), [ADR-0113](0113-workspace-clear-activity-owned.md), [ADR-0121](0121-single-pane-clear-user-pointed-scope.md), [ADR-0137](0137-workspace-clear-ctrl-l-broadcast.md) 일부 정정

## Context

[ADR-0137](0137-workspace-clear-ctrl-l-broadcast.md)은 포커스된 pane의 `Alt+L`과 터미널에 직접 보내는 `Ctrl+L`이 같은 결과를 낸다고 보고 단일 pane 클리어를 폐지했다. 그러나 Codex에서 `Ctrl+L`은 현재 대화와 context를 유지한 채 터미널 표시만 지우고, `/clear`는 표시를 지우면서 새 chat을 시작한다. Claude Code와 Grok Build도 slash command로 대화를 초기화한다. 따라서 "화면만 정리"와 "현재 활동을 실제로 초기화"는 서로 다른 동작이다.

워크스페이스 클리어(`Ctrl+Alt+L`)는 여러 pane에 안전하게 보낼 수 있는 화면 정리 동작이어야 하므로 ADR-0137의 `Ctrl+L` 브로드캐스트가 여전히 맞다. 반면 사용자가 포커스한 pane 하나에 명시적으로 `Alt+L`을 누를 때는 해당 activity가 정의한 실제 클리어를 실행할 별도 표면이 필요하다.

실제 클리어는 터미널 입력을 발생시키고, agent의 진행 중 작업이나 입력 대기 모달을 중단하거나 잘못 답할 수 있다. shell과 agent가 요구하는 입력도 다르고, 등록되지 않은 TUI에 임의 문자열을 보내면 편집 버퍼를 오염시킬 수 있다. 그러므로 입력 종류와 busy 판정, 실패 정책을 한 소유자 아래에 둬야 한다.

범위는 포커스된 `TerminalView` pane 하나이며 workspace 격자와 dock을 모두 포함한다. 워크스페이스 전체 클리어의 의미와 구현은 비목표이고, 화면 클리어를 위해 `Ctrl+L` 자체를 가로채는 것도 비목표다.

## Decision

**단일 pane 실제 클리어(`pane.clearTerminal`, 기본 `Alt+L`)를 복구하고, activity handler가 클리어 입력과 busy 판정을 소유한다. 워크스페이스 클리어는 ADR-0137의 `Ctrl+L` 브로드캐스트를 그대로 유지한다.**

- `ShellActivityHandler`는 `settings.paneClear.shellCommand`를 제출하고, Claude·Codex·Grok handler는 `/clear`를 제출한다. `ActivityHandler.clearInput()`과 `isBusy()`가 이 계약의 단일 소유자다.
- 전용 handler가 없는 `interactiveApp`은 skip한다. 표시 계산을 위한 shell fallback을 쓰기 동작에 재사용하지 않는다.
- `settings.paneClear`는 `shellCommand`, `busyPolicy`(`skip` 기본, `interrupt`, `restart`), `interruptRounds`, `settleMs`를 소유한다. 과거 `workspaceClear` 이름은 현재 워크스페이스 브로드캐스트와 무관하므로 되살리지 않는다. 내부 개발 단계 정책에 따라 마이그레이션 로직은 만들지 않는다.
- `skip`은 busy pane을 건드리지 않는다. `interrupt`는 raw Ctrl+C를 설정된 횟수만큼 보낸 뒤 settle하고 실제 클리어 입력을 제출한다. `restart`는 입력 대신 기존 terminal restart store에 새 PTY를 요청한다.
- 포커스 범위는 [ADR-0121](0121-single-pane-clear-user-pointed-scope.md)을 다시 적용한다. 격자와 dock의 `TerminalView`가 대상이며, 비터미널 포커스의 키 입력은 no-op이다.
- 구현은 `ui/src/lib/pane-clear.ts`가 계획·실행·pane 조회를 소유한다. `workspace-clear.ts`와 실행 경로를 합치지 않는다. 두 기능은 이제 입력, 설정, 결과 계약이 다르기 때문이다.
- `POST /api/v1/panes/{paneId}/clear`를 복구한다. pane id는 dock도 표현하며, 비터미널/없는 pane은 오류다. 응답은 `cleared`·`interrupted`·`restarted`·`skipped`·`failed`와 Automation wait cap의 실제 적용값을 담는다.
- 입력은 사람의 제출 경로와 같은 `write_terminal_input(submit: true)`를 사용하고 human-control lease를 우회하지 않는다. Ctrl+C만 bracketed paste가 되지 않도록 raw terminal write를 사용한다.
- Automation의 interrupt→settle 대기는 bridge 5초 예산 안에서 cap하고, 응답이 끝난 뒤 새로운 입력을 내보내지 않도록 더 큰 별도 hard deadline을 둔다.

## Alternatives Considered

- **`Ctrl+L`만 유지한다.** 화면은 지워지지만 Codex chat context 같은 activity 상태는 남는다. 사용자가 요청한 "실제 클리어"를 제공하지 못한다.
- **PR #778을 전부 되돌린다.** 단일 pane 기능은 돌아오지만 워크스페이스 전체 클리어까지 activity별 입력과 busy 정책으로 되돌아간다. 여러 pane 화면을 안전하게 정리하는 현재 동작을 불필요하게 바꾼다.
- **고정 `skip` 정책만 두고 설정을 복구하지 않는다.** 구현은 작지만, busy pane을 명시적으로 interrupt/restart하려던 기존 요구와 PR #742의 동작을 잃는다. shell별 `clear`/`cls` 차이도 표현할 수 없다.
- **과거 이름 `settings.workspaceClear`를 그대로 복구한다.** 이 설정을 읽지 않는 워크스페이스 클리어와 이름이 충돌해 외부 계약이 오해를 만든다. 실제 소비자인 단일 pane 동작에 맞춰 `paneClear`로 둔다.
- **activity 이름 분기표를 pane clear 모듈에 둔다.** status·notification과 별개로 provider 지식이 중복되고 새 1급 agent를 추가할 때 한쪽만 갱신될 수 있다. 기존 handler registry를 확장하는 편이 책임 경계를 유지한다.

## Consequences

- ADR-0137의 워크스페이스 `Ctrl+L` 브로드캐스트 결정은 유지되고, 단일 pane 폐지 부분만 이 ADR이 대체한다.
- `Alt+L`은 readline의 `downcase-word`보다 laymux action이 우선한다. 충돌이 있는 사용자는 중앙 keybinding 설정에서 재바인딩할 수 있다.
- 기본 `skip`에서는 진행 중이거나 입력 대기 중인 agent pane에 아무 변화가 없다. UI 경로는 no-op/부분 실패를 경고 로그로 남기고 Automation 경로는 pane별 사유를 반환한다.
- `interrupt`는 작업을 중단할 수 있고, `restart`는 PTY·스크롤백·shell session을 교체한다. 둘 다 사용자가 설정에서 명시적으로 선택해야 한다.
- 사용자가 agent composer에 입력해 둔 초안은 관측할 수 없다. activity가 idle로 보이면 `/clear`가 그 초안 뒤에 붙을 수 있다는 기존 ADR-0113의 위험은 남는다.
- `ActivityHandler`에 쓰기 관련 계약이 다시 추가된다. 새 interactive app을 등록할 때 실제 클리어 입력과 busy 판정을 함께 정의하거나, 안전하게 skip하도록 capability를 명시해야 한다.
- 설정 스키마, Automation route/docs parity, keybinding, 격자·dock 포커스, activity별 입력, busy 정책과 deadline을 테스트로 고정한다.
- 재검토 조건: agent가 `/clear` 의미를 바꾸거나 안전한 structured new-chat API를 제공하면 텍스트 제출 대신 해당 계약을 사용한다. 등록되지 않은 TUI 지원 요구가 반복되면 전역 fallback이 아니라 app별 handler를 추가한다.
