# 0093. 조합 commit 관측은 xterm CompositionHelper의 세대별 큐가 소유한다

- Status: Accepted
- Date: 2026-07-29
- Source: issue [#660](https://github.com/kochul2000/laymux/issues/660), [ADR-0062](0062-composition-commit-keypress-race.md), [architecture/data-flow.md §8.14](../architecture/data-flow.md), 선행 구현 [stablyai/orca#9235](https://github.com/stablyai/orca/pull/9235)
- Supersedes: [ADR-0062](0062-composition-commit-keypress-race.md)

## Context

xterm 6.0.0의 `CompositionHelper._finalizeComposition(true)`는 `compositionend`에서 commit 범위를 캡처하되 실제 textarea 읽기와 전송은 `setTimeout(0)`으로 미룬다. Windows WebView2/한국어 IME에서는 그 사이 이벤트가 `compositionend → input(insertText) → keypress` 순서로 오거나 keypress 없이 `input`만 오는 경우가 있다. 기존 xterm은 `_keyPressHandled === false`인 `input`을 즉시 보내고 finalizer가 같은 candidate를 다시 보내므로 한 글자가 중복된다.

선행 구현 `stablyai/orca#9235`는 이 finalizer 창의 legacy keypress를 CompositionHelper에 보류한 뒤 textarea candidate와 병합한다. 이는 단일 조합 세대의 keypress/candidate 경합을 해결하는 기반이지만 Windows 순서에는 두 공백이 있다.

- `input(insertText)`가 keypress보다 먼저 오거나 단독으로 오면 보류 소유자에 도달하지 않아 finalizer와 중복된다.
- `_isSendingComposition`과 pending 텍스트 하나를 여러 timer가 공유하면 첫 finalizer가 끝나기 전에 다음 `compositionend`가 올 때 상태를 덮어쓴다. 먼저 등록된 timer가 최신 상태를 소비하거나 후속 timer를 무효화해 두 글자 중 하나를 잃거나 순서를 바꿀 수 있다. 다중 pane 출력이 main thread를 점유하면 0ms 창이 길어져 이 경합 가능성이 커진다.

ADR-0062는 TerminalView custom key handler가 xterm private 필드를 읽어 중복을 억제했다. 그러나 embedder는 finalizer가 나중에 읽을 textarea 값과 브라우저가 선택할 `input`/`keypress` 순서를 소유하지 않는다. 소유권이 xterm과 TerminalView로 갈라져 실제 candidate를 보지 못한 추정으로 문자를 버릴 수 있다.

범위는 xterm 6.0.0의 deferred composition finalizer, `input(insertText)`, legacy keypress 사이의 정확히 한 번·순서 보존 전송이다. IME preview 위치, 후보창 앵커, output fair scheduling, PTY/relay, Direct `writeToTerminal` 실패 전파, release 19280 재현은 비목표다.

## Decision

**deferred composition commit은 xterm `CompositionHelper`가 조합 세대별 pending record로 소유하고, `input`·keypress·finalizer 세 경로의 관측을 각 세대에서 정확히 한 번 ordered merge해 전송한다.**

- delayed finalize를 시작할 때마다 캡처한 시작·끝 범위, 다음 조합 시작 전 textarea 경계, 이미 전송된 길이, 순서 있는 관측값, 완료 여부를 가진 generation record를 FIFO에 추가한다. 공유 pending 문자열 하나로 여러 timer를 대표하지 않는다.
- 새 `compositionstart`는 현재 textarea 위치를 직전 pending generation의 상한으로 먼저 고정한 뒤 xterm의 조합 시작 위치를 덮어쓴다. 따라서 첫 timer가 늦어도 다음 세대의 범위를 읽지 않는다.
- `CoreBrowserTerminal._inputEvent`와 `_keyPress`는 계산한 텍스트를 먼저 `CompositionHelper`에 제안한다. pending generation이 있으면 최신 미완료 세대에 이벤트 순서대로 보류하고, 없으면 기존 일반 input/keypress 경로로 즉시 전송한다.
- 각 timer는 자신이 만든 record를 완료 표시하고 FIFO 선두부터 완료된 generation만 flush한다. 일반 keydown의 immediate finalize는 pending generation을 먼저 FIFO 순서로 끝낸 뒤 자기 키를 보낸다. 한 generation은 input, keypress, timer 중 어느 경로가 먼저 왔든 한 번만 flush된다. queue가 비기 전에는 `_isSendingComposition`을 내리지 않는다.
- merge는 event observation을 순서대로 먼저 합치고, textarea candidate와 관측 집합의 양방향 포함 및 suffix-prefix 최장 overlap을 비교해 양쪽 정보를 보존하는 가장 짧은 문자열을 만든다. 같은 길이로 모호하면 실제 관측 순서를 보존한다.
- TerminalView는 `compositionend` 위치를 별도로 캡처하거나 keypress를 `preventDefault`/억제하지 않는다. `xterm-pending-composition.ts`의 private 접근은 issue #555 blur fallback에서 deferred send 중복을 피하기 위한 `_isSendingComposition` 읽기만 유지한다.
- 설치 관문 `ui/scripts/patch-xterm-reflow.mjs`는 pristine xterm을 먼저 선행 keypress patch 형태로 만든 뒤 generation correction을 적용한다. 이미 선행 patch가 설치된 worktree와 최종 patch가 설치된 worktree도 각각 upgrade와 idempotent 성공을 허용한다. ESM/CJS 모두 helper state, input·keypress owner handoff, delayed/immediate flush가 함께 바뀌지 않으면 실패한다.
- 실제 설치된 xterm `Terminal`에 composition/key/input 이벤트를 보내 `onData`를 읽는 테스트가 정본이다. 기존 6개 조합 이벤트열에 Windows의 `compositionend → input → keypress`, input-only, timer 전 연속 두 세대, input/keyPress 뒤 즉시 keydown을 추가하고, pending이 없는 일반 input·keypress 두 경로도 고정한다. 순수 mock merge 함수로 이 상태 전이를 대체하지 않는다.

## Alternatives Considered

- **선행 `stablyai/orca#9235`를 그대로 포팅한다.** 단일 세대의 keypress 경합에는 맞지만 input-before-keypress/input-only를 보류하지 않고, 여러 finalizer가 단일 pending 상태를 공유한다. Windows 이벤트 순서와 연속 조합 세대에서 중복·유실이 구조적으로 남으므로 기각했다.
- **ADR-0062의 TerminalView suffix guard를 유지한다.** bundle을 건드리지 않지만 finalizer가 읽을 최종 textarea와 세대 경계를 알 수 없고 상태 소유권이 helper와 embedder로 갈라진다. input-only와 다중 세대에도 답하지 못하므로 기각했다.
- **pending input/keypress를 모두 즉시 버린다.** 중복은 줄지만 candidate가 비거나 부분 문자열인 경우 실제 사용자의 문자를 잃는다. 기각했다.
- **pending input/keypress를 모두 즉시 보낸다.** candidate에 같은 텍스트가 복원되는 일반 경계에서 중복된다. 기존 xterm 결함이므로 기각했다.
- **시간 창이나 다음 `compositionstart`만으로 duplicate를 추정한다.** IME·브라우저·main-thread 부하에 따라 시간과 후속 이벤트가 달라지고 최종 textarea라는 권위 있는 값을 활용하지 못한다. 기각했다.
- **xterm 전체 fork.** 읽기 쉬운 소스 테스트는 얻지만 dependency 보안·버그 수정 동기화 비용이 크다. 기존 exact bundle 설치 관문에서 필요한 상태만 backport하는 편이 현재 범위에 맞아 기각했다.

## Consequences

- `compositionend → input → keypress`, input-only, 연속 조합 세대, 즉시 keydown 교차에서 각 generation의 문자가 한 번씩 원래 순서로 PTY에 전달된다. pending이 없는 일반 input/keypress에는 추가 지연이 없다.
- xterm 6.0.0 minified ESM/CJS 형태에 의존하는 local patch가 남는다. 대상이 달라지면 postinstall이 즉시 실패하며, xterm 상향 시에는 input ordering과 generation isolation까지 upstream이 동등하게 보장하는지 확인한 뒤 local patch를 제거한다. 선행 PR의 keypress 병합만 존재하는 버전은 동등하지 않다.
- 서로 다른 의도적 반복 입력과 동일한 duplicate 관측은 provenance가 없으면 근본적으로 모호하다. 현재 결정은 한 generation 안의 textarea candidate와 브라우저 관측값의 shortest ordered merge를 택한다. 이를 깨는 실기 증거가 나오면 CompositionHelper에 더 강한 event provenance가 필요하다.
- 자동 테스트는 실제 xterm 코드 경로와 `onData`까지 검증하지만 Windows WebView2/한국어 IME 및 다중 pane flood의 실기 재현률·key-to-PTY exact byte는 dev 19281에서 별도 확인해야 한다. 반복 가능한 Windows IME 실기 자동화는 [#666](https://github.com/kochul2000/laymux/issues/666)이 추적하며, release 19280은 이 검증 대상이 아니다.
- Direct `writeToTerminal(...).catch(...)`가 실패를 호출자에게 전달하지 않는 문제는 이 결정과 별개이며 [#667](https://github.com/kochul2000/laymux/issues/667)이 재현·소유권·실패 계약을 추적한다. 이 PR은 그 경로를 해결했다고 주장하지 않는다.
