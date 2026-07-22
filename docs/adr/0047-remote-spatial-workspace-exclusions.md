# 0047. Remote 공간순회 워크스페이스 제외와 pane↔workspace 승격/강등

- Status: Accepted
- Date: 2026-07-22
- Source: 사용자 요구(issue #507 — Remote 왼쪽 패널에 workspace 단위 제외 버튼, pane 제외와 동일 아이콘, 모든 pane 제외 시 workspace 제외로 자동 승격 및 vice versa); [architecture/api-contracts.md §13.3](../architecture/api-contracts.md); [ADR-0046](0046-remote-spatial-pane-exclusions.md) 확장

## Context

ADR-0046은 Remote 공간순회에서 개별 pane을 제외하는 denylist(`Set<paneId>`)를 Remote 페이지 surface-local 상태로 두고, 상단 바의 현재 pane 토글로만 편집하게 했다. pane 수가 많은 workspace 하나를 통째로 순회에서 빼려면 그 workspace의 pane을 하나씩 상단 바에서 방문해 제외해야 하며, inactive workspace의 pane은 상단 바에 뜨지 않으므로 사실상 불가능하다.

이번 요구는 왼쪽 drawer의 각 workspace 행에 pane 제외와 같은 아이콘의 workspace 단위 제외 토글을 두고, "모든 pane이 제외되면 workspace 제외로 자동 승격, 그 반대도 성립"하게 하는 것이다. 즉 두 granularity(개별 pane, 전체 workspace)의 제외를 함께 제공하되 사용자가 보기에 두 표현이 어긋나지 않아야 한다.

제약이 하나 있다. Remote navigation snapshot은 active workspace의 pane 요약만 채우고 inactive workspace의 `panes`는 빈 배열이다(§13.3). 따라서 Remote 클라이언트는 active workspace의 pane ID만 알 수 있고, inactive workspace는 pane 멤버십을 모른다. 승격/강등 불변식은 pane ID를 아는 범위에서만 계산할 수 있다. host paneOverrides·settings·layout에 상태를 두지 않는다는 ADR-0046의 소유권 결정, notification 순회 비적용, PC 컨트롤 부재는 그대로 유지한다.

## Decision

**Remote 공간순회 제외를 pane 단위(`spatialExcludedPaneIds`)와 workspace 단위(`spatialExcludedWorkspaceIds`) 두 denylist로 확장한다. 둘 다 Remote 페이지의 surface-local `localStorage` 상태이고, spatial step 요청에 함께 실려 desktop이 eligible 순서에서 제거한다. 두 granularity는 active workspace에 한해 순수 함수로 계산되는 승격/강등 불변식으로 일관성을 유지한다.**

- workspace 제외 raw state의 SoT는 Remote 페이지의 `Set<workspaceId>`이며 `localStorage` 키 `laymux.remote.spatialExcludedWorkspaceIds`에 문자열 배열로 저장한다. 값이 없거나 잘못되면 빈 집합으로 복구한다. pane 집합과 마찬가지로 Remote 브라우저별 surface-local 선호이고 PC WebView·`settings.json`·layout·`paneOverrides`에 저장하지 않는다.
- `/remote/v1/navigation/spatial` body는 기존 `leaseId`·`direction`·`excludedPaneIds`에 더해 선택적 `excludedWorkspaceIds: string[]`를 받는다. 누락은 빈 배열과 같다. Rust는 lease 검증 후 두 목록을 frontend bridge `navigation.spatialStep`에 중계한다. desktop은 ADR-0039의 eligible 공간순서를 만든 뒤 **자기 pane ID가 `excludedPaneIds`에 있거나 소속 workspace ID가 `excludedWorkspaceIds`에 있는** pane을 제거한다. stale/non-eligible ID는 효과가 없다.
- 왼쪽 drawer의 각 workspace 행(터미널 pane이 있는 workspace만)에 pane 토글과 같은 circle-minus 아이콘 토글을 둔다. `aria-pressed=true`가 제외를 뜻하며 같은 버튼으로 다시 포함한다. 행 클릭의 workspace 전환과 겹치지 않게 토글 클릭은 버블링을 멈춘다.
- **승격/강등 불변식(pane ID를 아는 active workspace 한정):** `workspaceId ∈ 제외집합 ⟺ 그 workspace의 모든 terminal pane ∈ pane 제외집합`. 이 규칙은 부수효과 없는 순수 함수 3개로 구현해 테스트한다.
  - 상단 pane 토글: pane을 뒤집은 뒤 소속 workspace를 모두-제외면 승격, 아니면 강등.
  - drawer workspace 토글: workspace를 뒤집고 active workspace면 그 pane ID 전체를 pane 집합에 함께 추가/제거(vice-versa).
  - 진입 reconcile: workspace 제외집합에 있는 workspace가 active가 되면 그 pane ID를 pane 집합에 add-only로 확장. 강등을 유발하지 않으므로 상단 토글의 해제와 경쟁하지 않는다.
- inactive workspace는 pane 멤버십을 모르므로 workspace 단위로만 기록/토글하고, 순회 제외는 `excludedWorkspaceIds`만으로 완결된다(desktop이 workspace ID로 직접 필터). pane 집합 확장은 그 workspace로 진입할 때 이뤄진다.
- 모든 eligible pane이 두 제외로 사라지면 전체 폴백 없이 `no_included_panes` no-op을 반환한다(ADR-0046 유지). 제외 목록은 순회 대상을 좁히는 요청 파라미터일 뿐 새 권한이 아니며 endpoint의 token/IP/Origin gate와 active lease 요구는 변하지 않는다.

## Alternatives Considered

- **pane 집합 하나만 두고 workspace 제외를 항상 "그 workspace의 모든 pane 제외"로 표현**: inactive workspace의 pane ID를 클라이언트가 모르므로 표현 불가능하다. navigation snapshot에 inactive pane 요약을 추가하는 것은 payload/계약 확장이라 채택하지 않았다.
- **승격/강등 없이 두 집합을 완전 독립으로 운용**: 구현은 단순하지만 "모든 pane 제외 = workspace 제외"라는 사용자 요구를 충족하지 못하고 상단 토글과 drawer 토글의 상태가 어긋난다.
- **workspace 토글 시 즉시 host에게 pane 목록을 질의해 확장**: 왕복과 상태 소유권이 늘고 ADR-0046의 surface-local 결정과 어긋난다. 진입 시 reconcile로 충분하다.
- **host paneOverrides/settings/layout에 workspace 제외 저장**: 기기 간 공유는 가능하나 surface-local 선호를 공유 구성으로 승격시키고 export 의미까지 넓힌다. 동기화 요구가 생기기 전에는 채택하지 않는다(ADR-0046과 동일 판단).

## Consequences

- 기존 Remote 클라이언트와 새 클라이언트의 최초 동작은 모두 모든 eligible pane 순회다. 별도 초기화·마이그레이션이 없고 `excludedWorkspaceIds` 누락은 빈 배열로 처리된다.
- 두 제외 설정은 브라우저 origin/profile별로 유지되며 다른 기기와 자동 동기화되지 않는다. 삭제된 pane/workspace의 stale ID가 남아도 순회에 영향이 없고 별도 정리 수명주기가 불필요하다.
- 승격/강등 불변식은 active workspace에만 강제되므로, inactive 상태에서 workspace를 제외하면 그 workspace로 진입하기 전까지 상단 pane 토글에는 반영되지 않는다. 진입 reconcile가 그 시점에 일관성을 회복한다.
- 승격/강등 규칙을 순수 함수로 분리해 e2e(drawer 토글·localStorage·요청 반영·pane↔workspace 승격/강등)와 desktop 단위 테스트(`buildSpatialOrder`/`spatialStep`의 workspace 필터), Rust 정적 검증(page HTML·request 파싱·bridge 중계)으로 검증한다.
- 재검토 조건: inactive workspace pane 멤버십을 클라이언트가 알아야 하는 요구, 또는 기기 간 제외 동기화 요구가 생기면 SoT 위치를 다시 결정한다.
