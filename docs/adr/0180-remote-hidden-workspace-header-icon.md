# 0180. Remote 숨김 workspace 보관함은 상단 개수 아이콘으로 연다

- Status: Accepted
- Date: 2026-08-19
- Source: 사용자 요구(2026-08-19), [ADR-0153](0153-remote-hidden-item-visibility-controls.md), [overview.md §3.2](../architecture/overview.md#32-workspacearea), [api-contracts.md §13.3](../architecture/api-contracts.md#133-navigation-metadata)
- Amends: [ADR-0153](0153-remote-hidden-item-visibility-controls.md)의 Remote workspace 보관함 trigger 표현

## Context

ADR-0153은 Remote drawer가 숨긴 workspace를 별도 보관함에서 복원하도록 정하면서 `Hidden N` chip을 trigger로 명시했다. 현재 구현은 이 chip을 workspace 목록 바로 위의 전용 heading 행에 배치한다. 숨긴 workspace가 하나라도 있으면 좁은 모바일 화면에서 텍스트 trigger 하나가 가로 한 행을 계속 차지해, 실제 workspace와 terminal 정보를 보여 줄 세로 공간이 줄어든다.

숨김 상태와 복원 규칙의 정본, workspace-only shelf, 숨긴 개수의 가시성, 접근 가능한 open/close 상태는 유지해야 한다. Remote API, PC WebView 상태 소유권, pane별 eye 제어를 바꾸는 것은 범위가 아니다. 같은 Remote 문서를 실행하는 Direct browser와 Android E2E 표면은 동일한 표현을 사용한다.

## Decision

**Remote의 숨긴 workspace 보관함은 drawer 최상단 action row의 crossed-eye 아이콘과 개수 badge로 열며, workspace 목록 위의 전용 trigger 행은 두지 않는다.**

- trigger는 숨긴 workspace가 있을 때 workspace home에서만 표시하고, 0개이거나 다른 drawer subview에서는 숨긴다.
- 아이콘에는 현재 숨긴 개수 badge를 겹쳐 표시한다. 접근성 이름과 title에는 숨긴 개수와 open/close 동작을 텍스트로 제공하고, `aria-expanded`와 shelf 연결은 유지한다.
- shelf의 위치, 항목 정렬, 복원 후 진입/복원만 수행하는 두 action, 성공 뒤 navigation snapshot 재조회는 ADR-0153의 계약을 그대로 따른다.
- 숨김 상태와 개수는 navigation snapshot에서 계산하며 Remote 전용 영속 상태를 추가하지 않는다.

## Alternatives Considered

- **기존 `Hidden N` 전용 행 유지**: 텍스트 의미는 가장 직접적이지만 숨긴 항목이 있는 동안 모바일의 희소한 세로 공간을 계속 소비하므로 선택하지 않았다.
- **아이콘만 표시하고 개수 제거**: 가장 작지만 보관함 규모를 열기 전에 알 수 없고 기존 `N` 정보가 사라지므로 선택하지 않았다.
- **숨긴 항목이 없어도 아이콘 상시 표시**: 위치는 안정적이지만 동작할 대상이 없는 control이 상단 action row를 차지하므로 선택하지 않았다.
- **shelf를 header popover로 변경**: 목록 공간을 더 확보할 수 있지만 shelf의 스크롤·focus·복원 동작까지 바꾸는 별도 결정이므로 이번 범위에서 제외했다.

## Consequences

- 숨긴 workspace가 있어도 workspace 목록 위의 전용 행이 사라져 모바일에서 한 행만큼 세로 공간을 회수한다.
- 상단 action row의 가로 밀도는 높아진다. 다만 숨긴 항목이 있을 때만 아이콘을 표시하고 텍스트 대신 28px 공통 header control을 사용해 비용을 제한한다.
- 아이콘만으로 의미를 추측하지 않도록 동적 접근성 이름, title, 개수 badge를 함께 유지해야 한다.
- Playwright 회귀 테스트는 trigger가 header action row에 있고 전용 heading 행이 없으며, badge의 개수·크기·색상과 open/close 접근성 상태가 맞는지 검증한다.
- Remote API와 저장 스키마는 바뀌지 않으며 마이그레이션은 없다. 상단 action이 더 늘어 작은 폭에서 가로 밀도가 다시 문제가 되면 header action overflow 정책을 별도 결정으로 재검토한다.
