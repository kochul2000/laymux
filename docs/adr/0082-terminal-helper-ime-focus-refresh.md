# 0082. 앱 복귀 시 DOM-active xterm helper 는 blur/focus 로 IME 문맥을 재활성화한다

- Status: Superseded by [0108](0108-windows-ime-editable-focus-relay.md)
- Date: 2026-07-28
- Source: 사용자 실기 보고(Windows IME 조합창이 화면 좌상단에 나타나고 같은 pane 클릭은 복구하지 못하지만 Alt+방향키 pane 왕복은 복구), architecture/data-flow.md §8.9, [ADR-0057](0057-terminal-helper-focus-ownership.md)
- Extends: [ADR-0057](0057-terminal-helper-focus-ownership.md)의 `activeElement === helper` 복원 분기
- Relation: [ADR-0053](0053-native-windows-synchronized-output-cursor-transaction.md)이 출력 안정화에서 금지한 helper focus 조작은 유지하고, 별도 입력 문제로 보류한 blur/focus를 재현된 Windows WebView2 복귀 경로에만 결정한다. [ADR-0079](0079-dec2026-cursor-gate-lifecycle-bypass.md)의 raw cursor gate를 선행조건으로 삼으며, [ADR-0081](0081-pane-focus-transition-single-owner.md)의 store focus 전환 소유권은 변경하지 않는다.

## Context

ADR-0057은 앱 blur 시 실제 xterm helper textarea identity를 pane-local로 기억하고, 앱 focus 다음 프레임에도 DOM focus가 비어 있을 때만 그 helper를 복원한다. 다른 UI의 focus를 강탈하지 않으면서 store pane focus와 실제 DOM focus가 갈리는 문제를 해결하는 결정은 그대로 유효하다.

하지만 Windows WebView2에서는 앱이 비활성화되는 동안 `document.activeElement`가 helper를 계속 가리켜도 네이티브 IME/TSF 입력 문맥은 그 helper에서 떨어질 수 있다. 이 상태에서는 Windows IME 조합 UI가 WebView 안의 helper rect 대신 화면 좌상단에 나타나고, 한글 입력이 음절별로 중복되는 등 터미널 입력 경로가 비정상화된다. 이미 focused인 같은 pane을 클릭하면 xterm의 `focus()`가 같은 textarea의 `focus()`를 다시 호출하지만 DOM에서는 no-op이므로 복구되지 않는다. 반면 Alt+방향키로 다른 pane을 거쳐 돌아오면 기존 pane focus effect가 실제 `blur()` → `focus()` 전환을 만들고 즉시 복구된다.

따라서 DOM focus identity와 네이티브 IME 입력 문맥을 같은 상태로 간주할 수 없다. 기존 소유권 기록과 focus 강탈 금지 불변식을 유지하면서, helper가 DOM-active로 남은 분기만 실제 focus lifecycle을 다시 발생시킬 방법이 필요하다.

범위는 Windows WebView2의 앱 blur/focus 왕복에서 ADR-0057이 소유권을 캡처한 Direct 입력 helper다. Linux에서 같은 cycle을 활성화하는 것, pane 클릭마다 focus를 재시작하는 것, composer textarea까지 소유권 범위를 넓히는 것, Win32 TSF API를 직접 제어하는 것, pane store focus를 다시 쓰는 것은 비목표다.

## Decision

**Windows WebView2의 앱 focus 복원 프레임에 기억한 helper가 여전히 `document.activeElement`라면 그 helper를 정확히 한 번 `blur()`한 뒤 focus 소유자가 여전히 없음을 재확인하고 `focus({ preventScroll: true })`하여 네이티브 IME 문맥을 재활성화한다.**

- 이 전환은 ADR-0057의 blur 시점 소유권 기록이 있는 helper에만 적용한다. 앱 활성화마다 focused pane을 전역으로 다시 focus하지 않는다.
- 복원 프레임의 active element가 `body`/`null`/`documentElement`이면 기존처럼 blur 없이 helper를 바로 focus한다.
- 강제 blur 직후 helper가 분리·교체됐거나 surface 밖으로 나갔으면 복원을 중단한다.
- 강제 blur의 동기 listener가 모달·검색·설정 입력 등 다른 요소에 focus를 주면 그 요소가 새 소유자다. helper focus를 호출하지 않고 소유권 기록을 소비한다.
- 복원 예약 뒤 다음 프레임 전에 같은 helper에서 `keydown`·`beforeinput`·`input`·`compositionstart`가 발생하면 입력이 이미 살아 있다는 증거이므로 예약 세대를 무효화한다. 새 키나 조합을 뒤늦은 refresh로 blur하지 않는다.
- xterm의 공개 DOM focus lifecycle을 사용한다. helper value, composition event, Win32 IME/TSF 객체를 직접 조작하지 않는다. blur에서 진행 중 조합을 확정하는 기존 §8.16 경로와 xterm의 focus-report 전송을 그대로 통과시킨다.
- refresh 판정은 `Windows host && activeElement === rememberedHelper`에 건다. Linux에서는 주인 없는 helper의 기존 복원만 유지하고 DOM-active helper를 cycle하지 않는다. 동등한 headful 재현과 무중복 조합 근거가 생기기 전에는 플랫폼 범위를 넓히지 않는다.
- `focus-ownership-reclaimed` trace에 실제 active-helper refresh 여부를 남기고, blur 중 다른 focus 소유자가 생긴 거절도 별도 reason으로 남긴다.

