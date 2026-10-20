# 0350. Automation은 화면 전환 없이 대상 workspace와 pane을 직접 조작한다

- Status: Proposed
- Date: 2026-10-20
- Source: 사용자 요구(MCP 전수 조사 및 활성 workspace 제약 제거), [api-contracts.md §12](../architecture/api-contracts.md#12-automation-api), [ADR-0298](0298-pane-rearrangement-automation-parity.md), [ADR-0324](0324-automation-never-navigates-user.md), [ADR-0342](0342-automation-layer-activation-explicit-focus.md)
- 관계: ADR-0298의 활성 workspace 한정 대상 범위를 대체하며, ADR-0324의 비탐색 작업 중 포커스 보존 원칙을 직접 대상 지정에 적용한다.

## Context

터미널 입출력은 안정적인 ID로 비활성 workspace에 접근하지만 split·stack·삭제·재배치 등은 활성 workspace의 인덱스만 받는다. watch-review 스킬은 이 차이를 우회하려고 사용자 화면을 감시자 workspace로 전환했다가 되돌린다. 전환은 실제 탐색이며 원래 입력 대상도 복원하지 않는다. 자동화가 사용자의 현재 화면과 무관한 작업을 수행하려면 대상 선택과 탐색을 분리해야 한다.

범위는 MCP 전체의 대상 지정 대조와 같은 동작의 REST·frontend bridge·store 경로다. UI와 Remote의 명시적 탐색, 터미널 출력 처리, 인증 정책은 변경하지 않는다. 서로 다른 workspace 사이의 레이어 합치기 같은 새로운 기하 연산은 추가하지 않는다.

## Decision

**Automation은 workspace와 pane을 직접 지정하며, 대상 접근을 위해 활성 workspace를 임시로 바꾸지 않는다.**

- 인덱스 기반 pane 도구는 선택적 `workspace_id`를 받아 비활성 workspace를 조작한다. 생략 시 기존 활성 workspace 기본값을 유지한다. workspace 간 슬롯 이동에서는 기존 `workspace_id`가 목적지이므로 `source_workspace_id`로 출발지를 지정한다.
- 단일 pane 대상은 안정적인 `pane_id`로도 지정할 수 있다. 슬롯 ID 또는 그 슬롯의 레이어 ID를 전역에서 해석한다. workspace·인덱스를 함께 제공하면 같은 대상을 가리켜야 하며 불일치·알 수 없는 대상은 변경 전에 거부한다. 인덱스를 제공할 때는 정수·범위를 검사한다.
- 레이어 이동·꺼내기는 이미 받은 안정적인 레이어 ID의 소유 workspace를 사용한다. 동일 workspace 내 재배치라는 도메인 경계는 유지한다. 두 슬롯을 지정하는 교환·합치기는 명시한 workspace 안에서 해석한다.
- store 액션이 대상 workspace에서 직접 불변식을 갱신한다. bridge는 대상을 해석하고 기존 도메인 액션을 호출한다. `setActiveWorkspace`를 이용한 임시 실행·복원은 금지한다. 활성 workspace의 살아남은 입력 슬롯·dock 포커스는 기존 보존 규칙을 적용한다.
- 명시적 `focus_pane`도 대상을 직접 받을 수 있지만 탐색 도구이므로 의도한 포커스 전환을 수행한다. `switch_workspace`·`focus_terminal`과 함께 사용자 요청에 따른 탐색에만 사용한다. 입출력·생성·정리의 선행 단계로 호출하지 않는다.
- REST는 camelCase로 같은 대상 지정 계약을 제공한다. 기존 경로 인덱스와 안정적인 ID를 함께 지정하면 일치 여부를 검사한다. 도구 설명과 watch-review 스킬에서 임시 전환 지시를 제거한다.
- frontend의 거부 응답은 공통 MCP bridge에서 `isError: true`로 전달한다. 본문에 `success:false`가 있는데 도구 호출 자체를 성공으로 응답하지 않는다. REST의 기존 오류 본문은 유지한다.

## Alternatives Considered

- 임시 전환 후 포커스까지 복원: 중간 화면 이동과 구독자 부작용이 남고 비동기 작업 중 사용자 탐색과 경합하므로 채택하지 않는다.
- 비활성 workspace 작업을 활성화될 때까지 보류: 사용자 탐색에 자동화 진행이 종속된다.
- MCP에서 store 상태를 복사해 별도 기하 연산 수행: UI와 Automation의 불변식 구현이 갈라지므로 기존 store 액션을 확장한다.
- 모든 호출에서 workspace ID를 필수화: 안정적인 ID가 이미 소유 workspace를 결정할 수 있고 기존 호출을 불필요하게 깨뜨린다.

## Consequences

에이전트는 사용자가 다른 workspace에서 입력하는 동안 pane 생성·정리·재배치를 수행할 수 있다. 대상 지정 인자 추가는 호환되는 기능 추가이므로 버전 영향은 minor다. 기존 활성 workspace 기본값은 대화형 간단 호출을 위해 남지만 지속 작업은 workspace 또는 안정적인 pane ID를 보관해 사용한다.

검증에는 비활성 workspace의 각 pane 연산, 잘못된 대상의 무변경 거부, grid·dock·DOM 포커스의 중간 전환 부재, 실제 MCP·REST 및 WSL에서의 입출력이 포함된다. 도구 전수 조사 결과는 living doc에 남긴다. 다중 창이나 workspace 간 레이어 연산이 필요해지면 대상 소유권을 다시 결정한다.
