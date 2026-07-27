# 0073. 네이티브 커서 숨김은 렌더러 게이트에서 한다

- Status: Accepted
- Date: 2026-07-27
- Source: issue #598 (#596/PR #597 조사 중 부수 발견), [architecture/data-flow.md §8.15](../architecture/data-flow.md) 의 미검증 메모, [ADR-0008](0008-shell-cursor-shadow-cursor.md), [ADR-0011](0011-dectcem-cursor-park-fifth-layer.md), [ADR-0029](0029-detached-terminal-input-composer.md)

## Context

laymux 는 overlay caret 이 캐럿을 소유하는 구간(composer 모드, IME 조합 중, `stabilizeInteractiveCursor` + Codex 류 TUI)에서 xterm 자신의 커서를 숨긴다. 그 구현이 두 가지 xterm **옵션**에 기대고 있었다.

1. `theme.cursor` / `theme.cursorAccent` 를 테마 배경색으로 칠한다 — "배경색으로 그리면 안 보인다".
2. `options.cursorStyle = "bar"` + `options.cursorWidth = 1` 로 모양을 최소화한다.

둘 다 **앱이 소유한 것에 기댄 전제**였고, 앱이 그것을 되돌리면 숨김이 아니라 강조가 된다.

- **색**: "커서가 놓인 셀의 배경 = 테마 배경" 일 때만 성립한다. TUI 가 SGR 48 로 자기 배경을 칠하면 깨진다. #598 의 픽셀 측정: codex 입력박스 행은 `rgb(41,41,41)` 인데 커서는 테마 배경 `#0C0C0C` 로 그려져 **어두운 구멍**으로 드러났다. 밝은 스킴이면 반대 방향으로 튄다.
- **모양**: `options.cursorStyle` 은 권위가 아니다. xterm 6.0.0 의 두 렌더러 모두 `coreService.decPrivateModes.cursorStyle ?? options.cursorStyle` 순서로 읽고, DECSCUSR(`CSI Ps SP q`)가 그 DEC 모드를 쓴다. 즉 DECSCUSR 를 보내는 앱이 모양을 통째로 가진다. 해결된 모양이 `block` 이면 렌더러는 셀 전체를 커서 색으로 칠하고 글리프를 `cursorAccent` 로 그린다 — 위 (1)과 겹치면 **테마 배경색으로 꽉 찬 1셀**이 되고, 그것이 #598 이 측정한 열 39 의 정체다. codex 는 매 프레임 DECSCUSR 를 보내므로 `terminal.refresh()` 로 덮어도 다음 프레임에 되돌아온다.

결함의 본질은 픽셀이 아니라 **소유권**이다. 앱이 언제든 되돌릴 수 있는 채널에 숨김을 걸어 놓고 경합하고 있었다. 어느 쪽이 이기는지가 앱·색상 스킴·프레임 타이밍에 따라 달라지므로, 옵션 값을 더 잘 고르는 것으로는 닫히지 않는다.

범위는 "네이티브 커서를 끄는 수단" 하나다. 언제 끄는지(overlay caret 소유 조건), overlay caret 자체, shadow cursor 판정은 이 결정의 비목표다.

## Decision

**네이티브 커서 숨김은 앱이 닿을 수 없는 렌더러 게이트(`coreService.isCursorHidden`)에서 하고, 색·모양 옵션은 사용자 설정 그대로 둔다.**

- **수단**: 두 렌더러가 커서를 그릴지 판정하는 유일한 게이트가 `isCursorInitialized && !isCursorHidden` 이다. laymux 는 그 필드를 accessor 로 감싸 **앱의 모든 쓰기를 기록하고, 자신이 숨기는 동안에는 hidden 을 보고**한다. SGR·DECSCUSR·테마는 이 게이트에 닿지 못하므로 경합이 원천적으로 없다. 포커스 없는 커서(`cursorInactiveStyle`)도 같은 게이트 아래라 따로 맞출 필요가 없다.
- **불변식**: 셀 배경이 무엇이든, 앱이 DECSCUSR 를 몇 번 보내든, 포커스가 있든 없든 숨김 구간에서 네이티브 커서는 그려지지 않는다.
- **앱의 DECTCEM 권위는 유지한다.** DECTCEM(`CSI ?25h/l`)이 쓰는 필드가 바로 이 게이트다. [ADR-0011](0011-dectcem-cursor-park-fifth-layer.md) 은 프레임 밖 DECTCEM show 를 "보이는 커서는 여기" 라는 앱의 최우선 신호로 채택했으므로, 숨김이 그 값을 덮으면 shadow cursor 의 근거가 사라진다. 따라서 accessor 는 앱 값을 **별도로 보존**하고, 해제·`dispose()` 시 앱이 마지막으로 쓴 값을 그대로 돌려준다. 우리가 보내지 않은 hide 를 앱이 보낸 것처럼 만들지 않는다(shadow cursor 는 자기 CSI 핸들러로 DECTCEM 을 추적하므로 이 필드를 읽지 않는다 — 파서를 거치지 않는 이 쓰기는 추적에 보이지 않아야 하고, 실제로 보이지 않는다).
- **테마·모양·`cursorWidth` 는 숨김 여부와 무관하게 사용자 설정이다.** 숨김 구간에서 유일하게 달라지는 것은 `cursorBlink = false` 다 — 안 보이는 커서를 깜빡이는 것은 repaint 낭비다.
- **소유자는 하나다.** 숨김 조건(`composer` 모드 · 조합 중 · `stabilizeInteractiveCursor` + overlay caret activity)은 `TerminalView` 의 `applyNativeCursorVisibility` 만 계산한다. 조합 상태는 ref 에만 있어 React 가 볼 수 없으므로, React 는 조건을 다시 계산하지 않고 이 소유자를 호출만 한다. 조건을 두 곳에서 계산하는 형태는 data-flow.md §8.15/§8.16/§8.17 이 세 번 연속 "캐럿이 사라졌다" 로 기록한 실패 모양이다.
- **private 필드 접근은 한 모듈이 소유하고, 실패하면 스스로 꺼진다.** `ui/src/lib/native-cursor-suppression.ts` 하나가 `_core.coreService.isCursorHidden` 을 다루고 의존 필드 목록을 상수로 노출한다. 형태가 달라지면 `supported: false` 를 돌려주고 **아무것도 하지 않는다** — 네이티브 커서가 사용자 설정대로 보이는 상태(overlay 와 겹친 이중 캐럿)로 떨어지는 쪽을 택하고, #598 을 만든 배경색 위장으로는 되돌아가지 않는다. 실제 `Terminal` 계약 테스트가 필드 존재와 DECSCUSR 우선순위를 단정하므로 xterm 상향은 읽을 수 있는 실패로 드러난다([ADR-0053](0053-native-windows-synchronized-output-cursor-transaction.md) 이후 `xterm-pending-composition.ts` 가 세운 것과 같은 정책).

