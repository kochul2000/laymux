# 0324. Automation 은 사용자를 다른 워크스페이스·pane 으로 옮기지 않는다

- Status: Superseded by [0342](0342-automation-layer-activation-explicit-focus.md) (Automation 레이어 활성화의 기본 포커스 계약에 한함)
- Date: 2026-10-14
- Source: 사용자 요구("laymux 가 mcp 로 pane, workspace 를 추가, 수정 하더라도 자동으로 이동하지 마", 2026-10-14), [api-contracts.md](../architecture/api-contracts.md) §12 Automation API·MCP, [overview.md](../architecture/overview.md) §3.2 Terminal startup coordinator, [ADR-0043](0043-global-terminal-ready-startup-slot.md), [ADR-0161](0161-rendererless-terminal-session-startup.md)
- Relation: [ADR-0298](0298-pane-rearrangement-automation-parity.md)의 "Automation 재배치는 키보드 포커스를 옮기지 않는다"를 생성·분할·쓰기까지 확장한다. ADR-0043 의 시작 후보 범위를 Automation 요청에 한해 넓힌다. [ADR-0297](0297-pane-stack-slot-layer-model.md)의 `activate_pane_layer` 계약은 바꾸지 않는다.

## Context

에이전트가 MCP 로 워크스페이스를 만들고 그 안의 터미널에 명령을 보내면, 사용자가 보고 있던 화면이 그 워크스페이스로 넘어갔다가 돌아온다. 사용자는 이를 "자동 이동"으로 겪는다. 원인은 두 군데다.

- **쓰기 준비의 임시 전환.** `write_to_terminal` 대상이 아직 시작하지 않은 비활성 워크스페이스 터미널이면, 프론트엔드 `terminals.prepareForAutomation` 이 그 워크스페이스를 PTY 생성 동안 활성화했다가 원래 워크스페이스로 되돌렸다. 시작 조정기가 활성 워크스페이스·보이는 dock 만 시작 후보로 삼고, 한 번도 방문하지 않은 워크스페이스는 마운트조차 하지 않기 때문이다. 당시 근거는 "display:none 터미널은 크기가 없다"였지만 ADR-0161 이후 PTY 는 0 크기에서도 `80×24` 로 rendererless 시작한다.
- **`create_workspace(cwd)` 의 임시 전환.** cwd 를 레이어에 적용하려고 활성 워크스페이스를 새 워크스페이스로 바꿨다가 되돌렸다. 동기 구간이라 화면에는 안 보이지만 `activeWorkspaceId` 구독자(세션 체크포인트, 숨김 자동 종료 등)가 두 번의 전환을 관측한다.

추가로 `split_pane` 은 새 슬롯을 `paneIndex+1` 에 끼워 넣으면서 grid 포커스(슬롯 인덱스)를 보정하지 않아, 포커스 앞쪽 pane 을 나누면 키보드가 다른 pane 으로 넘어갔다.

범위는 Automation(REST·MCP) 경로다. 사용자 조작(UI·키보드)의 전환·포커스 동작, 명시적 이동 도구(`switch_workspace`·`focus_pane`·`focus_terminal`·`activate_pane_layer`), 숨긴 활성 워크스페이스를 대체 워크스페이스로 넘기는 hidden-item 동작은 바꾸지 않는다.

## Decision

**Automation 은 명시적 이동 요청이 아니면 활성 워크스페이스와 키보드 포커스(grid·dock)를 바꾸지 않는다. 대상이 백그라운드 워크스페이스에 있으면 사용자를 옮기는 대신 그 대상을 제자리에서 준비한다.**

