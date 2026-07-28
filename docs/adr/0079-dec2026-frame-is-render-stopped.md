# 0079. DEC 2026 프레임은 렌더 정지 구간이므로 커서를 숨기지 않는다

- Status: Accepted
- Date: 2026-07-28
- Source: issue #610 ([ADR-0073](0073-native-cursor-renderer-level-suppression.md) Consequences 에서 분리한 후속), [ADR-0074](0074-xterm-cell-grid-screen-test-tier.md), [architecture/data-flow.md §8.21](../architecture/data-flow.md), 선행 [ADR-0011](0011-dectcem-cursor-park-fifth-layer.md)
- ADR-0073 의 Consequences 마지막 항목("synchronized-output 구간은 남은 구멍이고 비용을 측정해 게이트에 합류시킨다")을 **정정**한다. ADR-0073 의 Decision 자체는 유지된다.

## Context

ADR-0073 은 네이티브 커서 숨김을 `coreService.isCursorHidden` 렌더러 게이트로 옮기면서, synchronized-output(DEC 2026) 구간만 예외로 남겼다. 그 구간의 숨김은 `.terminal-sync-output-active .xterm-cursor { opacity: 0 }` CSS 하나였고, ADR-0073 이 CSS 를 숨김 수단으로 기각한 이유(WebGL addon 은 커서를 텍스트와 같은 캔버스에 그리므로 CSS 가 닿지 않고, 그게 기본 렌더러다)가 그대로 적용되는 자리였다. 그래서 "DEC 2026 프레임 동안 기본 렌더러에서는 네이티브 커서가 계속 그려진다" 를 남은 구멍으로 기록하고, 게이트에 합류시키려면 프레임 경계마다 `refresh(0, rows-1)` 가 붙으니 #606 이 측정한 폭주 중 repaint 비용을 재고 나서 결정하자고 issue #610 으로 분리했다.

그 전제가 틀렸다. 실제 번들(`@xterm/xterm` 6.0.0, `@xterm/addon-webgl` 0.19.0)에서 측정한 사실은 다음과 같다.

- `RenderService.refreshRows` 와 `RenderService._renderRows` **둘 다** `decPrivateModes.synchronizedOutput` 이 켜져 있으면 즉시 반환하고 행 범위만 `SynchronizedOutputHandler` 에 누적한다. 즉 프레임이 열려 있는 동안 `renderer.renderRows` 가 **한 번도** 호출되지 않는다 — 앱의 write 로도, 우리의 명시적 `terminal.refresh()` 로도, `CursorBlinkStateManager` 의 커서 행 redraw 로도 그렇다.
- 따라서 프레임 중에 커서가 "계속 그려지는" 것이 아니다. 화면에 남아 있는 것은 **프레임 직전 마지막 페인트**이고, 그것이 얼어 있는 것이 synchronized output 의 정의다. 프레임은 `?2026l` 의 `_onRequestRefreshRows` 로 전체 뷰포트를 한 번 flush 하며 끝난다(1초 safety timeout 도 같은 flush 를 한다).
- 게이트를 프레임 안에서 적용하는 것은 **비싸지 않고 무효하다.** laymux 의 `?2026h` CSI 핸들러는 `InputHandler` 의 것보다 먼저 실행되므로(파서는 나중에 등록된 핸들러부터 호출한다) 모드가 아직 `false` 인 가장 이른 시점에 게이트를 쓰고 `refresh()` 를 걸 수 있다. 그래도 페인트는 일어나지 않는다 — 렌더는 animation frame 으로 디바운스되고, 그 콜백이 도는 시점에는 모드가 켜져 있어 `_renderRows` 가 다시 삼킨다. 프레임이 닫힐 때 게이트를 되돌리므로, 게이트가 켜져 있던 구간에는 어떤 페인트도 없다.
- 반대로 CSS 는 페인트 없이 스타일만 바꾸므로 **얼어 있는 DOM 렌더러의 커서만** 지운다. 즉 지금 코드는 "기본 렌더러에서 못 하는 것을 폴백 렌더러에서만 한다" — 같은 바이트에 대해 살아 있는 렌더러에 따라 캐럿이 다르게 동작한다.

