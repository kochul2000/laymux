# 0061. native IME 후보창은 두 커서가 갈릴 때만 helper textarea 위치를 shadow cursor 앵커로 옮긴다

- Status: Proposed
- Date: 2026-07-25
- Source: issue #532, architecture/data-flow.md §8.13, [ADR-0053](0053-native-windows-synchronized-output-cursor-transaction.md)("helper textarea 를 이동하지 않음" 정정), [ADR-0054](0054-xterm-human-and-protocol-data-origin.md)(입력 데이터 출처), [ADR-0008](0008-shell-cursor-shadow-cursor.md)(shadow cursor)

## Context

laymux 의 composition preview 는 **shadow cursor** 를 기준으로 렌더링한다(ADR-0008). TUI 프롬프트는 repaint 중에 xterm 의 public buffer cursor 를 footer/status 행으로 옮기므로, buffer cursor 를 읽으면 preview 가 엉뚱한 행에 그려진다.

그런데 **OS 가 띄우는 native IME 후보창은 shadow cursor 를 모른다.** 후보창은 포커스된 xterm helper textarea 의 DOM rect 에서 위치를 잡고, xterm 은 그 textarea 를 public buffer cursor 에 둔다. 두 커서가 갈리는 순간 preview 는 맞고 후보창만 다른 행·열에 뜬다. 사용자 눈에는 "조합 글자는 여기 있는데 후보 목록은 저 아래" 로 보인다.

**ADR-0053 은 helper textarea 를 이동하지 않기로 했다.** 근거는 "재현 없이 항상 textarea 를 강제로 이동하면 진행 중 composition 을 종료하거나 commit 을 중복시킬 수 있다" 였고, 그 판단은 *무조건 이동* 에 대해서는 지금도 맞다. 이 결정은 그 범위를 좁혀 정정한다 — **두 커서가 실제로 갈릴 때만**, **위치만** 옮긴다.

