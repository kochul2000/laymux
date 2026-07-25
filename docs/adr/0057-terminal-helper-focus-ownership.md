# 0057. 터미널 helper textarea 의 DOM focus 소유권은 앱 blur 시점 기록으로 복원한다

- Status: Proposed
- Date: 2026-07-25
- Source: issue #530, architecture/data-flow.md §8.9, [ADR-0029](0029-detached-terminal-input-composer.md)(입력 모드 경계), [ADR-0034](0034-single-send-terminal-composer.md)

## Context

pane focus 는 store(`focusedPaneIndex`)가 소유하고 DOM focus 는 그 상태를 따라가는 파생물이다. `TerminalView` 의 focus effect 는 `isFocused` 가 **변할 때만** `terminal.focus()`/`blur()` 를 호출한다.

앱이 Alt-Tab 등으로 비활성화되면 WebView 가 xterm helper textarea 의 실제 DOM focus 를 `body`/`null` 로 떨어뜨릴 수 있다. 이때 store 의 pane focus 는 변하지 않으므로 앱이 다시 활성화돼도 어떤 effect 도 재실행되지 않고, helper 는 DOM focus 를 돌려받지 못한다. 결과적으로 복귀 후 첫 키나 첫 한글 조합이 유실되거나(포커스가 body 에 있는 동안 xterm 이 키를 못 받음) 다른 pane 으로 가는 것처럼 보인다. 멀티-pane 환경에서는 "어느 helper 였는지"까지 필요하다 — DOM 순서상 첫 helper 를 집으면 다른 split 로 입력이 간다.

반대 방향의 위험도 크다. 앱 활성화마다 무조건 터미널에 focus 를 주면 재활성화 클릭이 향한 모달·검색창·설정 입력·다른 pane 에서 focus 를 강탈한다. 즉 "복원"과 "강탈 금지"를 같은 규칙 안에서 판정해야 하고, 판정 기준을 코드 여러 곳에 흩어 놓으면 이후 focus 관련 수정이 서로를 되돌린다.

범위는 Windows/Linux WebView 의 앱 blur→focus 왕복이다. 비목표: pane store focus 와 DOM focus 를 무조건 동일시하지 않는다. 앱 활성화 때 전역 `terminal.focus()` 를 호출하지 않는다. macOS `NSTextInputContext` 재생성은 지원 플랫폼 밖이다. IME 조합 문자열·PTY 데이터 병합 경로는 건드리지 않는다.

## Decision

**helper textarea 의 DOM focus 소유권은 "앱 blur 시점에 실제로 focus 를 갖고 있던 helper 의 identity" 라는 pane-local 기록 하나로 표현하고, 앱 focus 복귀 다음 프레임에 focus 가 여전히 주인 없는 상태(`null`/`body`/`documentElement`)일 때만 그 helper 를 복원한다.**

- **소유권 기록 조건.** window `blur` 시점에 `document.activeElement` 가 (a) helper textarea 이고 (b) 이 pane 의 surface(`wrapperRef`) 안에 있을 때만 기록한다. store 의 pane focus 만으로는 절대 기록하지 않는다. 따라서 composer 모드처럼 focus 가 helper 가 아닌 곳에 있으면 이 경로는 아무것도 하지 않는다.
- **복원 조건.** window `focus` 시점에 이미 다른 요소가 focus 를 쥐고 있으면 즉시 기록을 버리고 아무것도 하지 않는다. 주인 없는 상태면 **다음 프레임**에 재확인하고, 그 사이 다른 요소가 focus 를 얻었으면 복원을 취소한다. 복원은 `helper.focus()` 한 번이며 성공/실패와 무관하게 기록을 소비한다.
- **stale 정리 시점.** helper 미연결·surface 밖·helper 교체(xterm 재바인딩)·pane focus 해제(다른 pane/워크스페이스 전환, 앱 비활성 중 automation 변경 포함)·surface 밖 pointer press(재활성화 클릭의 handoff)·컨트롤러 dispose(unmount) 중 하나라도 발생하면 기록을 버린다. 버려진 기록은 되살리지 않는다.
- **소유권 경계.** 이 기록은 pane 별로 독립이며 서로의 helper 를 복원하지 않는다. store 의 pane focus 는 계속 "어느 pane 이 focus 인가"의 단일 진실원이고, 이 결정은 그 값을 읽지도 쓰지도 않는다 — DOM focus 복원은 store 를 갱신하지 않고, store 갱신은 기존 focus effect 가 계속 담당한다.
- **모듈 책임.** 판정 로직 전부는 DOM 이벤트 등록 없는 순수 컨트롤러(`ui/src/lib/terminal-focus-ownership.ts`)가 소유하고, `TerminalView` 는 window `blur`/`focus`/capture `pointerdown` 배선과 helper 재바인딩·pane focus 해제 통지만 한다. IME 조합 컨트롤러(`ime-composition-controller.ts`)는 helper 의 value/composition lifecycle 만 계속 소유하며 focus 소유권을 알지 않는다.
- **진단.** 기록·예약·복원·거절·정리는 기존 cursor-trace 채널로 `focus-ownership-*` 이벤트와 `activeElement` 문자열을 남긴다. Alt-Tab 왕복의 focus 이동은 이 trace 로만 추적하고 별도 로깅 경로를 만들지 않는다.

