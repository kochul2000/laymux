# 0079. DEC 2026 커서는 renderer lifecycle 우회까지 raw gate로 막는다

- Status: Accepted
- Date: 2026-07-28
- Source: issue #610 · [ADR-0073](0073-native-cursor-renderer-level-suppression.md) · [architecture/data-flow.md §8.21–8.22](../architecture/data-flow.md)
- Amends: [ADR-0073](0073-native-cursor-renderer-level-suppression.md)의 synchronized-output 후속 결정을 확정한다.
- Amends: [ADR-0074](0074-xterm-cell-grid-screen-test-tier.md)의 screen tier를 실제 xterm renderer 계약까지 확장한다.

## Context

ADR-0073은 네이티브 커서 숨김을 `coreService.isCursorHidden` raw renderer gate로
옮겼지만 synchronized-output(DEC 2026)은 별도 후속으로 남겼다. 기존 구현은
`.terminal-sync-output-active .xterm-cursor { opacity: 0 }`만 사용했다. 이 CSS는 DOM
renderer에는 닿지만 WebGL canvas에는 닿지 않아 renderer별 동작이 갈린다.

처음에는 xterm 6.0.0의 `RenderService.refreshRows`와 `_renderRows`가 프레임 중 행 요청을
모두 보류하므로 별도 커서 gate도 필요 없다고 판단했다. 실제 번들 검토와 DOM 재현은 그
판단이 불완전함을 보였다.

- 일반 write, 공개 `terminal.refresh()`, WebGL cursor redraw는 `RenderService`의 DEC 2026
  gate를 지나며 프레임 종료까지 보류된다.
- DOM renderer의 `handleFocus`, `handleBlur`, `handleSelectionChanged`는
  `renderer.renderRows()`를 직접 호출한다. 이 경로는 synchronized-output mode와
  `onRender`를 우회해 프레임 내부 buffer 내용과 새 cursor 위치를 그릴 수 있다.
- DOM cursor blink는 CSS animation이므로 화면과 함께 완전히 정지한다고 볼 수도 없다.
- pane focus 복구는 실제 helper에 `blur()`와 `focus()`를 호출하므로 이 우회는 이론적인
  경로가 아니다.

결정 범위는 **프레임 내부의 미확정 cursor가 보이지 않게 하는 것**이다. DOM renderer가
프레임 내용 전체를 중간에 다시 그리는 상류 atomicity 문제, selection overlay와 focus CSS
상태까지 모든 픽셀을 동결하는 것은 비목표다. 정상 프레임마다 옵션 변경이나 추가 전체
repaint를 만들지 않아야 하며, 앱의 DECTCEM 상태와 기존 composer·IME·overlay 숨김 이유를
보존해야 한다.

## Decision

**DEC 2026 parser frame 동안 기존 `coreService.isCursorHidden` raw gate에 독립적인 sync
reason을 합류시키고, base reason과 OR하여 renderer lifecycle 우회가 미확정 cursor를 그리지
못하게 한다.**

- `baseHideNativeCursor`는 기존 composer·composition·interactive overlay 조건만 소유한다.
  `syncOutputCursorGateActive`는 parser frame만 소유하며, 실제 suppression은 두 값의 OR이다.
  어느 한 reason의 전이가 다른 reason을 지울 수 없다.
- `CSI ? 2026 h` custom handler는 xterm의 mode handler보다 먼저 sync reason을 켠다. raw
  gate만 쓰며 `cursorBlink`, theme, shape 같은 옵션과 `terminal.refresh()`는 건드리지 않는다.
- 정상 `CSI ? 2026 l` custom handler는 xterm이 mode를 내리고 전체 viewport를 flush하기
  전에 sync reason을 끈다. 따라서 xterm의 필수 flush가 최종 cursor를 그리고 laymux의 추가
  repaint는 없다.
- xterm의 1초 safety timeout은 parser reset 없이 mode를 내리고 전체 render를 요청한다. rAF
  monitor가 `syncOutputActive=true`인데 mode가 `false`인 전이를 관찰하면 sync reason을 끈 뒤
  `refresh(0, rows - 1)`를 정확히 한 번 요청한다. xterm의 debounced render와 monitor의 순서는
  고정하지 않으며, 같은 frame이면 두 요청이 coalesce될 수 있다.