동시에 지켜야 하는 경계가 있다. helper 의 value·focus·composition lifecycle 은 xterm 의 `CompositionHelper` 소유다(ADR-0053/0054). 후보창 정렬을 위해 그 소유권을 가져오면 조합 문자열 정확성 문제(#527 소관)와 뒤섞인다.

비목표: 화면 문자열이나 특정 TUI 제품명으로 프롬프트 위치를 추론하지 않는다. helper 의 value/composition lifecycle/PTY 전송 책임을 가져오지 않는다. 재현 없이 항상 textarea 를 이동하지 않는다. macOS 전용 input context refresh 는 도입하지 않는다.

## Decision

**composition 이 활성이고 public buffer cursor 와 composition 앵커 셀이 다를 때만, helper textarea 의 `left`/`top` inline style 을 앵커 셀 원점으로 옮긴다. 앵커 셀은 preview 가 caret 을 그리는 바로 그 셀이며, 조합이 끝나거나 앵커를 신뢰할 수 없게 되면 원래 inline 값으로 되돌린다.**

- **동기화 게이트는 "두 커서 불일치".** "조합이 활성" 만으로는 옮기지 않는다. 일반 셸에서는 두 커서가 일치하고 xterm 배치가 이미 맞으므로, 그때 옮기는 것은 이득 없는 churn 이면서 IME 를 흔들 위험만 남는다. 판정은 `shouldSyncHelperAnchor(publicCell, anchorCell)` 한 곳이다.
- **앵커 계약은 하나.** preview 의 caret 셀과 후보창의 앵커 셀은 **같은 값**이다 — `updateOverlayCaret` 가 이미 해결한 `cursorX`/`cursorY` 를 그대로 넘긴다. 두 번 계산하면 wrap 규칙이 한쪽만 바뀌는 순간 갈라진다.
- **좌표는 순수 함수로.** cell 크기는 렌더된 rect 에서 유도하고(`targetWidth / cols`), 원점은 `.xterm-screen` 기준 캔버스 offset 이며, 최종 px 는 **device pixel grid 에 snap** 한다. 후보창은 device-pixel rect 에서 배치되므로 CSS 분수 offset 을 남기면 분수 DPR 화면에서 팝업이 caret 과 1px 어긋난다. 뷰포트 밖 앵커는 마지막 가시 셀로 **clamp** 한다 — scrollback·park 로 해결된 행이 화면 밖일 때 팝업이 pane 을 벗어나지 않게.
- **위치만 건드린다.** `left`/`top` 외에는 아무것도 쓰지 않는다. value·focus·composition 이벤트·크기는 읽지도 쓰지도 않는다.
- **원복은 의무.** 조합 종료, 두 커서 재일치, overlay 가 숨는 모든 경로(비포커스·scrollback·geometry 미확정), helper 교체, unmount 에서 저장해 둔 원래 `left`/`top` 으로 되돌린다. 옮긴 상태를 남기면 xterm 이 다음에 배치할 위치와 충돌한다.
- **모듈 책임.** 기하 판정 전부는 DOM 접근이 없는 순수 모듈(`ui/src/lib/ime-anchor.ts`)이 소유하고, `TerminalView` 는 rect 읽기와 style 쓰기만 한다. 그래서 규칙이 headful 없이 테스트된다.

## Alternatives Considered

- **항상 helper 를 shadow cursor 로 옮긴다.** 구현이 가장 단순하지만 ADR-0053 이 기각한 그 방식이고, 두 커서가 같은 일반 셸에서도 매 프레임 style 을 쓴다. 기각.
- **화면 문자열·제품명으로 프롬프트 행을 추론한다**(Orca 의 앱 전용 anchor heuristic). 특정 TUI 버전에 묶이고 이슈의 비목표에 정면으로 어긋난다. shadow cursor 가 이미 일반화된 답을 갖고 있다. 기각.
- **후보창 위치를 직접 지정하는 OS API 를 쓴다.** WebView 안에서는 그런 통제권이 없고, 있더라도 플랫폼별 native 코드가 필요해 이 결정 범위를 넘는다. 기각.
- **preview 를 buffer cursor 로 옮겨 둘을 맞춘다.** 후보창과 preview 가 같은 자리에 오지만 **둘 다 틀린 자리**가 된다 — TUI 에서 buffer cursor 가 footer 로 가는 것이 애초의 문제다. 기각.
- **helper 를 항상 화면 밖으로 보내 후보창을 숨긴다.** 정렬 문제는 사라지지만 후보 선택 UI 자체를 못 쓰게 된다. 기각.
- **cell 크기를 font metrics 로 계산한다.** rect 유도보다 정확해 보이지만 renderer 가 적용한 스케일을 놓쳐 overlay caret 과 다른 값이 나온다. 같은 유도식을 쓰는 것이 "앵커 계약 하나" 의 전제다. 기각.

## Consequences

- 두 커서가 갈리는 TUI 조합에서 후보창이 조합 caret 셀에 붙는다. 일반 셸에서는 아무 일도 일어나지 않는다(style 을 쓰지 않는다).
- helper 의 `left`/`top` 이 조합 중 임시로 앱 소유가 된다. 이 값을 다른 곳에서 쓰기 시작하면 이 결정과 충돌하므로, 위치 소유권은 이 경로 하나로 유지해야 한다.
- ADR-0053 의 "helper textarea 를 이동하지 않음" 은 **"무조건 이동하지 않음"** 으로 좁혀졌다. 이후 요구는 이 게이트를 확장·정정하는 형태여야 하며, 조건 없는 이동으로 되돌리지 않는다.
- 검증은 순수 모듈 unit test 21케이스(cell 유도·게이트·clamp·device-pixel snap·앵커 공유)와 `TerminalView` 통합 test 3케이스(대기 상태 무기록, 발산 시 이동 + 조합 종료 시 원복, 일치 시 무이동)로 고정한다. 두 사보타주(게이트 제거·원복 제거)가 각각 테스트에 잡히는 것을 확인했다.
- **미검증 — native 후보창의 실제 위치는 측정하지 않았다.** 후보창은 OS 창이라 앱 스크린샷에 잡히지 않고, 실 IME 조합을 프로그래밍적으로 띄울 수도 없다. 이 결정이 근거로 삼은 것은 (a) 후보창이 helper rect 에서 위치를 잡는다는 플랫폼 동작, (b) 리포에 이미 존재하는 shadow/public 커서 발산(`computeUseShadowCursor`)이다. 팝업이 실제로 앵커 셀에 붙는지는 `ime-anchor-synced` trace 와 함께 사람이 확인해야 한다.
- 재검토 조건: 실기 확인에서 팝업이 helper rect 가 아닌 다른 기준(예: 선택 영역, IME 별 자체 규칙)으로 배치되는 것이 드러나면 이 결정의 전제가 깨지므로 게이트가 아니라 전제부터 다시 본다. #527 이 xterm composition finalizer 를 건드리게 되면 helper 위치 소유권과의 상호작용을 재확인한다.