## Alternatives Considered

- **옵션을 매 프레임 다시 쓴다** (`onRender` 에서 `cursorStyle`·`theme` 재적용). 경합을 이기려는 시도이며, 게이트가 아니라 우선순위 싸움이라 이길 수 없다 — `decPrivateModes.cursorStyle` 이 `options.cursorStyle` 보다 먼저 읽히므로 옵션을 몇 번 써도 DECSCUSR 를 보내는 앱이 이긴다. 프레임마다 옵션을 쓰면 xterm 의 옵션 변경 repaint 가 함께 돌아 TUI 출력 버스트와 경합한다는 별개 비용도 있다.
- **`cursorStyle = "none"`**. xterm 6.0.0 의 `cursorStyle` 은 `'block' | 'underline' | 'bar'` 뿐이다. `'none'` 은 `cursorInactiveStyle` 에만 있고 그것은 **비포커스** 커서만 덮는다 — active 커서를 끄는 수단이 아니다.
- **우리가 `CSI ?25l` 을 xterm 에 써서 강제한다.** 파서를 거치므로 laymux 의 DECTCEM CSI 핸들러가 우리 쓰기를 앱의 hide 로 오인하고, ADR-0011 의 park 분류(`isDectcemShowPark`)가 우리가 만든 신호를 근거로 삼는다. 게이트를 직접 만지는 것과 결과는 같으면서 shadow cursor 의 입력을 오염시킨다. 그리고 앱이 다음 프레임에 `?25h` 를 보내면 풀린다 — 여기서도 경합이다.
- **CSS 로 커서 레이어만 숨긴다.** DOM 렌더러에서는 이미 그렇게 하고 있고(`.terminal-native-cursor-hidden .xterm-cursor`) 유지한다. 그러나 WebGL addon 은 커서를 텍스트와 같은 캔버스에 그리므로 CSS 가 닿지 않는다 — 이 이슈가 발생한 기본 렌더러가 정확히 그쪽이다.
- **`terminal.blur()` 로 active 커서 자체를 없앤다.** 입력·IME·helper textarea 포커스 계약([ADR-0057](0057-terminal-helper-focus-ownership.md))을 전부 깬다.
- **xterm 번들 패치로 커서 렌더링에 옵션을 추가한다.** 정론이지만 patch 인프라와 버전 상향 비용이 확정적으로 붙는다. 같은 게이트를 accessor 로 감싸는 것으로 패치 없이 동일한 보장을 얻는다.

## Consequences

- 숨김이 앱의 출력 내용·색상 스킴·프레임 타이밍과 무관해진다. "codex 입력박스에서만 보인다" 같은 조건부 결함이 구조적으로 생기지 않는다.
- 사용자 커서 설정(모양·폭·색)이 숨김 구간에서도 보존되므로, 숨김이 풀리는 순간 원래 커서로 즉시 돌아온다. 이전에는 해제 경로가 설정을 다시 써 넣어야 했다.
- **비용: private 필드 의존이 하나 늘었다.** `_core.coreService.isCursorHidden` 은 공개 API 가 아니다. 대가로 (a) 접근을 한 모듈로 격리했고, (b) 실패 시 동작을 "아무것도 안 함" 으로 고정했고, (c) 실제 `Terminal` 계약 테스트로 xterm 상향 시 실패가 드러나게 했다. 상류에 공개 커서 비활성화 옵션이 생기면 이 모듈은 제거 대상이다.
- **비용: DECRQM 25 응답이 숨김 구간에서 "hidden" 을 보고한다.** 게이트가 필드 하나이므로 앱이 모드 25 를 조회하면 우리 상태를 본다. 앱이 그에 반응해 `?25h` 를 보내도 숨김은 유지되므로 무해하지만, 커서 가시성을 조회해 분기하는 앱이 있다면 관측 가능한 차이다. 실측한 사례는 없다.
- `isCursorHidden` 은 옵션이 아니라서 쓰기 뒤에 xterm 의 옵션 변경 repaint 가 따라오지 않는다. 숨김 전이에서는 `refresh()` 를 명시적으로 한 번 호출해야 하고, 전이가 아닐 때는 호출하지 않는다(활동 전이마다 repaint 를 유발하지 않는다는 기존 제약 유지).
- 재검토 조건: xterm 이 커서 비활성화를 공개 API 로 노출하거나, `isCursorHidden` 이 DECTCEM 전용이 아닌 다른 의미를 갖게 되거나, 앱의 모드 25 조회 결과에 의존하는 실기 결함이 관측되면 이 결정을 다시 본다.
