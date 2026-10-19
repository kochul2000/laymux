# 0342. Automation 레이어 표시와 포커스는 별도 도구로 요청한다

- Status: Accepted
- Date: 2026-10-19
- Source: 사용자 요구(MCP pane 제어가 다른 pane의 작업을 방해하지 않으며 포커스는 별도 MCP로 분리), [api-contracts.md §12.7](../architecture/api-contracts.md#127-내장-mcp-서버), [ADR-0081](0081-pane-focus-transition-single-owner.md), [ADR-0324](0324-automation-never-navigates-user.md), [ADR-0328](0328-automation-stack-keeps-visible-layer.md)
- 관계: ADR-0297·0324의 Automation 레이어 활성화와 포커스 결합 계약을 대체한다. 사용자 UI·Remote 탐색의 포커스 정책은 유지한다.

## Context

Automation 생성·분할·쓰기에는 이미 사용자 탐색 상태를 보존하는 계약이 있다. 실제 dev MCP 호출에서도 이들 동작과 출력 읽기·숨은 스택 쓰기가 DOM 포커스를 유지하는 것을 확인했다. 그러나 `activate_pane_layer`는 `focus` 생략을 true로 해석해 다른 pane을 표시하는 것만으로 워크스페이스와 키보드 포커스를 바꾼다. 표시와 포커스를 구분해서 요청할 수 있어야 한다.

기본값만 false로 바꾸어도 충분하지 않다. 입력 중인 슬롯의 표시 레이어를 바꾸면 grid 인덱스는 같아도 이전 입력 요소가 숨겨지고 새 view가 포커스를 받는다. 포커스 보존에는 현재 표시 콘텐츠도 포함된다. PTY·출력 처리, 설정 스키마, 사용자 버튼과 단축키는 범위 밖이다.

## Decision

**Automation 레이어 표시는 사용자 포커스를 보존하며, 포커스 이동은 별도 탐색 도구로만 요청한다.**

- MCP `activate_pane_layer`와 REST `POST /api/v1/panes/layers/activate`, frontend bridge에서 `focus` 인자를 제거한다. MCP·REST의 요청 타입은 알 수 없는 필드를 거부하고 bridge도 제거된 `focus` 인자를 상태 변경 전에 거부한다. 이 동작은 워크스페이스 전환·포커스 이동을 수행하지 않는다.
- 표시는 비활성 워크스페이스 또는 포커스 없는 슬롯의 활성 레이어만 바꾼다. 활성 워크스페이스의 grid 포커스 슬롯에서 다른 레이어로 바꾸려 하면 상태 변경 전에 오류로 거부한다. 이미 표시 중인 레이어는 성공하는 no-op이다. dock이 포커스를 가진 동안 grid 슬롯 표시는 허용한다.
- `workspace-transition.activatePaneLayer`가 내부 `focus: false` 호출의 불변식을 검사한다. Automation adapter는 거부를 성공으로 응답하지 않으며 별도 `focus_terminal`이 필요함을 설명한다. `focus_terminal`은 대상 레이어 표시·워크스페이스 전환·슬롯 포커스를 함께 수행한다. `focus_pane`·`switch_workspace`도 각자 기존의 명시적 탐색 역할을 유지한다. 표시 후 원상복구하거나 DOM 포커스를 강제로 되돌리지 않는다.
- 생성·분할·읽기·쓰기에는 포커스 옵션을 추가하지 않는다. 준비되지 않은 터미널에도 기존 reveal·readiness 경로를 쓰고 화면 이동은 별도로 요청한다. UI·Remote의 직접 탐색은 기존 domain action의 기본 포커스 동작을 유지한다.

## Alternatives Considered

- 기존 기본값 유지와 설명만 보강: 인자 생략 자체가 포커스를 빼앗는 동작을 계속 허용한다.
- 활성화의 `focus` 옵션을 유지하거나 다른 pane 도구에도 추가: 표시·읽기·쓰기와 탐색을 다시 결합하고 정책을 중복한다. 기존 포커스 전용 도구로 충분하다.
- 기본값만 false로 변경: 입력 중인 슬롯의 레이어 교체가 DOM 포커스를 바꾸는 구멍이 남는다.
- 레이어를 숨긴 뒤 DOM 포커스 복원: 숨은 입력 요소로 키가 들어가거나 중간 전환이 사용자에게 노출된다.

## Consequences

백그라운드 표시를 요청하는 에이전트가 사용자의 현재 입력 대상을 바꿀 수 없다. 기존 활성화 호출자가 포커스 이동에 의존했다면 별도 포커스 도구를 호출해야 하며, `focus` 인자는 제거해야 한다. 공개 API의 인자 제거·동작 변경이므로 버전 영향은 major다. 릴리스 버전 파일은 이 작업에서 변경하지 않으며 발행 시 누적 변경과 함께 판정한다.

회귀 검증은 domain과 bridge의 상태 보존·사전 거부·dock 예외·명시적 포커스, 실제 dev MCP/REST와 DOM focus 이벤트 및 키보드 입력 대상을 포함한다. 현재 콘텐츠 교체 없이 미리보기를 제공할 필요가 생기면 별도 preview surface를 설계한다.

실기 검증에서 숨은 레이어가 startup 슬롯을 점유한 동안 다른 미시작 워크스페이스에 즉시 쓰면 기존 frontend bridge 응답 기한을 넘는 별도 문제가 관측됐다. 포커스 이동은 발생하지 않으며, 시작 큐·readiness 대기 예산의 정합성은 이 결정의 범위 밖이다. 포커스 회귀 하네스는 미방문 워크스페이스의 시작을 숨은 레이어 연속 시작과 분리한다.