결정 범위는 "synchronized-output 구간에 네이티브 커서 숨김을 둘 것인가" 하나다. 프레임 경계를 다른 목적으로 쓰는 계약(정착 커서 withhold, `parkPending`, IME 앵커, overlay caret freeze)은 비목표이며 그대로 유지된다.

## Decision

**DEC 2026 프레임 구간에는 네이티브 커서 숨김을 두지 않는다. CSS 규칙을 지우고 게이트에도 합류시키지 않는다.** 프레임은 렌더 정지 구간이므로 숨길 대상이 그려지지 않고, 숨길 수단도 존재하지 않는다.

- **불변식**: 프레임이 열려 있는 동안 laymux 는 커서 가시성을 바꾸지 않는다. 화면은 프레임 직전 페인트 그대로 얼어 있고, 캐럿도 화면의 나머지와 같이 얼어 있다 — 이것이 원자적 갱신의 의미이며, 캐럿만 따로 사라지는 것은 렌더러별 플리커다.
- **CSS 커서 규칙의 허용 조건을 하나로 좁힌다.** `.xterm-cursor` 를 숨기는 CSS 는 **렌더러 게이트를 미러링할 때만** 둔다(`.terminal-native-cursor-hidden`, `onContextLoss` 폴백 방어선). 게이트가 없는 조건에 CSS 만 두는 형태는 금지한다 — 그것이 "기본 렌더러에서는 무력하고 폴백에서만 동작하는" 비대칭을 만든다.
- **`.terminal-sync-output-active` 클래스는 유지한다.** 헬퍼 textarea 의 `caret-color` 는 캔버스에 그려진 셀이 아니라 실제 DOM 요소의 OS 캐럿이므로 렌더러와 무관하고, 프레임 경계는 여전히 여러 소비자가 읽는 상태다. 클래스가 소유하는 것은 프레임 경계이지 커서 숨김이 아니다.
- **소유권은 그대로다.** 네이티브 커서 숨김 조건은 `applyNativeCursorVisibility` 하나가 계산한다(ADR-0073). 이 결정은 그 조건에 sync 상태를 **더하지 않기로** 확정함으로써 소유자를 하나로 유지한다.
- **검증 계층**: 렌더러 계약 주장은 mock 으로 잡을 수 없으므로 실제 `Terminal` 을 `open()` 한 screen 스위트(ADR-0074)에 고정한다 — 프레임 중 `onRender` 0회, 프레임 중 게이트를 켜도 커서 요소가 남아 있음, 프레임 밖에서는 같은 게이트로 즉시 사라짐. CSS 쪽 불변식("sync 조건에는 커서 규칙이 없다")도 테스트로 고정한다.

## Alternatives Considered

