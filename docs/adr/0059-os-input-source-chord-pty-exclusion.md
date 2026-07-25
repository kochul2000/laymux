# 0059. OS 입력 소스 전환 chord 는 사용자 바인딩에서만 PTY 입력에서 제외한다

- Status: Proposed
- Date: 2026-07-25
- Source: issue #533, architecture/data-flow.md §8.11, [ADR-0053](0053-native-windows-synchronized-output-cursor-transaction.md)(IME 키 정책 경계), [ADR-0054](0054-xterm-human-and-protocol-data-origin.md)(입력 데이터 출처)

## Context

Windows/Linux 사용자는 OS 입력 소스(키보드 레이아웃) 전환에 Shift+Space, Ctrl+Space 같은 chord 를 쓴다. 이 조합은 터미널에서도 의미가 있다 — Space 는 텍스트이고 Ctrl+Space 는 일부 셸에서 `NUL` 이다. 사용자가 OS 쪽에 그 chord 를 등록하면 전환이 일어나는 동시에 같은 물리 키에서 파생된 이벤트가 xterm 을 통해 PTY 로도 들어가, 전환할 때마다 셸에 Space 나 숫자가 남는다.

`keydown` 만 건너뛰는 것으로는 부족하다. 설치된 xterm(`@xterm/xterm` 6.x)은 `attachCustomKeyEventHandler` 를 `_keyDown`·`_keyPress`·`_keyUp` **세 곳 모두**에서 호출하고, laymux 의 기존 핸들러는 `e.type !== "keydown"` 이면 즉시 `true` 를 반환해 keypress·keyup 을 그대로 통과시킨다. 실제 누출 경로는 두 개다.

- `_keyPress` → `triggerDataEvent`. `_keyDown` 에서 우리가 `false` 를 반환하면 xterm 의 `_keyDownHandled` 는 `false` 로 남아 keypress 가 계속 진행되고, Space 는 charCode 32 를 그대로 보낸다.
- textarea `input` 리스너(`_inputEvent`). 게이트가 `(!e.composed || !this._keyDownSeen)` 인데 `_keyUp` 이 `_keyDownSeen = false` 를 **커스텀 핸들러 호출보다 먼저** 세팅한다. 따라서 keyup 이후 도착한 비조합 삽입은 게이트를 통과한다.

동시에 두 가지를 깨면 안 된다. 첫째, 전환 chord 를 하드코딩하면 그 조합을 텍스트로 쓰는 사용자의 입력을 빼앗는다. 둘째, 키 이벤트에 `preventDefault()` 를 걸면 OS 가 전환을 수행하지 못해 사용자가 바인딩한 기능 자체가 죽는다.

