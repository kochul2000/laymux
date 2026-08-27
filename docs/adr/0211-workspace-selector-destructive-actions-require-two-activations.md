# 0211. Workspace selector 파괴적 action은 같은 컨트롤의 연속 두 번 활성화를 요구한다 (0033·0035 정정)

- Status: Proposed
- Date: 2026-08-27
- Source: 사용자 요구 · [data-flow.md §9](../architecture/data-flow.md) · [ADR-0033](0033-hidden-items-shelf-set-contract.md) · [ADR-0035](0035-workspace-only-shelf-per-pane-hide-toggle.md)
- Corrects: ADR-0033/0035의 desktop workspace quick-hide 즉시 실행 조항

## Context

Workspace selector에는 눈 아이콘으로 workspace를 목록에서 숨기는 action, 빗자루 아이콘으로 workspace 터미널 화면을 지우는 action, layout 메뉴에서 저장된 template을 지우는 action, X 아이콘으로 workspace와 그 pane을 닫는 action이 있다. 넷은 모두 사용자의 현재 작업 문맥이나 저장된 구성을 없애지만 확인 방식은 달랐다. 숨김·터미널 지우기·닫기는 한 번의 작은 아이콘 클릭으로 즉시 실행됐고, layout 삭제만 WebView의 native confirm dialog를 추가로 사용했다.

ADR-0033과 ADR-0035는 전역 hide mode와 별도 적용 단계를 없애기 위해 desktop quick-hide의 즉시 실행을 정했다. 그러나 이는 숨김 raw state와 복원 모델을 단순화하려는 결정이었으며, 작은 인접 컨트롤의 오클릭까지 감수해야 한다는 요구는 아니었다. 이번 결정의 범위는 desktop `WorkspaceSelectorView` 안의 네 파괴적 컨트롤에 한정한다. Pane control bar의 표시 토글, workspace 키바인딩, Automation·MCP·Remote 계약과 각 domain action의 상태 소유권은 비목표다.

## Decision

Desktop Workspace selector의 숨기기·터미널 지우기·layout 삭제·닫기 action은 같은 컨트롤을 연속 두 번 활성화해야 실행한다.

- `settings.workspaceSelector.confirmDestructiveActions`가 이 UI gate의 단일 진실원이다. 누락·유효하지 않은 값의 기본은 `true`이며 Settings의 Workspaces → Behavior에서 변경한다. `false`이면 첫 활성화가 confirmation 상태를 만들지 않고 기존 domain action을 바로 실행한다.
- 첫 활성화는 해당 버튼 컴포넌트의 일시적인 confirmation 상태만 설정한다. workspace/layout/UI store와 세션에는 어떤 변경도 쓰지 않는다.
- confirmation 상태의 같은 컨트롤을 다시 활성화할 때만 기존 domain action을 호출한다. 숨김은 `setWorkspaceHiddenWithFallback`, 터미널 지우기는 `runWorkspaceClearFromUi`, layout 삭제와 workspace 닫기는 기존 workspace store action의 소유권을 그대로 유지한다.
- confirmation 상태에서는 대상 이름을 포함한 접근성 이름과 tooltip을 “다시 클릭” 문구로 바꾸고, danger 색으로 현재 대기 상태를 표시한다.
- 포인터가 컨트롤을 떠나거나, focus를 잃거나, Escape를 누르거나, 메뉴/컴포넌트가 닫히면 confirmation 상태를 폐기한다. 상태는 저장하거나 다른 컨트롤로 공유하지 않는다.
- native `window.confirm`은 이 네 action의 확인 수단으로 사용하지 않는다. 포인터 클릭과 Enter/Space가 만드는 버튼 activation은 같은 두 단계 규칙을 따른다.
- `workspace.clearTerminals`·`workspace.close` 키바인딩과 Automation·MCP·Remote action은 클릭 컨트롤이 아니므로 기존처럼 요청 한 번에 실행한다. 외부 API와 hidden raw state 계약은 바꾸지 않는다.

## Alternatives Considered

- **모든 action에 native confirm dialog 사용** — 명시적 Confirm/Cancel을 제공하지만 작업 흐름과 focus를 별도 창으로 옮기고 WebView별 표현이 달라진다. 작은 selector 안에서 같은 대상을 두 번 확인하는 요구에 비해 무겁다.
- **브라우저 `dblclick` event 하나로만 실행** — OS double-click 시간 안에 빠르게 눌러야 하고 첫 클릭 뒤 confirmation 상태를 설명할 수 없다. 키보드와 touch activation에도 동일한 계약을 제공하기 어렵다.
- **시간 제한만 두고 첫 클릭 뒤 어디서든 두 번째 클릭 허용** — 다른 workspace나 action을 두 번째 클릭으로 잘못 소비할 수 있다. 같은 컨트롤을 다시 활성화해야 대상과 의도가 일치한다.
- **기존 즉시 실행과 Undo만 유지** — workspace 숨김에는 Undo가 있지만 workspace 닫기와 layout 삭제에는 동등한 복원이 없다. 네 파괴적 action의 오클릭 방지 수준도 계속 달라진다.
- **항상 두 번 확인하고 설정을 제공하지 않기** — 가장 단순하지만 숙련 사용자가 반복 action의 추가 클릭 비용을 선택적으로 제거할 수 없다. 안전한 기본값은 유지하되 명시적 opt-out을 settings에 둔다.

## Consequences

- 기본 설정에서는 작은 눈/빗자루/X/menu action의 단일 오클릭이 상태를 변경하지 않으며, 사용자는 같은 자리의 시각·접근성 피드백으로 두 번째 활성화 대상을 확인한다.
- 의도한 파괴적 action에는 활성화 한 번이 추가된다. 포인터를 버튼 밖으로 옮기거나 focus를 바꾸면 처음부터 다시 활성화해야 한다.
- 확인 정책은 `settings.json`에 영속하지만 desktop UI의 armed 상태는 domain store와 분리된 ephemeral state다. 내부 개발 단계 정책에 따라 기존 파일 마이그레이션은 만들지 않으며 누락 시 기본 `true`를 적용한다. hidden item 파생 계산, active workspace fallback과 외부 계약은 바뀌지 않는다.
- Workspace selector 통합 테스트는 첫 활성화 무효과, confirmation 표시, 두 번째 활성화의 기존 결과를 각각 검증해야 한다. locale은 대상 이름이 포함된 confirmation 문구를 양쪽 언어에 제공한다.
- 사용성 검증에서 두 번째 활성화가 잦게 유실되거나 touch에서 발견성이 부족하다고 확인되면, 동일 domain action을 유지한 채 인라인 Confirm/Cancel affordance로 표현만 재검토한다.
