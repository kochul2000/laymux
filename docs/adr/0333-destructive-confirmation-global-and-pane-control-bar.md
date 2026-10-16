# 0333. 파괴적 action 두 번 확인을 전역 설정으로 올리고 pane 컨트롤 바에도 적용한다 (0211 설정 키·적용 범위 대체)

- Status: Proposed
- Date: 2026-10-16
- Source: 사용자 요구(pane 컨트롤 바의 Restart view·Clear view·Delete pane이 한 번 클릭에 실행됨) · [ADR-0211](0211-workspace-selector-destructive-actions-require-two-activations.md) · [api-contracts.md](../architecture/api-contracts.md) Settings
- Supersedes: ADR-0211의 설정 키(`workspaceSelector.confirmDestructiveActions`)와 "pane control bar는 비목표" 범위 조항. 두 번 활성화 규칙 자체는 유지한다.

## Context

ADR-0211은 Workspace selector의 숨기기·터미널 지우기·layout 삭제·workspace 닫기를 같은 컨트롤의 두 번 활성화로 보호하고, 그 gate를 `settings.workspaceSelector.confirmDestructiveActions`에 두었다. pane 컨트롤 바는 명시적 비목표였다.

그 결과 사용자는 "파괴적 동작은 두 번 클릭"이라는 정책을 켜 두었는데도, 모든 pane에 붙은 빨간 Restart view(터미널 프로세스 재시작)·Clear view(View를 EmptyView로 교체)·Delete pane(pane 또는 stack 레이어 닫기) 버튼은 한 번 클릭에 실행된다. 셋 다 실행 중인 셸·에이전트 세션이나 pane 구성을 되돌릴 수 없이 없애며, 작은 아이콘이 나란히 붙어 있어 오클릭 위험이 selector보다 크다. 정책이 selector 이름 아래에 있어 적용 범위가 사용자 기대와 어긋난다.

범위는 desktop의 클릭 컨트롤이다. 비목표: pane 컨트롤 바의 빗자루(Clear terminal, 화면만 지우는 단축 동작), 키바인딩, Automation·MCP·Remote 계약, 각 domain action의 상태 소유권.

## Decision

파괴적 action 두 번 확인은 root 설정 `settings.confirmDestructiveActions` 하나가 지배하며, Workspace selector의 네 컨트롤과 pane 컨트롤 바의 Restart view·Clear view·Delete pane에 같은 규칙을 적용한다.

- `settings.confirmDestructiveActions`(boolean, 기본 `true`)가 단일 진실원이다. Rust `Settings`와 프론트 settings-store 모두 root에 두며 `workspaceSelector` 아래의 같은 키는 제거한다. 누락 시 `true`, boolean이 아닌 값은 `true`로 정규화한다. 내부 개발 단계 정책에 따라 옛 키 마이그레이션은 만들지 않는다.
- 설정 UI는 Settings → Interface → Confirmation 토글이 소유하고 draft/save 흐름으로 저장한다. Workspaces → Behavior의 옛 토글은 제거한다.
- pane 컨트롤 바의 세 버튼은 selector와 같은 `TwoClickConfirmButton`을 쓴다. 첫 활성화는 버튼 로컬 confirmation 상태만 만들고 tooltip/접근성 이름을 `Click again to <title>`로 바꾼다. 같은 버튼의 두 번째 활성화에서만 기존 `onRestart`·`onClear`·`onDelete`를 호출한다. stack 레이어 닫기는 `Close layer` 제목을 그대로 문구에 쓴다.
- 포인터 이탈(touch 제외)·blur·Escape·컴포넌트 언마운트(컨트롤 바 숨김 포함)는 confirmation을 폐기한다. 상태는 저장하거나 다른 버튼과 공유하지 않는다.
- 설정이 `false`면 첫 활성화가 기존 action을 바로 실행한다.
- 키바인딩, Automation·MCP·Remote의 restart/clear/remove 요청은 클릭 컨트롤이 아니므로 이 gate를 거치지 않는다. Clear terminal(빗자루)은 화면 지우기만 하는 반복 동작이라 한 번 클릭을 유지한다.

## Alternatives Considered

- **기존 `workspaceSelector.confirmDestructiveActions` 키를 재사용하고 범위만 확장** — 변경이 가장 작지만 selector 설정이 pane 컨트롤 바를 지배해 키 이름과 소유 범위가 어긋난다. 설정을 찾는 사용자도 Workspaces 화면에서 pane 동작을 기대하기 어렵다.
- **pane 컨트롤 바 전용 새 키** — 표면별 독립 제어가 가능하지만 같은 정책을 두 설정으로 나눠 사용자가 한쪽만 켜는 불일치를 만든다. 실제 요구는 "파괴적 동작은 두 번"이라는 하나의 정책이다.
- **native confirm dialog** — ADR-0211에서와 같은 이유(작업 흐름·focus 이탈, WebView별 표현 차이)로 기각한다.
- **빗자루(Clear terminal)도 포함** — selector의 workspace 터미널 지우기와 일관되지만, 단일 pane 화면 지우기는 단축키(`pane.clearTerminal`)로 자주 반복되는 가벼운 동작이고 세션을 없애지 않는다. 사용자 결정으로 제외한다.

## Consequences

- 기본 설정에서 pane 컨트롤 바의 빨간 세 버튼은 한 번 클릭으로 아무것도 바꾸지 않는다. 의도한 실행에는 클릭이 한 번 늘어난다.
- 포인터를 버튼 밖으로 옮기거나, hover 모드 컨트롤 바가 idle 자동 숨김으로 언마운트되면 처음부터 다시 활성화해야 한다.
- 기존 `settings.json`의 `workspaceSelector.confirmDestructiveActions` 값은 무시되고 root 기본 `true`가 적용된다. 껐던 사용자는 Interface 화면에서 다시 끈다.
- PaneControlBar·PaneGrid·Dock 배선 테스트와 e2e는 두 번 활성화를 전제로 갱신한다. living doc(overview·data-flow·api-contracts)의 설정 경로를 함께 바꾼다.
- 두 번째 활성화 유실이나 발견성 문제가 확인되면 ADR-0211과 같이 domain action은 유지한 채 인라인 Confirm/Cancel 표현을 재검토한다.
