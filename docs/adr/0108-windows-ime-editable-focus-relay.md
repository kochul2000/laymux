# 0108. Windows IME 복구는 별도 editable focus relay 문맥을 경유한다

- Status: Proposed
- Date: 2026-08-01
- Source: 사용자 실기 보고(입력 중 다른 laymux dev 창이 포커스를 가져간 뒤 좌상단 IME UI 재발, Alt+방향키 pane 왕복으로 복구), trace-enabled Windows dev 실측, `docs/architecture/data-flow.md` §8.9, [ADR-0057](0057-terminal-helper-focus-ownership.md)
- Supersedes: [ADR-0082](0082-terminal-helper-ime-focus-refresh.md)의 same-helper `blur()` → `focus()` 복구 신호. ADR-0057의 pane-local 소유권과 focus 강탈 금지 경계는 유지한다.
- Relation: [ADR-0081](0081-pane-focus-transition-single-owner.md)의 pane 전환이 서로 다른 xterm helper 사이에 만든 실제 editable focus handoff를 복구 신호의 근거로 사용하지만, store pane focus는 변경하지 않는다.

## Context

ADR-0082와 PR #620은 Windows WebView2에서 앱 복귀 후 DOM-active xterm helper를 같은 element의 `blur()` → `focus()`로 cycle하면 네이티브 IME/TSF 문맥도 재활성화된다고 결정했다. 일반 Alt-Tab 실기에서는 좌상단 IME UI와 중복 입력이 사라졌지만, 사용자가 타자를 치는 중 다른 laymux dev 창이 잠시 foreground를 가져가는 경로에서 같은 증상이 재발했다.

trace-enabled Windows dev에서 재현한 결과, 앱 blur 때 올바른 helper identity가 캡처됐고 복귀 때 `focus-ownership-reclaimed`가 `refreshedActiveHelper: true`로 끝났다. xterm의 helper `blur`/`focus` 이벤트와 focus report도 각각 한 번만 발생했으며 `document.activeElement`도 같은 helper로 돌아왔다. 새 조합은 이 cycle이 끝난 약 408ms 뒤 깨끗한 textarea에서 시작했고 commit도 한 번만 전달됐다. 그럼에도 Windows의 별도 IME UI는 다시 나타났다. 즉 이번 재현에서 DOM lifecycle 성공은 네이티브 editable/TSF 문맥 복구의 성공 증거가 아니며, composition 문자열 경로나 예약 취소가 원인이 아니다.

반면 사용자가 Alt+방향키로 다른 pane에 갔다가 돌아오면 증상이 해소된다. 이 경로는 같은 helper를 재호출하는 대신 서로 다른 xterm helper textarea가 차례로 focus를 소유한다. WebView2 내부 구현을 직접 관측할 수는 없으므로 same-element cycle이 TSF에서 병합되는지는 추론이지만, 현재 측정으로 구분되는 복구 신호는 **다른 editable element identity가 실제 focus를 소유했다가 원래 helper로 돌아오는 것**이다.

범위는 ADR-0057이 소유권을 기록한 Windows Direct 입력 helper의 앱 blur/focus 복구다. pane store focus 전환, composer 입력, 문자열 commit/중복 제거, Win32 TSF 객체 직접 제어, Linux의 DOM-active helper, 일반 pane navigation은 비목표다.

## Decision

**Windows에서 소유권이 기록된 xterm helper가 window focus 시점에도 DOM-active라면, 다음 물리 입력보다 앞선 microtask에서 pane-local의 별도 editable textarea인 focus relay가 실제 focus를 한 번 소유한 뒤 원래 helper로 돌아오게 한다.**

- `TerminalView`는 각 terminal surface 안에 tab 순서와 pointer hit-test에서 제외되고 시각적으로 보이지 않는 빈 textarea relay를 하나 둔다. relay는 평소 `disabled` + `aria-hidden`이며, handoff 동안에만 enabled 상태와 접근 가능한 이름으로 노출된다. relay는 입력 UI나 상태 SoT가 아니며, IME 복구 중 서로 다른 editable identity를 제공하는 역할만 한다.
- `terminal-focus-ownership` 컨트롤러가 전체 handoff를 소유한다. 기억한 helper를 blur한 뒤 focus가 여전히 `body`/`null`/`documentElement`인지 확인하고, 연결돼 있으며 같은 surface 안의 별도 relay를 focus했다가 blur한다. relay가 실제 active element였고 다시 focus가 비어 있음을 확인한 뒤에만 원래 helper를 focus한다.
- helper blur, relay focus/blur, 최종 helper focus마다 generation·dispose·surface/helper 연결을 다시 확인하고, relay 단계에서는 캡처한 relay identity도 현재 relay인지와 현재 surface 안에 남아 있는지를 함께 확인한다. 동기 focus 이벤트가 pane 전환·unmount를 일으키거나 모달·검색·설정 입력 등 다른 요소가 focus를 얻으면 새 소유자를 우선하고 기술 relay/helper의 focus를 놓은 뒤 복구를 중단한다. relay가 없거나 focus되지 않으면 기존 helper focus를 fallback으로 수행하되 trace에 relay 실패를 남긴다.
- 복귀 시 focus가 이미 `body`/`null`/`documentElement`이면 기존 ADR-0057처럼 helper를 바로 focus한다. 별도 relay는 same-helper stale 분기에만 사용한다.
- same-helper stale 분기는 window-focus task 끝의 microtask에서 실행해 다음 물리 `keydown`·`beforeinput`·`input`·`compositionstart`보다 먼저 끝낸다. 입력 이벤트 도착은 네이티브 IME 문맥이 건강하다는 증거로 사용하지 않는다. 단, 같은 window-focus 호출 스택에서 합성·중첩 입력이 이미 시작된 경우에는 기존 세대 무효화로 그 입력을 blur하지 않는다. microtask가 handoff에 진입한 뒤 controller 자신의 기술 blur/focus가 동기 발생시킨 composition commit/input 통지는 사용자 입력 경쟁으로 취급하지 않는다. focus가 주인 없는 일반 복원과 Linux의 DOM-active 확인은 다른 UI가 focus를 정할 시간을 주도록 기존 animation frame을 유지한다.
- 이 경로는 Windows에서만 활성화한다. Linux의 DOM-active helper는 그대로 두며, pane/store focus 또는 xterm 이외의 입력 경로를 전역으로 다시 focus하지 않는다.
- trace는 helper cycle 여부와 relay가 실제 사용됐는지를 구분한다. DOM active element만으로 네이티브 IME 복구 성공을 선언하지 않으며 최종 검증에는 headful Windows 실기를 포함한다.

