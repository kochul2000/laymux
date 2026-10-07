# 0297. Pane 재배치를 사용자 조작 수준까지 Automation/MCP 에 연다

- Status: Accepted
- Date: 2026-10-07
- Source: 사용자 요구("유저가 할 수 있는 정도까지는 넣어줘야지", 2026-10-07), [ADR-0295](0295-pane-stack-slot-layer-model.md) 2차 범위(레이어 재배치), issue #380(워크스페이스 간 이동), [api-contracts.md](../architecture/api-contracts.md) §12 Automation API·MCP
- Relation: [ADR-0295](0295-pane-stack-slot-layer-model.md)의 Automation 계약(`stack_pane`·`activate_pane_layer`·`remove_pane(layer_id)`)을 재배치까지 확장한다. ADR-0295 의 결정은 바꾸지 않는다.

## Context

ADR-0295 2차 범위로 사용자는 마우스로 pane 을 재배치할 수 있다. 스택 탭을 드래그해 순서를 바꾸거나 다른 슬롯의 스택으로 옮기고, 탭 메뉴로 레이어를 split 으로 꺼내고, 컨트롤 바를 이웃 pane 의 스택 띠에 떨어뜨려 합치고, 워크스페이스 목록에 떨어뜨려 슬롯을 다른 워크스페이스로 보낸다(issue #380).

Automation/MCP 는 이 중 위치 교환(`swap_panes`)과 레이어 추가·표시·닫기만 제공했다. 에이전트는 사용자가 할 수 있는 레이아웃 정리를 대신할 수 없었고, 하려면 pane 을 닫고 다시 만들어 터미널 세션을 잃어야 했다.

범위는 데스크톱 그리드에서 사용자가 할 수 있는 재배치까지다. Remote page 의 재배치 UI, 레이어 단위 워크스페이스 간 이동(UI 에도 없음), 임의 좌표로의 이동은 비목표다.

## Decision

**사용자가 데스크톱에서 할 수 있는 pane 재배치 네 가지를 각각 하나의 Automation 동작으로 연다. 각 동작은 그 UI 가 쓰는 workspace-store 액션을 그대로 호출하고, 키보드 포커스는 옮기지 않는다.**

| 사용자 조작 | REST | MCP | bridge `panes.*` | store 액션 |
|---|---|---|---|---|
| 스택 탭 드래그(순서·다른 슬롯) | `POST /api/v1/panes/layers/move` | `move_pane_layer` | `moveLayer` | `moveLayer` |
| 탭 메뉴 Split out | `POST /api/v1/panes/layers/extract` | `extract_pane_layer` | `extractLayer` | `extractLayer` |
| 컨트롤 바 → 스택 띠 | `POST /api/v1/panes/merge` | `merge_panes` | `merge` | `mergeSlotIntoStack` |
| 컨트롤 바 → 워크스페이스 | `POST /api/v1/panes/{index}/move-to-workspace` | `move_pane_to_workspace` | `moveToWorkspace` | `movePaneToWorkspace` |

- **SoT 와 의미.** 재배치 의미(슬롯이 비면 제거·재분배, 옮긴 레이어를 대상에서 표시, 합칠 때 소스의 표시 레이어를 표시, 워크스페이스 이동은 슬롯 통째)는 workspace-store 액션이 유일하게 소유한다. Bridge 는 식별자 해석·검증·응답 구성만 한다. UI 와 Automation 이 같은 액션을 쓰므로 두 경로의 결과가 갈라지지 않는다.
- **대상 범위.** 레이어·슬롯 식별은 활성 워크스페이스 안에서만 한다. 드래그가 보이는 그리드 위에서만 일어나는 것과 같다. 레이어는 `layerId` 또는 `terminalId` 중 정확히 하나로 지정한다(`activate_pane_layer` 와 같은 규칙).
- **포커스.** `split`/`stack` 과 같이 Automation 재배치는 키보드 포커스를 옮기지 않는다. 표시할 레이어를 정하는 것은 store 액션이며, 포커스 전환이 필요하면 호출자가 `activate_pane_layer`/`focus_pane` 을 따로 부른다. UI 경로는 기존대로 `activatePaneLayer` 로 포커스까지 커밋한다.
- **실패.** 변화가 없는 요청은 오류로 돌려준다. 단일 레이어 꺼내기, 같은 슬롯 합치기, 같은 워크스페이스로의 이동, 소스 워크스페이스를 비우는 이동, 범위 밖 인덱스, 활성 워크스페이스에 없는 레이어가 해당한다. 예외로 `moveLayer` 는 같은 자리로의 이동을 `moved:false` 성공으로 돌려준다. 순서 지정은 멱등이어야 재시도가 안전하기 때문이다.
- **응답.** 재배치 뒤 인덱스는 바뀔 수 있으므로, 응답은 이동 후 상태에서 다시 계산한 위치(`paneIndex`·`layerIndex`·`layerCount`·`totalPanes`, 워크스페이스 이동은 `workspaceId`·`paneNumber`)를 싣는다.
- **방향 어휘.** 꺼내기 방향은 `split_pane` 과 같은 `horizontal`/`vertical` 이다.

## Alternatives Considered

- **하나의 범용 `rearrange_pane(kind, ...)` 도구.** 도구 수는 줄지만 kind 마다 필수 인자가 달라 스키마가 느슨해지고, 에이전트가 MCP 스키마만 보고 올바른 호출을 만들기 어렵다. 사용자 조작 하나에 도구 하나를 대응시키는 쪽이 기존 `split_pane`/`stack_pane`/`swap_panes` 와도 일관된다.
- **Bridge 에서 `pane-stack-actions`(UI 래퍼)를 호출.** UI 래퍼는 포커스까지 커밋하므로 "Automation 은 키보드를 빼앗지 않는다"는 split/stack 계약과 어긋난다. 의미는 store 액션에 있으므로 store 를 직접 호출해도 결과가 갈라지지 않는다.
- **레이어 단위 워크스페이스 간 이동도 제공.** UI 에 없는 조작이라 "사용자가 할 수 있는 정도"라는 범위를 넘는다. 필요해지면 `move_pane_layer` 를 다른 워크스페이스로 확장하는 별도 결정으로 다룬다.
- **임의 좌표/인덱스로 슬롯 이동.** 기하 불변식(ADR-0295 force)을 깨기 쉬운 데다 UI 에 대응 조작이 없다. 위치는 `swap_panes`·`move_pane_layer`·`extract_pane_layer` 조합으로 만든다.

## Consequences

- 에이전트가 터미널 세션을 잃지 않고 사용자와 같은 수준으로 레이아웃을 정리할 수 있다. 레이어 이동·꺼내기·합치기는 ADR-0295 대로 터미널을 재마운트하지 않는다. 워크스페이스 간 이동은 기존 #380 동작과 같다.
- MCP 도구가 4개 늘어난다. 도구 설명은 대응 UI 조작을 명시해 선택 비용을 줄인다.
- 새 store 액션이 생기면 같은 원칙(사용자 조작 ↔ 하나의 Automation 동작, store 액션 공유, 포커스 비이동)을 따른다. 스택 UI 의 재배치가 늘어나는데 Automation 이 따라가지 않으면 이 ADR 위반으로 본다.
- Remote 는 바뀌지 않는다. 재배치 결과는 기존 navigation snapshot 에 그대로 반영된다.
- 재검토 조건: 다중 창, 또는 활성 워크스페이스 밖 대상을 직접 조작해야 하는 요구가 생기면 대상 범위 규칙을 다시 정한다.
