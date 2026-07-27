# 0071. Pane 리사이즈 판정은 경계 이동 함수 한 곳이 소유한다

- Status: Accepted
- Date: 2026-07-27
- Source: issue #590, [ADR-0005](0005-display-state-raw-separation-compute.md), architecture/data-flow.md §5, architecture/api-contracts.md §12

## Context

Grid 의 pane 들은 **겹치지도 비지도 않게 그리드를 완전히 덮는다**는 불변식을 가진다. 이 불변식을 지키는 판정이 두 벌 있었다.

- 경계선 드래그(`PaneBoundaryHandles`)는 `findPaneBoundaries` 로 찾은 경계의 양쪽 그룹을 함께 옮기고 `calcResizeDelta` 로 `PANE_MIN_RATIO` 클램프를 건다. 그래서 드래그로는 겹침이 생기지 않는다.
- Automation `panes.resize`(`POST /api/v1/panes/:index/resize`, MCP `resize_pane`)는 delta 를 절대값으로 바꿔 **대상 pane 하나만** 갱신했다. 이웃은 그대로 남아 겹치거나 틈이 생겼다.

issue #590 이 실기(dev 19281)에서 이를 재현했다. pane0(0,0,.5,.5)/pane1(0,.5,.5,.5)/pane2(.5,0,.5,1) 에서 pane0 에 `dw` 를 누적하면 pane0 이 `w=0.58` 이 되는데 pane2 는 `x=0.5` 로 남아 0.5–0.58 구간이 겹쳤다. `/api/v1/docs` 와 Rust 핸들러 주석은 이미 "against its neighbor" 라고 선언하고 있었으므로 문서와 동작도 어긋나 있었다.

같은 불변식에 소유자가 둘이라는 것이 근본 원인이다. 어느 한쪽을 고쳐도 다음에 세 번째 진입점(키보드 리사이즈, 레이아웃 프리셋 등)이 생기면 같은 결함이 다시 난다. 범위는 활성 워크스페이스 grid pane 의 리사이즈 판정이며, dock 크기·터미널 PTY `cols/rows`·레이아웃 저장 포맷은 비목표다.

## Decision

**pane 리사이즈는 언제나 "공유 경계를 옮기는 것"이고, 그 판정은 `ui/src/hooks/usePaneResize.ts` 한 곳이 소유한다.** 드래그와 Automation API 는 같은 순수 함수를 호출하며 자기 버전의 산술을 갖지 않는다(ADR-0005 의 "원시 상태 분리 → 단일 계산 함수" 를 레이아웃 기하에 적용).

- **경계 이동 단위 함수** — `boundaryResizeUpdates(boundary, rawDelta, panes)` 가 `calcResizeDelta` 클램프를 적용한 뒤 left/top 그룹에 `w+delta`(`h+delta`), right/bottom 그룹에 `x+delta, w-delta`(`y+delta, h-delta`) 를 담은 절대 rect 목록을 만든다. 클램프 후 델타가 무시할 수준이면 빈 목록이다. 양쪽이 같은 델타를 쓰므로 두 면은 항상 맞닿는다.
- **축 → 경계 해석** — `dw`/`dh` 는 대상 pane 의 **trailing 경계**(오른쪽/아래)를 먼저 쓰고, 그리드 끝에 붙어 trailing 경계가 없으면 **leading 경계**(왼쪽/위)를 부호 반전해 쓴다. 어느 쪽 pane 이 커지는지는 부호가 결정한다.
- **축은 독립** — `dw` 와 `dh` 가 함께 오면 순서대로 해석하되, 두 번째 축은 첫 축을 반영한 상태에서 경계를 다시 찾는다. 폭이 바뀌면 어떤 pane 이 가로 경계를 공유하는지도 바뀌기 때문이다.
- **실패는 명시적** — 해당 축에 경계가 하나도 없으면(그 축으로 그리드 전체를 차지하는 pane) 조용히 불변식을 깨는 대신 **오류를 반환**한다. Automation 계약상 이 경우 요청은 실패하며 레이아웃은 그대로다. `dw`/`dh` 가 모두 없는 요청도 실패다.
- **좌표 delta 는 계약에 없다** — 전송 계층(HTTP/MCP)이 `dw`/`dh` 만 싣는다. 임의의 `x`/`y` 이동은 이웃을 정의하지 않으므로 리사이즈 계약에 포함하지 않는다.