## Alternatives Considered

- **앱 focus 복귀 시 focused pane 의 `terminal.focus()` 를 무조건 호출.** 가장 짧지만 재활성화 클릭이 향한 모달·검색·설정 입력에서 focus 를 강탈한다. "복원"과 "강탈"을 구분할 정보(blur 시점 소유자)가 없어서 기각.
- **store 의 pane focus 를 DOM focus 의 진실원으로 삼아 매 렌더에서 동기화.** effect 재실행 조건이 사라져 구현은 단순해지지만, 사용자가 의도적으로 다른 UI 로 옮긴 focus 를 store 가 계속 되돌린다. 비목표에 정면으로 어긋나 기각.
- **`document.activeElement` 를 폴링해 body 로 떨어지면 되돌리기.** blur/focus 이벤트 없이도 복구되지만, 정상적으로 focus 가 비어 있는 상태(예: 클릭으로 focus 해제)까지 되돌리고 상시 타이머 비용이 든다. 기각.
- **helper 를 CSS/DOM 에서 항상 focus 유지(`preventScroll` + 재focus 루프).** 조합 중 IME 상태를 흔들고 xterm `CompositionHelper` 소유권을 침범한다. ADR-0053/0054 가 고정한 "helper 의 focus·value·composition lifecycle 은 xterm 이 소유" 경계를 깨므로 기각.
- **pane 이 아니라 앱 전역 단일 소유권 레지스트리.** 멀티-pane 에서 "어느 helper 였나"를 한 곳에서 관리할 수 있지만, pane unmount·워크스페이스 전환마다 전역 상태를 정리해야 하고 pane 간 경합이 전역 락으로 번진다. pane-local 기록이 수명 경계와 정확히 일치하므로 기각.

## Consequences

- 복귀 후 첫 키·첫 한글 조합 유실이 사라지고, 멀티-pane 에서 원래 pane 의 helper 로만 돌아간다. 다른 UI 가 focus 를 얻은 경우에는 아무 일도 일어나지 않는다.
- pane 마다 window 리스너 3개(`blur`/`focus`/capture `pointerdown`)가 추가된다. pointerdown 은 capture 단계 관찰만 하고 이벤트를 소비하지 않으며, 소유권 기록이 없을 때는 즉시 반환한다.
- "복원은 blur 시점 기록 + 주인 없는 focus" 라는 단일 판정이 생겼으므로, 이후 focus 관련 수정은 이 규칙을 확장·정정하는 형태로만 들어와야 한다. 새 UI 표면(모달·패널)이 focus 를 늦게(다음 프레임 이후) 가져가면 그 표면이 focus 를 먼저 요구하도록 고쳐야 하며, 이 컨트롤러에 예외 목록을 추가하지 않는다.
- composer 모드의 focus 복원은 이 결정 범위 밖이다(기록 조건이 helper 로 한정). composer 초안 focus 도 복귀 후 유실된다는 보고가 오면 같은 규칙을 composer textarea 로 확장하는 별도 결정이 필요하다.
- 검증은 jsdom unit test(순수 컨트롤러 15케이스) + `TerminalView` React 통합 test(복원·강탈 금지·pane focus 해제)로 고정한다. 실기(headful) Windows/Linux Alt-Tab 왕복은 CI 에서 재현할 수 없으므로 `focus-ownership-*` trace 로 수동 확인한다.
- 재검토 조건: WebView 가 앱 비활성화 시 DOM focus 를 유지하도록 바뀌면(그러면 기록은 항상 "이미 focus 됨"으로 소비된다) 이 경로는 no-op 가 되므로 제거를 검토한다. macOS 를 지원 대상에 넣으면 `NSTextInputContext` 재생성 요구가 추가되어 이 결정의 확장이 필요하다.
