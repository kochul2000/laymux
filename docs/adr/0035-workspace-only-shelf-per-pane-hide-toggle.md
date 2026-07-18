# 0035. 숨김 보관함은 workspace 전용 상단 배치, Pane 숨김은 pane 자체 토글 (0033 정정)

- Status: Accepted
- Date: 2026-07-18
- Source: 사용자 요구 (보관함 위치·Pane 항목 혼재 불만) · ADR-0033 · ADR-0005

## Context

ADR-0033 은 전역 hideMode 를 제거하면서 숨김 복원 경로를 selector 하단의 bottom shelf 하나로 통합했고, 그 보관함에 hidden workspace 와 hidden Pane 을 함께 나열했다. 실제 사용에서 두 가지 문제가 드러났다.

1. **위치 불일치** — 보관함을 여는 count chip 은 workspace 목록 헤더(상단)에 있는데 보관함 자체는 selector 최하단에 열린다. 버튼과 결과 UI 가 화면 반대편에 나타나 조작 흐름이 끊긴다.
2. **계층 혼재** — workspace 복원과 Pane 복원은 성격이 다른 작업인데 한 보관함에 섞여 있다. Pane 은 grid 에서 항상 접근 가능하므로(숨김은 selector 요약 행 표시 여부일 뿐) 별도 복원 목록이 필요 없고, 오히려 보관함을 길고 복잡하게 만든다.

범위: 이 결정은 표시 모델과 UI 컨트롤 표면만 바꾼다. `hiddenWorkspaceIds`/`hiddenPaneIds` raw state 분리, localStorage key, `deriveHiddenItems` 단일 계산 모듈, Automation REST/MCP 계약(`set_hidden_items_open`, workspace/Pane hidden toggle), active workspace fallback 불변식(ADR-0033)은 그대로 유지한다.

## Decision

- **보관함은 hidden workspace 전용이다.** hidden Pane 은 보관함에 나열하지 않으며, count chip 도 유효 hidden workspace 수만 센다. chip 은 hidden workspace 가 있을 때만 표시된다.
- **보관함은 그것을 여는 chip 바로 아래(workspace 목록 위)에 열린다.** 트리거와 결과 UI 를 같은 위치에 둔다.
- **Pane 숨김의 컨트롤 표면은 pane 자신이다.** workspace grid 의 각 pane 컨트롤바에 목록 숨김 eye 토글을 두고, 숨김/복원 모두 이 토글로 수행한다. selector 의 pane 요약 행에는 숨김 버튼을 두지 않는다(행 자체는 계속 필터된다). dock pane 은 selector 에 나오지 않으므로 토글을 노출하지 않는다.
- **"모두 표시"는 hidden workspace set 만 비운다.** 개별 숨김 Pane flag 는 pane 토글 소관이므로 건드리지 않는다. ADR-0033 의 "'모두 표시'만 두 hidden set 을 함께 비운다" 조항을 이 조항으로 대체한다.
- **보관함 자동 닫힘은 hidden workspace 기준이다.** 유효 hidden workspace 가 0 이 되면 hidden Pane 존재 여부와 무관하게 닫힌다.

## Alternatives Considered

- **보관함을 chip 앵커 popover 로 띄우기** — 위치 문제는 해결하지만 스크린샷 검증(html2canvas)과 포커스 관리가 복잡해지고, 기존 shelf 스타일·접근성 구조를 재사용할 수 없다. 인라인 배치로 충분하다.
- **hidden Pane 행을 selector 목록에 dimmed 로 남겨 행에서 토글** — 목록 정리라는 숨김의 목적을 훼손한다(숨겨도 행이 남음). 기각.
- **보관함에 Pane 섹션 유지 + 위치만 이동** — 사용자가 명시적으로 Pane 항목 노출 자체를 원치 않았고, Pane 복원 경로는 grid 토글로 대체 가능하다. 기각.
- **restoreAll 이 Pane flag 도 비우기(0033 유지)** — 보관함에 보이지 않는 상태를 보관함 버튼이 지우면 사용자가 예측할 수 없는 부작용이 된다. 표시 범위와 조작 범위를 일치시키는 쪽을 택했다.

## Consequences

- 숨김 UX 가 계층별로 일관된다: workspace 는 목록 행에서 숨기고 상단 보관함에서 복원, Pane 은 pane 컨트롤바 토글 하나로 숨김/복원.
- 개별 숨김 Pane 은 보관함·chip 에 더 이상 나타나지 않으므로, 사용자가 pane 토글의 존재를 모르면 복원 경로를 찾기 어려울 수 있다. 토글은 컨트롤바 기본 노출(hover/pinned)로 완화한다.
- "모두 표시" 의미가 좁아진다(workspace 만). 기존에 Pane 까지 복원되길 기대한 사용자는 pane 토글을 개별 조작해야 한다.
- 숨김 상태에서 pane 이 evict(터미널 자동 종료, issue #269)된 경우에도 복원은 pane 토글로만 가능하다 — 토글이 eviction 해제를 함께 수행해야 한다(기존 `setPaneHidden` set semantics 유지).
- Automation/Remote 계약과 raw state 는 불변이므로 외부 클라이언트 마이그레이션은 없다. ADR-0033 의 나머지 결정(즉시 숨김, set semantics, stale ID 파생 계산, active fallback)은 계속 유효하다.
- 재검토 조건: pane 수가 많은 워크스페이스에서 개별 Pane 복원 경로(grid hover 필요)가 실제로 불편하다는 피드백이 쌓이면 Pane 복원 보조 UI 를 다시 검토한다.
