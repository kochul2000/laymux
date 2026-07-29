# 0093. 조합 finalizer 중 keypress 조정은 xterm CompositionHelper가 소유한다

- Status: Proposed
- Date: 2026-07-29
- Source: issue [#660](https://github.com/kochul2000/laymux/issues/660), [ADR-0062](0062-composition-commit-keypress-race.md), architecture/data-flow.md §8.14, 선행 검증 [stablyai/orca#9235](https://github.com/stablyai/orca/pull/9235)
- Supersedes: [ADR-0062](0062-composition-commit-keypress-race.md)

## Context

xterm 6.0.0의 `CompositionHelper._finalizeComposition(true)`는 `compositionend`에서 commit 범위를 캡처하고 실제 textarea 읽기와 전송을 `setTimeout(0)`으로 미룬다. 그 사이 legacy `keypress`가 오면 `CoreBrowserTerminal._keyPress`는 같은 문자를 즉시 별도 전송한다. 브라우저·IME는 그 뒤 `input`에서 textarea 후보를 복원하거나, commit 일부와 keypress를 겹친 형태로 노출할 수 있다. 최종 후보와 keypress를 각각 보내면 중복되고 한쪽을 미리 버리면 유실된다.

ADR-0062는 이 문제를 TerminalView의 custom key handler에서 해결했다. 외부 handler가 xterm private 필드 다섯 개를 읽고 `compositionend` 시점의 시작 위치를 별도로 캡처한 뒤, keypress가 당시 pending slice와 같거나 그 suffix이면 즉시 억제했다. 이 방식에는 두 소유권 문제가 있다.

- textarea가 `compositionend`에서 잠시 비었다가 `input`으로 복원되는 이벤트열에서는 외부 handler가 빈 후보를 보고 keypress를 통과시킨다. 뒤늦게 xterm finalizer가 복원된 후보를 다시 보내 중복된다.
- 외부 handler는 keypress 시점의 불완전한 후보만 보고 즉시 전달/폐기를 확정한다. finalizer가 실제로 읽는 최종 후보와 keypress 사이의 포함·부분 overlap을 알 수 없으므로, 빠른 입력에서 문자를 잃거나 순서를 바꿀 수 있다. main thread가 출력 처리로 바쁘면 0ms finalizer 창이 길어져 위험이 커진다.

선행 구현 `stablyai/orca#9235`는 같은 xterm 책임 경계에서 pending keypress를 보류하고 최종 후보와 조정했다. Ubuntu X11/IBus 실기에서 수정 전 30회 중 12회 실패, 수정 후 30/30 exact PTY byte 일치를 보고했고, 설치 번들 대상 6개 결정적 테스트를 제공한다. laymux는 이미 xterm reflow와 `disableStdin` 의미를 exact bundle patch로 고정하는 설치 관문을 갖고 있으므로 ADR-0062가 bundle patch를 기각할 때 전제한 “새 patch 인프라 도입” 비용도 더 이상 존재하지 않는다.

범위는 xterm 6.0.0의 조합 finalizer와 legacy keypress 사이의 입력 상태 소유권이다. 새 IPC·Automation·Remote·PTY 외부 계약을 만들지 않는다. IME preview 위치, 후보 키 정책, output fair scheduling, Direct `writeToTerminal` 실패 처리, release 19280 재현은 비목표다.

## Decision

**deferred composition finalizer가 열린 동안의 keypress는 xterm `CompositionHelper`가 보류하고, final textarea 후보와 한 번만 ordered merge해 전송한다.**

- `CoreBrowserTerminal._keyPress`는 문자를 계산한 뒤 먼저 `CompositionHelper.keypress(text)`에 제안한다. helper의 `_isSendingComposition`이 false면 기존처럼 즉시 `triggerDataEvent`하고, true면 `_pendingKeypressData`에 순서대로 누적하고 즉시 전송하지 않는다. 일반 keypress 경로의 추가 비용은 함수 호출과 boolean 검사 하나다.
- delayed finalize를 시작할 때 pending keypress를 비우고 그 finalizer 세대만 수집한다. timer가 최종 textarea candidate를 읽으면 candidate와 누적 keypress를 `CompositionHelper._sendCompositionInput` 한 곳에서 조정한다. 일반 keydown이 pending timer를 취소하고 immediate finalize하는 경로도 같은 함수로 들어가 keypress를 먼저 잃지 않는다.
- 조정은 두 관측값을 모두 보존하는 가장 짧은 ordered merge다. candidate가 keypress를 포함하면 candidate, keypress가 candidate를 포함하면 keypress를 택한다. 어느 쪽도 포함하지 않으면 `candidate suffix ↔ keypress prefix`와 `keypress suffix ↔ candidate prefix`의 최장 overlap을 비교하고 더 큰 overlap의 순서를 택한다. overlap 길이가 같으면 실제 이벤트 순서인 keypress-first를 택한다.
- 상태 소유자는 xterm 내부 하나뿐이다. TerminalView의 `compositionend` 시작 위치 snapshot, pending slice 판정, keypress `preventDefault`/억제는 제거한다. `xterm-pending-composition.ts`는 issue #555 blur fallback이 중복 주입을 피하기 위해 `_isSendingComposition` 한 필드만 읽는다.
- 설치 관문 `ui/scripts/patch-xterm-reflow.mjs`가 `lib/xterm.mjs`와 `lib/xterm.js` 두 번들에 exact 문자열 교체를 적용한다. 각 원문 target이 없거나 일부만 달라지면 postinstall을 실패시킨다. 두 번들의 helper state·keypress owner·delayed/immediate send·CoreBrowserTerminal handoff가 모두 바뀌어야 설치가 성공한다.
- 검증 SoT는 실제 설치된 `Terminal`에 composition/key/input 이벤트열을 태워 `onData`를 읽는 6개 테스트다: clear 후 candidate 복원, suffix overlap, unmatched keypress 순서, candidate-contained keypress, 여러 keypress partial overlap, 일반 keydown immediate finalize. mock decision 함수로 xterm 상태 전이를 대체하지 않는다.

## Alternatives Considered

- **ADR-0062의 TerminalView 외부 suffix guard 유지.** bundle을 건드리지 않지만 finalizer가 읽기 전의 임시 textarea만 볼 수 있다. clear→input 복원 이벤트열과 다중 keypress overlap을 정확히 판정할 수 없고, 상태 소유권이 helper와 embedder로 갈라진다. 기각.
- **pending keypress를 모두 즉시 버린다.** 중복은 줄지만 candidate에 없는 새 문자도 유실한다. 사용자가 신고한 빠른 입력 유실을 구조적으로 만든다. 기각.
- **pending keypress를 모두 즉시 보낸다.** candidate가 같은 텍스트를 포함하거나 경계에서 겹칠 때 중복한다. 기존 xterm 결함이다. 기각.
- **시간 창 또는 다음 `compositionstart`로 duplicate 여부를 추정한다.** IME별 이벤트열 차이를 시간·후속 이벤트 휴리스틱으로 바꾸며, 최종 textarea 후보라는 권위 있는 값보다 약하다. 기각.
- **xterm 전체 fork.** 읽기 쉬운 TypeScript 소스를 유지할 수 있지만 dependency 보안·버그 수정 동기화 비용이 크다. 이미 있는 exact patch 관문으로 필요한 두 메서드와 한 상태만 backport하는 편이 범위가 작다. 기각.

## Consequences

- 출력 부하로 0ms finalizer 실행이 늦어져도 그 창의 keypress는 유실·중복 없이 final candidate와 한 번 조정된다. PTY·relay·renderer·focus 소유권은 바뀌지 않는다.
- xterm 6.0.0의 minified ESM/CJS 형태에 의존하는 local patch가 늘어난다. 버전 상향 때 target이 달라지면 설치가 즉시 실패하며, 새 번들의 upstream 동작과 6개 이벤트열을 재검토해야 한다. xterm이 동등한 조정을 제공하는 버전을 채택하면 local patch와 이 결정의 구현을 제거한다.
- intentional repeated text가 pending 창의 duplicate 관측과 완전히 같은 좁은 경우는 근본적으로 모호하다. 이번 결정은 최종 candidate와 keypress 두 관측의 shortest ordered merge를 택하며, 실기에서 서로 다른 논리 입력이 합쳐지는 증거가 나오면 CompositionHelper의 추가 provenance가 필요하다.
- 자동 테스트는 실제 xterm 코드 경로와 `onData`까지 검증하지만 Windows WebView2/한국어 IME 및 다중 pane flood 실기는 별도 dev 19281 검증이 필요하다. release 19280은 검증 대상이 아니다.
- Direct `writeToTerminal(...).catch(...)`가 실패를 호출자에게 노출하지 않는 경로는 이 상태 소유권 결정과 별개다. dev byte trace에서 실제 write failure가 확인되면 별도 이슈로 등록할 후속 후보로 남긴다.
