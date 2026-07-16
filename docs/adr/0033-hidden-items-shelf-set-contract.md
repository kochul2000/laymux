# 0033. 숨긴 항목 보관함 — raw 숨김 상태와 결정론적 set 계약

- Status: Accepted
- Date: 2026-07-16
- Source: issue #459 · ADR-0004 · ADR-0005 · ADR-0006 · ADR-0017 · ADR-0018

## Context

WorkspaceSelector의 기존 숨김 UX는 전역 `hideMode`에 들어가 workspace와 Pane을 토글한 뒤 “적용” 버튼으로 나오는 방식이었다. 그러나 실제 hidden ID는 토글할 때마다 즉시 localStorage에 저장되어 적용 단계가 없었고, mode가 켜진 동안 workspace 탐색이 막히며 blur로 자동 종료되어 외부 자동화가 동일한 화면을 안정적으로 재현하기 어려웠다. workspace에는 평상시 빠른 숨김 경로가 있었지만 Pane에는 없어 계층별 조작 모델도 달랐다.

숨김 상태는 `hiddenWorkspaceIds`와 `hiddenPaneIds`라는 독립 raw state이고, 삭제된 항목의 stale ID나 숨긴 workspace 아래의 hidden Pane까지 단순히 set 크기로 세면 사용자가 복원할 수 있는 항목 수와 UI가 불일치한다. 또한 자동화의 toggle 계약은 호출 시점의 기존 상태에 의존하므로 스크린샷·e2e에서 원하는 보관함 open 상태를 결정론적으로 만들 수 없다.

## Decision

- 전역 `hideMode`와 blur/apply 수명주기를 제거한다. workspace와 Pane은 평상시 목록에서 즉시 숨기고, 별도 bottom shelf에서 다시 표시한다.
- `hiddenWorkspaceIds`와 `hiddenPaneIds`는 계속 독립 raw state로 유지하고 localStorage key도 보존한다. visible 목록, 유효 숨김 수, shelf grouping, stale ID, active workspace fallback은 workspace 구조와 raw state를 입력받는 단일 순수 계산 모듈에서 파생한다.
- hidden workspace 아래의 hidden Pane flag는 유지하지만 top-level Pane 복원 목록에는 중복하지 않는다. workspace만 다시 표시해도 그 안의 Pane flag는 유지하며, “모두 표시”만 두 hidden set을 함께 비운다.
- 복원 action은 toggle이 아닌 명시적 set semantics를 사용하고, 같은 전환에서 해당 terminal eviction을 제거한다. 숨김 terminal 타임아웃 interval은 만료 판정에만 사용하며 hidden/active raw state 변경은 즉시 평가한다.
- Automation REST의 `POST /api/v1/ui/hide-mode/toggle`과 MCP `toggle_hide_mode`를 제거하고, `POST /api/v1/ui/hidden-items` body `{ "open": boolean }`, frontend bridge `ui.setHiddenItemsOpen`, MCP `set_hidden_items_open`으로 교체한다. 이 계약은 dev 전용 UI 검증 계약이며 같은 값을 반복해서 설정해도 결과가 같은 idempotent set semantics다.
- 기존 workspace/Pane hidden toggle REST·MCP 계약은 호환을 위해 유지한다. UI 내부의 숨김·복원은 명시적 set action을 사용한다.
- ADR-0018의 `/remote/v1/navigation` payload는 계속 hidden/collapsed raw flags를 포함한다. Focused remote surface의 payload 호환성은 유지하되, desktop selector는 숨김 행을 DOM 목록에서 필터하고 보관함에서 복원한다. 따라서 ADR-0018의 “desktop 접힘 모델과 일치”는 공유 raw state와 정렬 규칙에 대한 결정으로 좁혀 해석하며, remote `collapsed` 표현과 desktop DOM 구조가 같아야 한다는 뜻은 아니다.

## Consequences

- 사용자는 탐색 모드 전환 없이 workspace와 Pane을 같은 방식으로 즉시 숨기고, 항상 보이는 유효 count chip에서 복원 경로를 찾을 수 있다.
- 보관함 표시와 count는 raw set 크기가 아니라 현재 workspace 구조에서 유효한 파생 상태이므로 stale ID와 계층 중복을 노출하지 않는다.
- 자동화는 기존 상태를 먼저 읽지 않고도 보관함을 정확히 열거나 닫을 수 있다. 반대로 `toggle_hide_mode` 호출자는 새 `set_hidden_items_open` 계약으로 이전해야 한다.
- active workspace를 숨기는 UI 경로는 다음 visible workspace를 먼저 활성화해야 하며, 마지막 visible workspace는 숨길 수 없다. 외부 toggle 호환 경로에서도 selector가 사라진 active context를 만들지 않도록 coordinator가 같은 invariant를 강제한다.
- 숨김 raw state와 UI 파생 상태 사이에 계산 모듈이 추가되지만, selector·shelf·테스트가 동일한 규칙을 공유해 개별 컴포넌트의 중복 filter를 없앤다.
- Remote navigation 응답 형식은 바뀌지 않으므로 기존 remote client는 그대로 동작한다. desktop과 remote는 같은 raw hidden state를 읽지만 각 surface의 목적에 맞는 표시 모델을 갖는다.