- **이동은 이동 도구만.** 활성 워크스페이스나 포커스를 바꾸는 Automation 동작은 이름 자체가 이동인 `switch_workspace`, `focus_pane`, `focus_terminal`, `activate_pane_layer`(`focus=false` 가 아닐 때) 뿐이다. 생성·분할·재배치·쓰기·이름 변경 같은 나머지 동작은 이동하지 않는다.
- **생성·수정은 제자리.** `create_workspace` 는 새 워크스페이스를 활성화하지 않으며, cwd 는 `workspace-store.addWorkspace(name, layoutId, { cwd })` 가 워크스페이스를 만들 때 모든 레이어에 적용한다. `split_pane` 은 ADR-0298 재배치와 같이 포커스를 사용자가 보던 슬롯에 고정한다(`keepGridFocusOnSlot`).
- **백그라운드 터미널 준비.** `prepareForAutomation` 은 대상 레이어의 reveal 요청(`pane-reveal-store`)만 걸고 PTY 준비를 기다린다. 이 요청이 진행되는 동안:
  - 시작 조정기는 요청된 **워크스페이스 터미널**을 비활성 워크스페이스에 있어도 시작 후보로 삼는다. 같은 워크스페이스의 다른 pane 은 여전히 방문 전까지 보류한다. 숨은 dock pane 은 범위 밖이다.
  - `WorkspaceArea` 는 요청 대상을 가진 워크스페이스를 방문 전이라도 `display:none` 으로 마운트한다. 터미널은 ADR-0161 대로 rendererless 로 시작하고, 한 번 마운트한 워크스페이스는 기존 lazy-mount 규칙대로 유지한다.
  - 숨김 자동 종료는 요청 대상 pane 을 활성 워크스페이스 pane 처럼 사용 중으로 취급해 카운트다운과 eviction 에서 뺀다. 요청이 끝나면 카운트다운이 처음부터 다시 시작한다.
- **슬롯 계약은 그대로.** Automation 요청은 진행 중 슬롯을 선점하지 않고 전역 동시 시작 수를 늘리지 않는다(ADR-0043). 요청이 끝나 대상이 후보에서 빠지면 아직 첫 render 를 못 한 슬롯 owner 는 기존 eligibility 규칙대로 슬롯을 놓는다.

## Alternatives Considered

- **임시 전환을 유지하고 깜빡임만 줄인다.** 전환은 렌더·포커스·체크포인트 구독자가 모두 관측하는 실제 상태 변경이라 시각 효과만 숨길 수 없고, 사용자가 대기 중에 탐색하면 복원 판단도 꼬인다.
- **요청 대상 워크스페이스를 `visibility:hidden` 으로 레이아웃에 올린다.** 실제 크기로 시작할 수 있지만 ADR-0161 로 0 크기 시작이 이미 지원되고, 숨은 그리드가 활성 그리드와 겹쳐 히트 테스트·스크린샷 경로를 새로 검증해야 한다.
- **요청 대상 워크스페이스의 모든 터미널을 시작한다.** 이전 임시 전환과 결과가 같지만 에이전트가 쓰지 않을 PTY 까지 띄워 lazy-mount 의 GPU·프로세스 절감 목적을 해친다.
- **`activate_pane_layer` 의 `focus` 기본값을 `false` 로 바꾼다.** 레이어 "활성화"는 그 레이어를 앞으로 가져오는 이동 동사라 `focus_pane` 과 같은 부류이고, 기본값 변경은 기존 REST·MCP 호출자의 동작을 바꾸는 공개 API 호환성 파괴(release-policy 상 major)다. 표시만 바꾸려는 호출자는 이미 `focus=false` 로 그렇게 할 수 있다.

## Consequences

- 에이전트가 백그라운드에서 워크스페이스를 만들고 터미널을 시작·조작해도 사용자 화면과 키보드는 그대로다.
- 외부 계약(도구·엔드포인트·인자·기본값)은 바뀌지 않는다. 바뀌는 것은 생성·분할·쓰기 중 사용자 화면이 따라 움직이던 부작용뿐이다.
- 방문 전 워크스페이스에서 Automation 이 시작한 터미널은 사용자가 처음 볼 때 그때 렌더러를 연다. 그 사이 출력은 rendererless buffer 에 보존된다(ADR-0161).
- 요청 대상 pane 이 첫 render 전까지 슬롯을 잡고 있다가 요청 종료로 후보에서 빠질 때 슬롯을 놓으므로, 다른 pane 의 시작 지연은 요청 대기 시간 이하로 묶인다.
- 새 Automation 동작을 추가할 때 같은 원칙(명시적 이동 도구가 아니면 활성 워크스페이스·포커스 불변)을 따른다. 활성 워크스페이스 밖 대상을 직접 조작하는 요구가 생기면 ADR-0298 의 대상 범위와 함께 다시 정한다.
