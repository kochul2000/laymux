# 0151. Remote 워크스페이스 목록은 PC selector의 표시 모델을 계속 미러한다

- Status: Accepted
- Date: 2026-08-12
- Source: 사용자 요구(Remote와 PC의 워크스페이스·pane·상태·하단 요약 정보 일치); [architecture/api-contracts.md §13.3](../architecture/api-contracts.md); [ADR-0018](0018-remote-navigation-ui-state.md)의 inactive pane 생략 결정과 이를 전제로 한 [ADR-0020](0020-remote-dock-terminal-navigation.md)·[ADR-0039](0039-remote-spatial-notification-step-navigation.md)·[ADR-0047](0047-remote-spatial-workspace-exclusions.md) 부분 정정

## Context

Remote drawer는 PC `WorkspaceSelectorView`와 같은 정렬·숨김·일부 표시 설정을 받지만, 비활성 workspace의 `panes`를 빈 배열로 축약했다. 사용자는 다른 workspace를 선택해야만 그 pane 목록을 볼 수 있었고, pane 결과 칸은 PC의 명령 상태(작업 중·성공·실패) 대신 unread 숫자를 표시했다. PC workspace 행의 마지막 명령 또는 최신 알림 한 줄도 Remote에는 없었다.

이 정보는 고정 메타데이터가 아니다. terminal activity·명령 결과·알림과 `workspaceSelector.display`, 경로 ellipsis, Claude/Codex 상태 문구 설정이 런타임에 바뀐다. Remote가 이를 별도 규칙으로 계산하거나 연결 시점 snapshot에 고정하면 두 표면이 다시 어긋난다.

Remote는 계속 focused terminal controller이며 PC workspace 편집 기능 전체를 복제하지 않는다. 이번 결정의 범위는 drawer의 읽기용 정보 표시와 기존 직접 navigation이다. workspace/pane 편집 action, 숨김 편집, 설정 편집을 Remote에 추가하는 것은 비목표다.

## Decision

**Remote drawer는 선택 여부와 무관하게 모든 visible workspace의 pane 표시 정보와 하단 상태 한 줄을 PC `WorkspaceSelectorView`의 현재 계산 결과·설정에서 받아 계속 미러한다.**

- frontend bridge의 `workspaces.list`는 모든 workspace pane에 PC의 `computePaneNumbers` 결과를 붙이고, workspace마다 PC selector와 같은 terminal/notification raw state로 계산한 `selectorSummary`를 제공한다. 아직 mount되지 않은 terminal pane은 PC와 Remote가 함께 쓰는 projection에서 persisted profile/lastCwd 기반 placeholder로 만든다.
- frontend bridge의 `terminals.list`는 PC의 공용 formatter와 현재 설정으로 계산한 `selectorDisplay`(환경 축약명·activity 라벨/색·CWD 축약)와 activity handler가 계산한 `selectorStatus`를 terminal마다 제공한다. Rust와 Remote JavaScript는 provider별 작업 상태나 경로 표시를 재판정하지 않는다.
- `/remote/v1/navigation`의 모든 `workspaces[].panes`를 채운다. 각 pane은 `selectorDisplay`·`selectorStatus`를, workspace는 `selectorSummary`를 전달한다. 이는 ADR-0018의 inactive-pane 생략 결정과 ADR-0020/0039/0047에서 그 생략을 전제로 한 부분만 대체하며 dock 분리·host-owned 공간순회 결정은 유지한다.
- Remote는 PC `workspaceSelector.display`의 minimap/environment/activity/path/result gate와 path ellipsis를 그대로 적용한다. `result`는 PC와 같이 명령 상태 아이콘을 우선하고 unread는 아이콘 링 또는 점으로 표시한다.
- 각 workspace는 pane 목록 아래에 항상 한 줄 높이의 상태 행을 둔다. 최신 명령이 있으면 계산된 아이콘·문구(또는 명령)·상대 시간을, 없고 최신 unread 알림이 있으면 그 메시지를 표시하며 둘 다 없으면 빈 높이를 유지한다.
- navigation drawer가 열려 있고 controller lease와 문서 가시성이 유지되는 동안 2초마다 read-only navigation snapshot을 다시 읽는다. drawer를 닫거나 disconnect하거나 문서가 숨겨지면 폴을 멈춘다. 갱신 중 terminal 선택 revision이나 lease가 바뀌면 늦은 snapshot은 버린다.
- 모든 workspace의 pane ID를 알게 되었으므로 ADR-0047의 workspace↔pane 제외 승격/강등은 active workspace에 한정하지 않고 최신 snapshot의 모든 workspace에서 즉시 일치시킨다.
- hidden workspace/pane의 기존 payload 플래그와 Remote collapse, dock 분리, terminal output/lease 계약은 바꾸지 않는다.

## Alternatives Considered

- **비활성 workspace를 선택할 때만 pane을 조회**: payload는 작지만 정보를 보려면 PC 상태를 바꾸어야 하므로 요구를 충족하지 못한다.
- **Remote JavaScript에서 raw terminal state를 다시 계산**: payload는 원시 상태 위주로 유지할 수 있지만 Claude/Codex handler와 설정 해석이 복제되어 두 표면이 다시 갈릴 위험이 크다.
- **연결 또는 수동 Refresh에서만 갱신**: 구현은 단순하지만 activity·명령 결과·PC 표시 설정처럼 변하는 정보가 열린 drawer에서 stale해진다.
- **전체 React `WorkspaceSelectorView`를 Remote에 탑재**: 시각적 재사용은 크지만 focused standalone page에 Zustand/Tauri UI 런타임과 편집 action을 끌어와 권한·bundle·수명주기 경계를 크게 넓힌다.
- **drawer가 닫혀도 계속 고빈도 폴링**: 다시 열 때 즉시 최신일 수 있으나 사용자가 볼 수 없는 동안 frontend bridge와 Remote server에 지속 부하를 만든다. 열 때 즉시 조회하면 같은 UX를 더 좁은 비용으로 제공한다.

## Consequences

- 사용자는 PC의 active workspace를 바꾸지 않고 Remote에서 모든 workspace pane의 환경·activity·경로·결과와 workspace 하단 상태를 비교할 수 있다.
- PC 표시 토글과 agent 상태 문구 설정은 Remote 전용 복사본 없이 다음 drawer snapshot에 반영된다.
- navigation payload와 drawer DOM 크기는 전체 workspace pane 수에 비례해 늘고, 열린 drawer는 2초 주기로 여러 frontend bridge read를 수행한다. 폴은 보이는 drawer에만 한정하며 in-flight 중복을 막는다.
- `workspaces.list`와 `terminals.list`에는 additive `selectorSummary`·`selectorDisplay`·`selectorStatus` 표시 필드가 생긴다. 기존 Automation/MCP 소비자는 모르는 필드를 무시할 수 있다.
- inactive workspace pane ID가 공개되므로 기존 Remote 공간순회 제외 localStorage를 별도 마이그레이션하지 않고 다음 snapshot에서 add-only reconcile한다.
- Rust payload unit test, frontend bridge test, Remote page contract test와 Playwright UI test가 inactive pane·공용 상태 계산·하단 요약·가변 설정 갱신 경계를 고정한다.