`workspace-store.resizePane` 은 계산하지 않는 dumb setter 로 남는다 — 인덱스 하나에 절대 rect 를 쓰는 것이 전부이며, 불변식은 호출자가 위 함수로 보장한다.

## Alternatives Considered

- **`workspace-store.resizePane` 안에서 이웃을 보정한다.** 스토어가 단일 진입점이라 매력적이지만, 드래그는 경계 하나의 양쪽을 **한 세트**로 옮기므로 인덱스별 setter 호출을 각각 보정하면 중간 상태마다 이웃을 잘못 밀어낸다. 스토어가 "이 호출이 어느 경계의 어느 쪽인지" 를 알 방법도 없다. 기각.
- **API 경로에 드래그 로직을 복사한다.** 가장 작은 diff 지만 소유자가 둘이라는 근본 원인을 그대로 둔다. issue 가 지적한 바로 그 구조다. 기각.
- **경계가 없을 때 조용히 no-op.** 실패를 감춰 호출자가 레이아웃이 바뀐 줄 알고 다음 델타를 누적한다. 자율 검증 루프에서 특히 나쁘다. 오류 반환을 택했다.
- **후처리 정규화(리사이즈 후 그리드를 다시 타일링).** 어떤 입력이든 불변식은 복구되지만 사용자가 요청하지 않은 pane 까지 움직이고, 클램프·최소 크기 정책과 이중으로 싸운다. 기각.

## Consequences

- `/api/v1/panes/{index}/resize` 와 MCP `resize_pane` 의 문서상 서술("against its neighbor")이 실제 동작과 일치하게 됐다.
- **동작이 바뀐 계약**: 이전에 항상 성공하던 요청이 이제 실패할 수 있다 — (a) 요청 축에 경계가 없는 pane, (b) `dw`/`dh` 없는 delta. 또한 성공 응답은 이제 이웃도 함께 움직인 결과이므로, 대상 pane 만 바뀔 것을 가정한 자동화 스크립트는 기대값을 고쳐야 한다. `PANE_MIN_RATIO` 클램프가 걸리면 요청보다 작은 폭만 반영되고도 성공한다(요청 델타가 그대로 반영된다고 가정하지 말 것).
- 리사이즈 한 번이 여러 pane 을 갱신하므로 스토어 write 가 pane 수만큼 발생한다. 드래그가 이미 그렇게 동작했으므로 새로운 비용은 아니다.
- 앞으로 생길 리사이즈 진입점(키보드 단축키, 레이아웃 프리셋 조정 등)은 반드시 `planPaneResize`/`boundaryResizeUpdates` 를 거쳐야 한다. 자기 산술을 쓰는 새 경로가 나타나면 이 결정을 위반한 것이다.
- 회귀 고정: `usePaneResize.test.ts` 가 순수 함수 수준에서 T-junction·그리드 끝 pane·양축 동시·클램프·경계 없음을 검증하고, `useAutomationBridge.test.ts` 가 issue #590 의 델타 시퀀스를 그대로 재생해 타일링을 단언한다. `PaneBoundaryHandles.test.tsx` 가 드래그 쪽이 같은 함수를 쓰는지 지킨다.
- 재검토 조건: pane 이 타일링이 아닌 배치(자유 배치·겹침 허용 플로팅 pane)를 지원하게 되면 "리사이즈 = 경계 이동" 전제가 깨지므로 이 ADR 을 다시 연다.
