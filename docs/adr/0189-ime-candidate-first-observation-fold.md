# 0189. IME 조합 관측은 candidate에 순서대로 병합하고 consumed keypress를 취소한다

- Status: Proposed
- Date: 2026-08-21
- Source: 사용자 보고(Windows WebView2 → WSL Codex에서 `하면 ` 입력이 간헐적으로 `하면 면`이 됨), [architecture/data-flow.md §8.14](../architecture/data-flow.md), [ADR-0093](0093-xterm-composition-keypress-reconciliation-owner.md), [ADR-0062](0062-composition-commit-keypress-race.md)
- Amends: [ADR-0093](0093-xterm-composition-keypress-reconciliation-owner.md)

## Context

ADR-0093은 xterm 6.0.0의 deferred composition commit 동안 들어온 `input`과 legacy `keypress`를 generation record 하나가 소유하고, 두 관측을 먼저 ordered merge한 뒤 textarea candidate와 합치도록 결정했다. 이 구조는 같은 확정 음절이 `input`과 `keypress`로 반복되는 일반 경합을 제거했지만, 각 관측의 출처 경계를 너무 일찍 지운다.

Windows WebView2가 마지막 조합 음절 뒤 구분자를 `input(" ")`으로 알리고 같은 확정 음절을 legacy `keypress("면")`로 전파하면, 관측끼리 먼저 합친 값은 `" 면"`이 된다. 권위 candidate `"면 "`에는 공백과 음절이 각각 이미 있지만 합쳐진 `" 면"` 전체는 없으므로, 최종 shortest merge는 `" 면 "`을 만든다. 또한 CompositionHelper가 keypress를 보류했다는 boolean만 반환하고 CoreBrowserTerminal이 이벤트의 기본 동작을 취소하지 않으면 WebView2가 같은 음절을 helper textarea에 다시 삽입한다. candidate 자체가 `"면 면"`으로 오염되면 finalizer는 그 전체를 정당한 입력으로 간주한다.

실제 설치된 xterm `Terminal`에서 `compositionend("면") → input(" ") → keypress("면")`과 keypress 기본 삽입을 모델링하면 수정 전 `Terminal.onData`가 `"면 면"`을 방출한다. 앞서 확정된 `"하"`와 합쳐 사용자가 본 `"하면 면"`과 일치한다. 합성 DOM 이벤트는 jsdom에서 기본 삽입을 실행하지 않으므로 테스트가 `defaultPrevented`에 따라 그 변형을 명시적으로 모델링해야 한다.

범위는 PC WebView의 pinned xterm ESM/CJS composition generation patch다. IME preview·후보창 위치, Linux 후보 선택 Space 억제, Remote composer, PTY/IPC 재시도, Codex 렌더링은 비목표다.

## Decision

**권위 textarea candidate를 accumulator로 삼되 첫 candidate anchor 전 관측은 ordered prefix로 보존하고 이후 관측은 하나씩 병합하며, helper가 소비한 legacy keypress는 CoreBrowserTerminal이 기본 DOM 삽입까지 강제 취소한다.**