- `.terminal-sync-output-active .xterm-cursor` CSS는 제거한다. sync reason의 raw gate가 두
  renderer를 함께 덮으며, DOM에만 즉시 적용되는 CSS 비대칭을 만들지 않는다. 실제 DOM 요소인
  helper textarea의 `caret-color` 규칙과 frame boundary class는 유지한다.
- 실제 xterm renderer 동작은 `*.screen.test.ts`에서 `Terminal.open()`으로 검증한다. 이 예외는
  ADR-0074의 screen tier 범위를 확장하되 React component wiring은 계속 기본 vitest가 소유한다.

## Alternatives Considered

- **CSS만 제거하고 gate를 두지 않는다.** 일반 `RenderService` 경로만 보면 충분하지만 DOM
  focus·blur·selection 직접 paint가 새 cursor 위치를 노출한다. #620의 focus 복구와 결합하면
  실제로 실행되므로 기각했다.
- **기존 sync CSS를 유지한다.** DOM fallback만 숨기고 WebGL의 마지막 paint는 남겨 같은
  바이트가 renderer에 따라 다르게 보인다. ADR-0073의 renderer 독립 계약에 어긋나 기각했다.
- **sync 상태를 기존 base 조건에 넣고 매 경계마다 옵션 변경과 전체 refresh를 한다.** raw
  gate에는 옵션 변경이 필요 없고 정상 reset에는 xterm의 전체 flush가 이미 있다. 폭주 중
  불필요한 repaint를 추가하므로 기각했다.
- **xterm bundle의 `DomRenderer.renderRows` 입구에서 DEC 2026 mode를 검사한다.** 실제 재현에서
  focus·blur 동안 내용과 cursor를 모두 pre-frame 상태로 유지했다. 그러나 이는 새 vendor patch
  계약을 만들며 selection overlay·focus class·`clear()`까지 모든 픽셀 atomicity를 보장하지도
  않는다. 현재 cursor 안정화 범위를 넘어 기각하고, 중간 content paint가 사용자 결함으로
  관측되면 별도 결정으로 재검토한다.
- **DOM overlay로 WebGL cursor 셀을 덮는다.** 셀별 배경색을 알아야 하므로 #598의 배경색
  위장을 되살린다. 기각했다.

## Consequences

- DOM focus·blur가 프레임 내용을 직접 갱신할 수는 있지만 그 paint에는 cursor가 없다. 정상
  reset 뒤 최종 위치에 cursor 하나가 다시 그려진다. 이 ADR은 전체 프레임 atomicity를 주장하지
  않는다.
- 직접 lifecycle paint가 없으면 프레임 직전 cursor가 그대로 남을 수 있다. DOM의 CSS blink도
  계속될 수 있다. 잘못된 새 위치를 노출하지 않는 것이 보장 범위다.
- 정상 프레임에는 옵션 churn과 추가 repaint가 없다. 추가 전체 refresh는 xterm safety timeout
  복구에만 한 번 발생한다.
- base suppression이 프레임 중 켜지거나 꺼져도 sync reason을 덮지 않으며, 프레임 종료 후에는
  base와 앱 DECTCEM 상태가 그대로 권위를 되찾는다.
- `coreService.isCursorHidden`은 private xterm 계약이다. 기존 fail-open·shape contract test와
  실제 DOM lifecycle screen test가 상류 변경을 감지한다.
- screen tier에는 두 표면이 생긴다. cell-grid tests는 renderer 없이 실제 parser/buffer를 읽고,
  renderer-contract tests는 필요한 브라우저 shim을 파일 안에서 설치한 뒤 `open()`할 수 있다.
- 재검토 조건은 xterm이 DOM lifecycle path를 `RenderService` gate 아래로 옮기는 경우, raw cursor
  field가 바뀌는 경우, 또는 프레임 중 content paint 자체가 사용자에게 보이는 결함으로 확인되는
  경우다.