비목표: Shift+Space/Ctrl+Space 를 전역 하드코딩하지 않는다. Linux IME 후보 선택 Space/숫자 guard(#528)와 합치지 않는다 — 그쪽은 조합 종료 직후 구간을 소유한다. 브라우저/OS 기본 동작을 무조건 `preventDefault` 하지 않는다. Kitty keyboard 를 활성화하거나 우회 정책을 도입하지 않는다.

## Decision

**OS 입력 소스 전환은 키바인딩 레지스트리의 액션(`terminal.osInputSourceSwitch`, 기본 미할당) 하나로 표현하고, 사용자가 실제로 바인딩한 chord 에 한해 그 물리 키에서 파생된 keydown·keypress·keyup·비조합 텍스트 삽입을 xterm 에 전달하지 않는다. 키 이벤트에는 `preventDefault()` 를 걸지 않는다.**

- **기본 미할당.** `defaultKeys: ""` 로 등록한다. 미할당 combo 는 `isAssignedKeybinding()` 이 걸러 어떤 키 이벤트와도 매치되지 않으므로, 아무것도 바인딩하지 않은 사용자에게는 완전한 no-op 이다. 설정 UI 는 빈 칸 대신 "미할당" 을 표시한다.
- **물리 키 범위.** guard 는 매칭된 keydown 에서 `event.code`(없으면 `key`)를 기억하고, **같은 identity** 의 keypress·keyup 만 삼킨다. 수식키가 먼저 떨어져 companion keypress 가 chord 와 더 이상 일치하지 않아도 identity 로 묶인다. 다른 물리 키가 들어오면 소유권을 **버리고** 그 키는 통과시킨다 — 추적을 놓친 상태로 무관한 입력을 삼키지 않는다.
- **키 이벤트에 preventDefault 금지.** xterm 전달만 막는다(핸들러가 `false` 반환). OS 전환은 키 press 자체로 결정되므로 그대로 동작한다.
- **텍스트 삽입은 preventDefault 한다.** helper textarea 의 `beforeinput` 은 취소한다. 이 시점에 OS 전환은 이미 keydown 에서 결정됐고 남은 것은 textarea 로 들어갈 문자뿐이므로, 취소해도 전환에 영향이 없고 취소하지 않으면 xterm 의 `input` 경로로 새어 나간다. **`isComposing` 인 삽입은 절대 막지 않는다** — 조합 문자열은 IME 소유다.
- **정리 시점.** helper blur, helper 교체(xterm 재바인딩), unmount, 다른 물리 키 중 하나라도 발생하면 진행 중이던 press 를 버린다. 시간 기반 timeout 은 두지 않는다 — 해제 신호가 이미 네 개이고 timeout 은 "얼마나 길게" 를 근거 없이 고정한다.
- **모듈 책임.** 판정은 DOM 이벤트 등록이 없는 순수 상태 기계(`ui/src/lib/os-input-source-chord.ts`)가 전부 소유하고, `TerminalView` 는 xterm 키 핸들러와 helper `beforeinput`/`blur` 배선만 한다. IME 키 정책(`ime-key-policy.ts`)과 조합 컨트롤러는 이 chord 를 알지 않는다.

## Alternatives Considered

- **Shift+Space/Ctrl+Space 를 내장 상수로 차단.** 설정이 필요 없어 가장 짧지만, 그 조합을 터미널 텍스트로 쓰는 사용자의 입력을 근거 없이 빼앗는다. 이슈의 비목표에 정면으로 어긋나 기각.
- **keydown 에서 `preventDefault()` 까지 호출.** companion 이벤트가 아예 생기지 않아 구현이 가장 단순하지만, OS 가 전환을 수행하지 못해 사용자가 바인딩한 기능이 죽는다. 기각.
- **`keydown` 만 차단하고 나머지는 xterm 에 맡김.** 현 코드 구조에 가장 작은 변경이지만 위 두 누출 경로가 그대로 남는다 — 실측 근거는 Context 에 적었다. 기각.
- **chord 이후 짧은 시간 창 동안 Space/숫자를 무조건 버리는 timeout guard.** 이벤트 순서를 추적하지 않아도 되지만, 사용자가 전환 직후 의도적으로 누른 Space 를 삼킬 수 있고 "짧은 창" 의 길이에 근거가 없다. 이건 #528(Linux 후보 선택 키)이 재현 근거를 갖고 소유할 문제이며 여기서 선점하지 않는다. 기각.
- **`ime-key-policy.ts` 의 `IME_MODE_SWITCH_KEYS` 확장.** 그 집합은 `HangulMode` 처럼 **전용 키 코드**를 다루고 조합 중에만 동작한다. chord 는 전용 코드가 없고 조합 밖에서도 눌리므로 판정 기준이 다르다. 한 모듈에 합치면 두 정책이 서로의 조건을 훼손한다. 기각.

## Consequences

- 사용자가 chord 를 바인딩하면 전환 시 PTY 바이트가 생기지 않고, 바인딩하지 않으면 기존 입력이 그대로다.
- 키 핸들러가 keypress·keyup 도 보게 되어, 기존 `e.type !== "keydown"` 조기 반환보다 앞에 guard 가 놓인다. guard 가 무장돼 있지 않으면 즉시 통과하므로 일반 입력 경로의 추가 비용은 비교 몇 번이다.
- helper 마다 리스너 2개(`beforeinput`, `blur`)가 추가되고 helper 교체·unmount 에서 해제된다.
- "전환 chord 는 사용자 바인딩에서만, 물리 키 범위로, 키 이벤트 preventDefault 없이" 라는 규칙이 생겼다. 이후 유사 요구(다른 OS 레벨 chord)는 이 액션을 확장하거나 같은 형태의 액션을 추가하는 방식이어야 하며, 키 조합을 코드에 상수로 넣지 않는다.
- 검증은 순수 상태 기계 unit test 13케이스(미할당 no-op, 전체 이벤트열, 수식키 선행 해제, auto-repeat, 다른 물리 키 해제, orphan keyup, 조합 보호, reset/재무장)와 `TerminalView` 통합 test 6케이스(미할당 통과, 바인딩 시 3이벤트 차단 + preventDefault 미호출, 이후 일반 Space 보존, 다른 chord 바인딩 시 통과, 비조합 삽입 차단 + 조합 삽입 보존, 다른 키 해제)로 고정한다. 실기 OS 전환 동작은 CI 에서 재현할 수 없어 `os-input-source-chord-*` trace 로 수동 확인한다.
- 재검토 조건: xterm 이 `_keyUp` 에서 `_keyDownSeen` 을 커스텀 핸들러 **뒤에** 내리도록 바뀌면 `beforeinput` 차단이 불필요해질 수 있다(xterm 자체 게이트가 삽입을 막는다). xterm 상향 시 `_inputEvent` 게이트와 `_keyUp` 순서를 확인 대상으로 남긴다.
