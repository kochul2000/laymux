# 0060. Linux IME 후보 선택 키는 "IME 소비 표식 + orphan companion" 으로만 억제한다

- Status: Proposed
- Date: 2026-07-25
- Source: issue #528, architecture/data-flow.md §8.12, [ADR-0053](0053-native-windows-synchronized-output-cursor-transaction.md)(post-composition suppression 유보), [ADR-0054](0054-xterm-human-and-protocol-data-origin.md)(입력 데이터 출처)

## Context

Sogou/fcitx 계열 Linux IME 는 후보를 **선택하는 데 쓴** Space 나 숫자를 `compositionend` 전후에 일반 키 이벤트로 다시 내보낸다. 두 형태가 보고돼 있다(stablyai/orca#7543, 수정 PR #7634): `keydown → keypress → keyup` 전체 trio, 그리고 `keydown` 없는 orphan `keyup`.

xterm 의 조합 가드는 그 시점에 이미 끝나 있다 — `compositionend` 가 실행되면 `_isComposing` 이 false 이므로 이후 키 이벤트는 정상 경로를 탄다. 게다가 laymux 의 기존 xterm 키 핸들러는 `e.type !== "keydown"` 이면 즉시 `true` 를 반환해 keypress·keyup 을 그대로 통과시킨다. 결과적으로 사용자가 후보를 고를 때마다 literal Space 나 숫자가 셸에 남는다.

**ADR-0053 은 이 문제를 의도적으로 유보했다.** 당시 판단은 "downstream 앱의 fluxtty 식 post-composition printable-key suppression 을 그대로 들여오면 정상적인 composition 직후 첫 글자를 버리거나 xterm commit 과 중복 전송할 수 있다. 공통적으로 입증된 소유권 불변식만 채택하고, post-composition suppression 은 **같은 이벤트 순서와 유령 입력이 재현되는 별도 버그 PR에서 테스트를 먼저 추가하기로** 했다" 였다. 이 결정이 그 PR 이다.

핵심 긴장은 그대로다. "후보 선택 키를 버린다" 와 "사용자가 확정 직후 의도적으로 누른 Space/숫자를 잃지 않는다" 는 동시에 성립해야 한다. `compositionend` 이후 **첫 printable 키를 버리는** 규칙은 두 번째를 깬다 — ADR-0053 이 기각한 그 규칙이다.

비목표: Windows·macOS 에 같은 억제를 전역 적용하지 않는다. 조합 종료 직후 첫 Space/숫자를 무조건 버리지 않는다. OS 입력 소스 전환 chord 는 #533(ADR-0059) 소관이다. xterm composition finalizer 와 keypress 의 경합은 #527 소관이며 이 결정은 xterm 내부를 건드리지 않는다.

## Decision

**후보 선택 키 억제는 시간이 아니라 두 개의 사실 신호로 판정한다. 각각 독립적으로 충분하고, 둘 다 짧은 post-composition window 안에서만 평가한다. window 는 판별자가 아니라 안전 상한이다.**

- **신호 1 — IME 소비 표식.** IME 가 처리한 키는 `keyCode === 229`(또는 `key === "Process"`)로 보고된다. 사용자가 실제로 누른 키는 자기 코드(Space 32, 숫자 48–57)를 보고한다. 이 표식은 xterm 의 조합 경로가 이미 쓰는 것과 같은 것이며 laymux 고유 추측이 아니다.
- **신호 2 — orphan companion.** 이 window 안에서 `keydown` 을 관측하지 못한 물리 키의 `keypress`/`keyup` 은 여기서 시작된 press 에 속할 수 없다. IME 가 소비한 press 의 꼬리다.
- **그 밖의 모든 것은 통과한다.** 완전한 `keydown(keyCode 32) → keypress → keyup` 은 실제 press 이므로 건드리지 않는다. 이것이 "확정 직후 사용자가 누른 Space 를 잃지 않는다" 를 성립시키는 근거다.
- **window 는 안전 상한.** `compositionend` 에서 열리고, 실제 비조합 텍스트 삽입 / 실제 후보 keydown / 무관한 실제 키 / blur·unmount / timeout 중 **먼저 오는 것**에서 닫힌다. 어떤 동작도 "IME 가 몇 ms 걸리는가" 에 의존하지 않는다. 기본 상한은 사람의 연속 타이핑 간격보다 짧게 둔다.
- **빈 `compositionupdate` 는 조합 종료가 아니다.** 일부 IME 는 preedit 를 지울 때 빈 update 를 낸다. 이를 종료로 오인하면 사용자가 아직 조합 중인 상태에서 window 가 열리고, 이후 후보 키가 stale window 로 판정된다.
- **관측 keydown 은 `compositionstart` 에서 초기화한다.** `compositionend` 가 아니다 — 조합이 시작될 때 이미 누르고 있던 키의 keyup 이 종료 후 도착하면 정상 release 인데, `compositionend` 에서 지우면 orphan 으로 오판한다.
- **`preventDefault()` 는 helper textarea 를 변형시키는 이벤트에만.** 차단된 후보 `keydown`, 그리고 차단된 **orphan** `keypress`(orphan 은 취소할 keydown 이 없으므로 자기 default 를 막는 것이 유일한 지점)에만 적용한다. `keyup` 에는 걸지 않는다.
- **Linux 전용.** 플랫폼 판정은 호출부가 하고(`enabled` 플래그) 모듈은 `navigator` 를 보지 않는다. 비활성 시 모든 메서드가 no-op 이라 Windows 한글 입력은 바이트 단위로 동일하다. WSL 은 Windows WebView 라 user agent 가 Windows 를 보고하므로 `Linux` 포함 + `Windows` 제외로 판정한다.
- **모듈 책임.** 판정은 DOM 등록이 없는 순수 상태 기계(`ui/src/lib/linux-ime-candidate-guard.ts`)가 전부 소유한다. `TerminalView` 는 xterm 키 핸들러와 helper 의 composition/input/blur 관찰만 배선하고, **조합 문자열·commit 경로·xterm 의 `CompositionHelper` 소유권은 건드리지 않는다** — ADR-0053/0054 의 경계를 유지한다.

## Alternatives Considered

- **`compositionend` 직후 첫 printable 키를 버린다(fluxtty 식).** 가장 짧지만 사용자가 확정 직후 의도적으로 누른 Space/숫자를 잃는다. ADR-0053 이 이미 이 이유로 기각했고 이 결정도 같은 결론이다.
- **시간 창만으로 판정(예: 30 ms 안의 Space/숫자는 후보).** 이벤트 추적이 필요 없지만 임계값에 근거가 없다. 빠른 타이핑은 창 안에 들어오고 느린 IME 는 창을 벗어난다. 실기 재현으로 임계값을 고정하기 전에는 채택할 수 없어 기각. 이 결정에서 시간은 **상한**으로만 쓴다.
- **`isComposing` 만 신뢰.** `compositionend` 이후 이벤트에서 `isComposing` 은 이미 false 이므로 후보 꼬리를 구분하지 못한다. 기각.
- **xterm 의 `CompositionHelper` 를 패치해 조합 종료 시점을 늦춘다.** 후보 꼬리가 조합 구간 안에 들어와 자연히 억제되지만, xterm 내부 소유권을 가져오고 commit 타이밍을 흔든다. 그 경합은 #527 이 실 PTY 재현 근거를 갖고 소유할 문제다. 기각.
- **`ime-key-policy.ts` 의 `IME_MODE_SWITCH_KEYS` 확장.** 그 집합은 `HangulMode` 같은 **전용 키 코드**를 조합 **중에만** 다룬다. 후보 키는 전용 코드가 없고 조합 **밖**에서 도착하므로 판정 기준이 다르다. 한 모듈에 합치면 두 정책이 서로의 조건을 훼손한다. 기각.
- **모든 플랫폼에 적용.** Windows 한글 입력에서 같은 이벤트열이 재현된 근거가 없고, 근거 없이 켜면 정상 입력을 버릴 위험만 남는다. 기각 — Linux 게이트를 유지한다.

## Consequences

- Linux 에서 후보 선택 Space/숫자가 PTY 로 새지 않고, 확정 직후 사용자가 누른 Space/숫자는 그대로 전달된다. Windows·macOS 는 no-op 이다.
- 키 핸들러가 keypress·keyup 도 보게 되어 기존 `e.type !== "keydown"` 조기 반환보다 앞에 guard 가 놓인다. 비활성(비-Linux)이거나 window 가 닫혀 있으면 즉시 통과하므로 일반 입력 경로의 추가 비용은 비교 몇 번이다.
- helper 마다 리스너 5개(`compositionstart`/`compositionupdate`/`compositionend`/`input`/`blur`)가 추가되고 helper 교체·unmount 에서 해제된다. 모두 관찰 전용이며 조합 lifecycle 을 바꾸지 않는다.
- ADR-0053 이 유보한 post-composition suppression 의 **범위가 이 결정으로 확정**됐다: "첫 printable 키" 가 아니라 "IME 소비 표식 또는 orphan companion" 만 억제 대상이다. 이후 유사 요구는 이 두 신호를 확장·정정하는 형태로만 들어와야 하며, 시간 임계값을 판별자로 승격하지 않는다.
- 검증은 순수 상태 기계 unit test 29케이스 + `TerminalView` 통합 test 6케이스로 고정한다. 이벤트열은 `ui/src/lib/__fixtures__/linux-ime-candidate-traces.ts` 에 fixture 로 남기고, 각 fixture 는 자신이 플랫폼에 대해 무엇을 주장하는지(`platformClaim`)를 함께 기록한다.
- **재현 근거의 한계**: fixture 는 Linux 실기에서 캡처한 것이 **아니라** 업스트림 보고(orca#7543/#7634)의 서술을 재구성한 것이다. 실기 캡처가 확보되면 fixture 를 조용히 교체하지 말고 diff 해서 `platformClaim` 이 맞는지 먼저 확인한다.
- 재검토 조건: 실기 캡처가 `keyCode === 229` 표식을 주지 않는 IME 를 보여주면 신호 1이 무력해지고 orphan 규칙만 남는다(그 경우에도 trio 형태는 잡지 못한다) — 그때 시간 상한을 판별자로 승격할지 재검토한다. #527 이 xterm composition finalizer 를 고쳐 후보 꼬리가 조합 구간 안으로 들어오면 이 guard 의 일부가 불필요해질 수 있다.