- generation record는 미리 합친 `observed` 문자열 대신 순서 있는 `observations` 목록을 소유한다. input과 keypress는 pending generation에 자기 문자열을 그대로 append한다.
- finalizer는 캡처 범위에서 textarea candidate를 먼저 읽는다. candidate에 이미 포함된 첫 관측이 정렬 기준을 만들 때까지 unmatched 관측은 기존 merge 규칙의 ordered prefix로 보존하고, 기준이 생기면 그 prefix를 candidate 앞쪽에 병합한 뒤 나머지 `observations`를 하나씩 양방향 포함·suffix-prefix 최장 overlap 함수에 fold한다. 기준 뒤의 양방향 overlap 동률은 accumulator 뒤쪽을 선택한다. 끝까지 기준이 없으면 ordered prefix 전체를 기존처럼 candidate 앞에 병합한다. candidate에 이미 따로 존재하는 공백과 음절은 각 관측 단계에서 각각 흡수돼 출처 경계를 잃지 않으며, anchor가 없는 여러 keypress도 prefix 안에서 기존 순서를 보존한다.
- `CompositionHelper.keypress(text)`가 `true`를 반환하면 CoreBrowserTerminal은 `cancel(event, true)`를 호출한다. 이는 보류한 keypress의 `preventDefault`와 propagation 취소를 같은 xterm 입력 경계에서 수행한다. pending generation이 없어 helper가 `false`를 반환한 ordinary keypress는 기존 즉시 전송과 기본 이벤트 정책을 유지한다.
- TerminalView에 외부 시간창·문자열 guard를 추가하지 않는다. candidate, generation, 관측과 keypress 이벤트를 가진 xterm CompositionHelper/CoreBrowserTerminal이 계속 단일 소유자다.
- postinstall exact patch는 pristine xterm과 기존 ADR-0093 patch 설치본을 모두 새 형태로 올리고, ESM/CJS 어느 한쪽에서 target이 다르면 설치를 실패시킨다.
- 실제 설치된 `Terminal` 테스트는 separator 관측과 propagated keypress를 태우고, 이벤트가 취소되지 않았을 때만 WebView2 기본 삽입을 모델링한다. 최종 `onData`가 `"면 "` 한 번인지와 ordinary keypress가 불필요하게 취소되지 않는지를 함께 고정한다.

## Alternatives Considered

- **consumed keypress의 기본 삽입만 취소한다.** candidate 오염은 막지만 관측을 먼저 `" 면"`으로 합친 손실은 남아 결과가 `" 면 "`이 된다. 실제 실패 테스트가 이 중간 수정도 잡으므로 기각한다.
- **candidate에 keypress 문자가 포함되면 그 keypress를 버린다.** 이번 음절은 제거하지만 의도적으로 같은 문자를 연속 입력한 경우와 구분할 provenance가 없고, source별 임시 규칙이 늘어난다. 개별 관측을 candidate에 fold하면 기존 포함 규칙만으로 같은 결과를 더 일반적으로 얻으므로 기각한다.
- **xterm의 `cancelEvents`를 전역 활성화한다.** 조합 pending과 무관한 모든 keypress의 기본 동작·propagation을 바꿔 IDE 단축키와 접근성 이벤트 표면을 넓힌다. 소비된 한 경로만 강제 취소하면 충분하므로 기각한다.
- **TerminalView custom key handler에서 다시 억제한다.** finalizer가 읽을 textarea 범위와 generation 관측을 외부가 추정하게 되어 ADR-0093이 제거한 이중 소유권을 되살린다. 기각한다.

## Consequences

- separator 직후 확정 음절이 legacy keypress로 재전파되어도 candidate의 기존 음절·공백이 중복되지 않고 PTY에는 `"면 "`이 한 번만 전달된다.
- 각 generation은 하나의 merged 문자열 대신 짧은 관측 배열을 timer가 끝날 때까지 보유한다. 수명은 기존 deferred finalizer 창과 같고, 정상 IME commit의 이벤트 수가 작아 메모리 비용은 제한적이다.
- ADR-0093의 “관측끼리 먼저 merge” 순서는 이 결정으로 정정된다. CompositionHelper 단일 소유권과 shortest ordered merge 함수 자체는 유지한다.
- pinned xterm minified ESM/CJS exact patch의 유지 대상이 늘어난다. xterm 상향 시 upstream이 candidate-first fold와 consumed keypress 취소를 동등하게 보장하는지 확인해야 한다.
- 실제 Windows WebView2의 전체 DOM 이벤트 trace와 출력 폭주별 재현률은 여전히 #666의 실기 검증 대상이다. 이번 회귀 테스트는 사용자 결과와 일치하는 xterm 입력 경로 및 최종 `onData` 바이트를 결정적으로 고정한다.