## Alternatives Considered

- **ADR-0082의 same-helper blur/focus를 유지하거나 반복한다.** 이번 trace에서 정확히 한 번 정상 실행됐는데도 별도 IME UI가 남았다. 횟수를 늘려도 새로운 editable identity를 만들지 않고 조합 lifecycle만 더 흔드므로 기각했다.
- **blur와 focus 사이에 timeout 또는 추가 animation frame을 둔다.** WebView2/TSF가 처리할 시간을 줄 수 있지만 그동안 키 입력이 `body`로 가서 첫 글자가 유실되는 새 race를 만든다. 필요한 시간이 측정되지 않았고 머신 부하에 따라 달라지는 숫자를 계약으로 만들므로 기각했다.
- **Tauri의 webview focus 또는 WebView2 `MoveFocus(PROGRAMMATIC)`를 다시 호출한다.** 호스트 controller에 focus를 넣는 공개 경로지만, 재현 시점에는 이미 같은 WebView와 helper가 DOM focus를 되찾았고 사용자가 확인한 복구 신호는 WebView 내부의 서로 다른 editable element 전환이다. host focus를 전역으로 재호출하면 다른 UI focus를 흔들 수 있어 이번 원인 경계에는 사용하지 않는다.
- **실제 다른 pane helper로 왕복한다.** 관측된 복구와 가장 같지만 다른 pane의 xterm focus report와 UI 포커스 상태를 거짓으로 바꾸고 멀티-pane이 없으면 사용할 수도 없다. 동일 surface의 전용 relay로 native editable identity만 재현한다.
- **Win32 TSF document manager/context를 직접 조작한다.** WebView2가 소유한 사유 객체에 결합하고 Chromium 업데이트에 취약하다. DOM editable handoff라는 공개 브라우저 lifecycle로 재현 가능한 동안은 채택하지 않는다.

## Consequences

- 다른 앱이 입력 중 포커스를 가져간 뒤 같은 helper의 DOM cycle만으로 남던 stale Windows IME 문맥에, 실제 pane 왕복과 같은 distinct editable identity 전환을 제공한다.
- xterm helper 자체의 blur/focus는 여전히 각각 한 번이므로 기존 composition blur 확정과 DECSET 1004 focus report 계약은 ADR-0082보다 늘지 않는다. relay의 focus/blur는 xterm 밖에서 발생하고 PTY 입력이나 focus report를 만들지 않는다.
- relay는 tab/pointer 접근이 불가능하고 비어 있으며 handoff가 한 microtask 안에서 끝난다. 평소에는 disabled라 focus 불가능한 상태에서만 접근성 트리에서 숨고, enabled/focus 상태에서는 `aria-hidden`을 제거해 보조기술 focus가 숨은 노드에 놓이지 않는다. 정상 경로에서는 사용자의 키를 받을 task 간 노출 창이 없지만, focus를 얻지 못하거나 제3 요소가 끼어들면 fallback/거절 trace가 필요하다.
- 순수 컨트롤러 테스트는 `helper blur → relay focus → relay blur → helper focus` 순서, stale microtask와 일반 rAF의 분리, relay 부재 fallback, 중간 focus 경쟁, 동기 lifecycle·relay identity 무효화, 같은-task 합성 입력 취소와 기술 focus의 동기 input 부수 효과 무시를 고정한다. `TerminalView` 통합 테스트는 Windows/Linux gate, pane-local relay 배선, focus 중 접근성 상태를 고정한다.
- 실제 Windows IME UI는 Automation screenshot에 잡히지 않을 수 있으므로, trace-enabled dev에서 외부 foreground 탈취 후 한글 조합 위치와 commit 횟수를 headful로 확인한다. 2026-08-01 검증에서는 입력 중 별도 프로세스 창이 foreground를 1.2초 탈취한 뒤 `usedFocusRelay: true`를 확인했고, 별도 IME 창과 중복 입력이 모두 발생하지 않았다. DOM 테스트만으로 네이티브 복구를 완료 판정하지 않는다.
- WebView2가 editable TSF 문맥의 상태/재활성화를 직접 확인하는 안정된 공개 API를 제공하면 relay를 제거하고 그 API의 성공 응답을 복구 SoT로 삼는 방안을 재검토한다.
