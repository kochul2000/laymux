# 0230. textarea가 통째로 교체된 조합 확정은 compositionend 데이터로 복구한다

- Status: Accepted
- Date: 2026-09-04
- Source: 사용자 보고(Windows Direct 입력이 보였다가 사라짐), [xterm.js #6049](https://github.com/xtermjs/xterm.js/issues/6049), [ADR-0093](0093-xterm-composition-keypress-reconciliation-owner.md), [architecture/data-flow.md §8.14](../architecture/data-flow.md)
- Extends: [ADR-0093](0093-xterm-composition-keypress-reconciliation-owner.md)

## Context

xterm 6.0.0의 숨은 helper textarea에는 이미 PTY로 보낸 IME 확정 문자열이 포커스를 잃을 때까지 남는다. 다음 조합은 그 잔여 문자열 뒤의 위치를 시작점으로 기록한다. Windows TSF 계열 IME가 이후 textarea 전체를 새 조합값으로 교체하면 기록한 시작점은 새 값의 범위를 벗어나거나 그 안의 뒤쪽을 가리킨다. delayed finalizer가 이 낡은 위치로 substring을 구하면 확정 문자열의 앞 N자가 잘리고, 잔여 문자열이 더 길면 확정 전체가 사라진다.

설치된 실제 xterm을 사용한 결정적 재현에서 helper에 이전 입력을 남긴 뒤 `수정을 해야 할거 아냐`로 전체 교체하면 `onData`에는 `냐`만 나왔다. 조합 중에는 Laymux preview가 보이지만 확정 byte가 PTY로 전달되지 않으므로 사용자는 입력이 느리게 나타났다가 지워진 것으로 보게 된다.

범위는 `compositionend`가 있는 Direct IME 확정, ADR-0093 세대별 중복 방지 큐, 기존 TerminalView blur fallback과의 소유권 경계다. fallback 자체의 상태 계약, clipboard paste의 단일 structured write, PTY write 실패, 출력 parser 적체는 바꾸지 않는다.

## Decision

**`compositionend.data`를 해당 조합 generation의 확정 후보로 보존하고, textarea slice와 기존 ordered merge한 값을 input·keypress 관측 조정의 기준으로 사용한다.**

- CoreBrowserTerminal의 `compositionend` listener는 이벤트의 `data`를 CompositionHelper에 넘긴다. helper는 delayed finalizer가 만드는 generation record에 그 값을 함께 저장한다.
- flush 시 취소되지 않은 generation은 textarea slice와 `compositionend.data`를 기존 양방향 포함·suffix-prefix merge로 먼저 합친다. 낡은 시작점이나 비어 있는 스냅샷이 만든 빈 값, 확정값의 suffix는 전체 확정값으로 복구되고 propagation 사이 들어온 비조합 suffix는 유지된다. 이후 ADR-0093의 input·keypress observation fold를 그대로 적용한다.
- 새 `compositionstart`는 직전 pending generation의 textarea 문자열 자체를 스냅샷한다. 길이만 고정한 뒤 flush에서 live textarea를 다시 읽지 않으므로 다음 조합이 전체 값을 교체해도 이전 세대에 새 문자열이 섞이지 않는다.
- CoreBrowserTerminal의 blur handler는 textarea를 비우기 전에 현재 조합을 event-data 비허용 상태로 만들고 이미 끝난 pending generation을 모두 FIFO flush한다. 따라서 세대별 slice·event data·input/keypress 관측이 clear 전에 정확히 한 번 전송되고, 뒤따르는 issue #555 TerminalView fallback은 pending이 해소된 것을 보고 다시 보내지 않는다. 아직 `compositionend`가 없는 진행 중 조합만 fallback이 맡으며, blur 뒤 늦게 생성된 generation은 취소되어 refocus 뒤에도 살아나지 않는다.
- `compositionend.data`가 비었거나 없는 합성 호출은 기존 textarea slice로 떨어진다. `compositionend` 없이 keydown이 호출하는 immediate finalize는 기존 범위 slice를 유지한다.
- xterm 6.0.0 ESM·CommonJS exact bundle patch와 설치 계약 테스트를 함께 갱신한다. 실제 설치된 `Terminal` 회귀 테스트가 잔여 textarea → 전체 교체 → 확정 순서를 `onData`까지 고정한다.

## Alternatives Considered

- **확정할 때마다 helper textarea를 비운다.** 잔여물 원인을 없애지만 screen reader가 의존할 수 있는 xterm lifecycle까지 바꾸며, delayed input·keypress 관측과의 정리 시점도 새로 정해야 한다. 현재 유실보다 범위가 커서 선택하지 않는다.
- **compositionupdate마다 시작 오프셋을 다시 계산한다.** 전체 교체가 일어난 순간의 selection geometry와 이벤트/DOM 변경 순서는 IME마다 다르므로 확정 문자열의 안정적인 경계가 되지 못한다.
- **`compositionend.data`만 전송한다.** replacement에는 맞지만 xterm이 propagation을 기다리는 동안 붙은 비조합 문자와 historically unreliable한 event data를 보완하지 못한다. 기존 textarea 후보와 합친다.
- **TerminalView에서 사라진 확정을 다시 보낸다.** generation·textarea·input·keypress를 소유한 CompositionHelper 밖에서 중복 여부를 추정하게 되어 ADR-0093의 단일 소유권을 깨므로 선택하지 않는다.

## Consequences

Windows IME가 focus를 유지한 helper textarea 전체를 교체해도 확정 문자열의 앞부분이나 전체가 사라지지 않는다. 기존 연속 generation 격리, input-first·keypress-first 중복 억제, 비조합 suffix 순서와 blur fallback 소유권은 유지된다.

`compositionend.data`와 textarea 후보가 서로 포함되지 않는 경우에는 기존 shortest ordered merge의 한계가 적용된다. 실제 Windows WebView2/한국어 IME 검증은 dev 19281에서 별도로 필요하며, xterm이 동등한 upstream 수정이 포함된 버전으로 올라가면 local exact bundle patch를 제거한다.