- **(a) 게이트에 합류시킨다** (`syncOutputActiveRef` 를 `hideNativeCursor` 에 OR, dedupe 키에 sync 상태 추가). issue #610 이 제시한 1안. **무효**임이 측정됐다 — 게이트가 켜져 있는 구간에 페인트가 없으므로 픽셀이 달라지지 않는다. 게다가 프레임 경계마다 옵션 쓰기·`refresh()` 를 유발해 폭주 중 비용만 늘리고, safety timeout 으로 프레임이 닫히는 경로에서는 모니터가 클래스를 내리기까지 한 프레임 커서가 사라지는 플리커를 새로 만든다. 얻는 것이 0 인 비용이라 측정할 값도 없다.
- **(b) 프레임 중 repaint 없이 커서 셀만 무효화한다.** issue #610 의 2안. WebGL 에서 픽셀을 바꾸는 유일한 경로가 그리기이고, 그리기가 바로 DEC 2026 이 막는 것이다. `_requestRedrawCursor` 가 쓰는 커서 행 단위 무효화(`onRequestRedraw` → `refreshRows(cursorY, cursorY)`)도 같은 게이트를 지나므로 프레임 중에는 버퍼링된다. 상류에 "그리지 않고 커서만 지우는" API 는 없다.
- **프레임 열림 시점에 동기 렌더를 강제한다** (`_renderService._renderer.value.renderRows()` 직접 호출). 모드가 켜지기 전이라 버퍼는 정착 상태이므로 tearing 없이 가능하긴 하다. 기각: private 필드 의존이 하나 더 늘고(ADR-0073 이 하나로 격리한 정책을 깬다), WebGL 의 `renderRows` 는 행 범위와 무관하게 매 호출 전체 모델을 GPU 로 다시 그리므로 프레임당 페인트 하나가 추가된다(codex 스피너 빈도로 초당 10회 이상). 대가는 "프레임 동안 캐럿이 얼어 있지 않다" 뿐이고, 그건 애초에 결함이 아니라 정의다.
- **DOM 오버레이로 커서 셀을 덮는다.** 캔버스 픽셀을 가릴 수 있는 유일한 비-그리기 수단. 기각: 덮을 색이 셀 배경이어야 하는데 그 전제가 정확히 #598 을 만든 배경색 위장이다(TUI 가 SGR 48 로 자기 배경을 칠하면 구멍으로 드러난다).
- **CSS 규칙을 그대로 둔다** ("폴백에서라도 동작하니 손해는 없다"). 기각: 방어할 대상이 없는 방어선이고, 렌더러에 따라 캐럿 동작이 갈리는 비대칭을 유지한다. ADR-0073 이 세운 "숨김은 앱·색상 스킴·렌더러와 무관해야 한다" 와 어긋난다.

## Consequences

- issue #610 이 요구한 "비용 측정 선행" 이 불필요해졌다. 재야 할 비용이 없다 — 두 후보 모두 픽셀을 바꾸지 못한다는 것이 측정 결과다. #606 의 repaint 비용 측정 절차에 이 항목을 얹지 않는다.
- **DOM 렌더러(=`onContextLoss` 폴백) 동작이 바뀐다.** 프레임 동안 캐럿이 사라지던 것이 이제 화면의 나머지와 함께 얼어 있다. 기본 렌더러와 같아지는 방향이고, 프레임이 길어질 때(대형 프레임, 1초 safety timeout) 캐럿만 깜빡하는 현상이 없어진다.
- **기본(WebGL) 렌더러 동작은 바뀌지 않는다.** 지운 CSS 는 거기 닿지 않았고, 새로 무엇을 숨기지도 않는다. 즉 이 PR 은 기본 렌더러에서 무해함이 구조적으로 보장된다 — 실기 확인은 폴백 경로와 헬퍼 textarea 캐럿에 대해서만 의미가 있다.
- **`data-flow.md §8.21` 의 "남은 구멍" 서술이 폐기된다.** living doc 을 같은 PR 에서 갱신했다. ADR-0073 본문은 append-only 규칙에 따라 고치지 않고, 이 ADR 이 그 Consequences 항목을 정정하는 기록으로 남는다.
- **비용: 이 결정은 xterm 의 렌더 억제 구현에 의존한다.** `RenderService` 가 프레임 중 렌더를 억제하지 않게 바뀌면(예: 상류가 부분 렌더를 허용하게 되면) 전제가 무너진다. screen 스위트의 계약 테스트가 그 변화에서 실패하도록 되어 있고, 그때는 이 결정을 다시 본다.
- 재검토 조건: 위 상류 변경, 또는 프레임 중 캐럿이 눈에 띄는 결함으로 실측되는 경우(그때는 "얼어 있음" 이 아니라 "잘못된 위치에 그려짐" 이어야 하며, 그것은 프레임 밖 게이트·overlay caret 의 문제다).
