# 0164. 조합 finalize 대기 중에는 229 textarea-diff 를 보내지 않는다

- Status: Proposed
- Date: 2026-08-16
- Source: 사용자 보고(한글 `가` 한 번이 출력 밀림 해제 때 `가가`로 들어감), [ADR-0093](0093-xterm-composition-keypress-reconciliation-owner.md), [data-flow.md §8.14](../architecture/data-flow.md)
- Extends: [ADR-0093](0093-xterm-composition-keypress-reconciliation-owner.md)

## Context

ADR-0093은 xterm 6.0.0의 deferred composition finalizer와 `input`/`keypress`가 같은 음절을 두 번 보내는 경합을 세대별 큐로 합쳤다. 그러나 CompositionHelper에는 네 번째 송신 경로가 남아 있다.

Windows IME는 첫 한글 키에서 `compositionstart`보다 먼저 `keydown` 229를 보낸다. stock xterm은 이 키를 `_handleAnyTextareaChanges`로 받아 textarea 스냅샷을 찍고 `setTimeout(0)` 뒤에 길이 차이를 PTY로 보낸다. 타이머는 `_isComposing`만 본다. 조합이 그 0ms 안에 시작되면 타이머는 침묵하고, 확정은 finalizer가 한 번만 보낸다.

출력 폭주로 메인 스레드가 멈추면 그 0ms가 수 초가 된다. 이벤트는 먼저 처리되어 `compositionend`가 `_isSendingComposition=true`로 finalizer를 예약하고, 풀린 뒤에야 229 타이머가 돈다. 이때는 이미 `!_isComposing`이라 같은 `가`를 보내고, 이어 도는 finalizer가 또 보낸다. ADR-0093의 generation merge는 이 경로를 관측하지 않는다. `write_to_terminal` 재시도가 아니다.

범위는 229 textarea-diff 타이머가 pending finalize와 겹칠 때의 중복 송신이다. IME blur fallback, IPC 실패 정책, output backpressure는 비목표다.

## Decision

**`_handleAnyTextareaChanges`의 deferred textarea-diff는 `_isComposing`이거나 `_isSendingComposition`이면 보내지 않는다.**

pending generation이 있는 동안 `_isSendingComposition`은 true로 유지되므로, ADR-0093 큐와 stock finalizer 모두에서 같은 음절을 두 번 쓰지 않는다. 조합이 시작되지 않은 229 삽입(IME가 켜진 상태의 숫자·구두점)은 두 플래그가 모두 false이므로 기존처럼 보낸다. ESM·CJS·Remote 번들에 같은 설치 관문을 적용한다.

## Alternatives Considered

- **229를 compositionstart 전에도 관측 큐에 넣는다.** 조합이 시작되지 않는 229 삽입까지 삼켜 숫자·구두점을 잃는다. 기각한다.
- **diff 타이머를 없앤다.** 조합 없는 229 삽입의 정본 경로라 기각한다.
- **TerminalView에서 두 번째 `가`를 추정해 버린다.** textarea/finalizer 소유권이 다시 갈라지고 ADR-0093이 기각한 외부 guard다. 기각한다.

## Consequences

한글 한 음절은 메인 스레드가 수 초 멈춰도 PTY에 한 번만 들어간다. 조합 없는 229 삽입은 유지된다. xterm 상향 시 `_handleAnyTextareaChanges`가 `_isSendingComposition`을 이미 보면 이 패치를 제거한다. 재현은 실제 xterm에 229 → compositionend → delayed timer를 보내는 테스트가 고정하고, Windows 실기 한글+출력 폭주는 기존 [#666](https://github.com/kochul2000/laymux/issues/666) 범위다.