## Alternatives Considered

- **기존처럼 active helper에 `focus()`만 재호출.** DOM no-op이라 네이티브 IME 문맥이 재연결되지 않고, 같은 pane 클릭이 복구하지 못한다는 관측을 설명하거나 해소하지 못해 기각했다.
- **앱 focus마다 현재 pane에 `terminal.blur()` → `terminal.focus()`를 무조건 호출.** composer·모달·검색창처럼 terminal이 실제 소유자가 아니었던 경우에도 focus를 강탈하고 모든 pane이 전역 활성화 이벤트에 반응한다. ADR-0057의 blur 시점 identity 경계를 깨므로 기각했다.
- **pane 클릭에서 항상 blur/focus를 강제.** 정상 입력 중 클릭까지 composition lifecycle과 focus report를 흔들고, 키보드 Alt-Tab 복귀처럼 클릭이 없는 경로를 고치지 못한다. 증상의 원인 경계가 pane interaction이 아니라 앱 focus 왕복이므로 기각했다.
- **Rust/Tauri에서 Win32 TSF 입력 문맥을 직접 재연결.** WebView2 내부 textarea와 TSF 객체의 사유 구현에 결합하고 Linux 경로와 분리된다. 공개 DOM focus lifecycle이 이미 Alt+방향키 복구에서 검증된 신호이므로 더 낮은 계층 침범을 기각했다.

## Consequences

- helper가 DOM-active인데 네이티브 입력 문맥만 고아가 된 상태도 앱 복귀 프레임에서 실제 blur/focus event를 받아 회복한다. 같은 pane 클릭에 의존하지 않는다.
- Linux의 DOM-active helper에는 추가 blur/focus를 만들지 않아 검증되지 않은 조합 확정과 focus-report를 피한다.
- active-helper 분기에서는 xterm `onBlur`/`onFocus`와 terminal focus-report가 각각 한 번 발생할 수 있다. 이는 실제 OS focus 왕복을 DOM이 누락한 경우를 보정하는 비용이다.
- 앱 비활성화 중 진행되던 조합은 강제 blur에서 기존 §8.16 계약으로 확정된다. 별도 문자열 주입 경로를 만들지 않으므로 commit 중복·유실 판정은 계속 IME composition controller 한 곳이 소유한다.
- 복귀 프레임보다 먼저 새 입력이나 조합이 시작되면 refresh를 취소하므로 그 입력은 blur 확정 경로에 들어가지 않는다.
- blur listener가 다른 UI에 focus를 넘기는 경합은 복원보다 새 소유자를 우선한다. focus 강탈 금지 불변식은 유지된다.
- 순수 컨트롤러 테스트는 active helper에서 `blur → focus`가 실제로 발생하는지, blur 중 새 소유자에게 양보하는지, 입력 선점이 예약을 취소하는지를 고정한다. `TerminalView` 통합 테스트는 Windows/Linux gate와 window blur/focus 배선을 검증한다. 실제 xterm 테스트는 DECSET 1004 focus report가 추가로 발생하지 않고 복귀 직후 한글 commit이 정확히 한 번 전달되는지를 고정한다.
- living doc §8.9와 cursor trace payload를 함께 갱신한다. Windows IME 후보창은 Automation screenshot이 포착하지 못할 수 있으므로 최종 실기는 좌상단 조합 UI와 중복 음절이 사라지는지 직접 확인한다.
- WebView2가 네이티브 입력 문맥을 명시적으로 갱신하는 공개 API를 제공하거나 Windows에서 이 cycle의 회귀가 관측되면 더 낮은 비용의 refresh 신호를 재검토한다. Linux는 같은 고아 문맥이 실측되고 headful 조합 검증이 갖춰질 때만 별도 결정으로 활성화한다.
