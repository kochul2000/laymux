# 0096. 터미널 인간 입력 IPC 실패는 정확히 한 번 기록하고 재전송하지 않는다

- Status: Proposed
- Date: 2026-07-30
- Source: issue #667, AGENTS.md ADR gate, [api-contracts.md §12](../architecture/api-contracts.md), [data-flow.md §8.14](../architecture/data-flow.md), ADR-0054

## Context

`TerminalView`의 xterm `onData` 인간 입력 경로는 owner permit을 통과한 뒤 `write_to_terminal` IPC를 호출한다. 이 호출의 거절을 빈 `catch`로 버리면 사용자는 키 입력이 전달되지 않았음을 알 수 없고, 운영자는 전달 실패 횟수를 진단할 수 없다. 반면 IPC 거절은 Rust가 바이트를 전혀 받지 못했다는 증명이 아니다. 응답만 유실된 경우 자동 재시도는 같은 키나 제어 문자를 두 번 PTY에 쓰게 할 수 있다.

이 결정은 xterm의 인간 입력과 parser가 만든 protocol reply를 분리한 ADR-0054를 확장한다. 범위는 local owner가 xterm에서 발생시킨 raw 인간 입력의 관측과 사용자 통지이며, backend FIFO, remote owner permit, protocol reply, reset/replay/re-attach에는 관여하지 않는다.

## Decision

인간 raw 입력은 각 `onData` 발생마다 정확히 한 번 `write_to_terminal`을 호출하고, 호출 전후를 terminal별 진단 카운터로 기록한다. IPC가 거절되면 실패 카운터와 바이트 수를 늘리고 action-required 오류 알림으로 자동 재전송하지 않았음을 알린다. 사용자는 다시 입력하여 명시적으로 새 시도를 만든다.

성공/실패와 바이트 수는 frontend health report의 `inputDelivery`에 payload 없이 포함한다. 각 completion은 제출 시점의 session-local token과 아직 정산되지 않은 attempt token이 모두 현재 entry와 같을 때 단 한 번만 정산한다. close 요청은 backend IPC 시작 전에 entry를 fence하며, close 또는 같은 id의 replacement 뒤 late completion은 진단·알림을 다시 만들지 않는다. 카운터는 backend terminal session 수명에 묶이며 close 뒤 제거한다. 이 진단은 제어 경로가 아니므로 permit, generation, FIFO, 수명 또는 recovery 결정을 바꾸지 않는다.

parser-generated protocol reply와 owner permit에 의해 차단된 입력은 인간 전달 attempt로 세지 않는다. IME blur fallback도 같은 exactly-once 실패 관측/통지 정책을 사용한다.

## Alternatives Considered

- IPC 거절 시 즉시 재시도: 응답 유실과 write 미수락을 구별할 수 없어 중복 키 입력과 중복 명령을 만들 수 있으므로 채택하지 않는다.
- 실패를 trace에만 남김: 사용자에게 복구 방법이 없고 외부 diagnostics에서 빈도를 읽을 수 없으므로 채택하지 않는다.
- protocol reply까지 같은 알림/카운터에 합침: emulator가 만든 응답과 사용자의 의도적 입력의 소유권이 달라 ADR-0054의 origin 경계를 흐리므로 채택하지 않는다.

## Consequences

IPC 실패는 눈에 보이고 수치화되며, 각 인간 입력에 대한 자동 side effect는 최대 한 번이다. 반복 거절은 모든 카운터에 누적하되 action-required 알림은 session당 하나로 coalesce한다. 응답만 유실된 실패에서는 사용자가 다시 입력할 때 중복 가능성이 남지만, 자동 재시도로 그 위험을 확대하지 않는다. UI 테스트는 raw human, protocol reply, IME blur fallback과 close 뒤 late completion을 분리해 거절 경로와 카운터를 고정한다. diagnostics 계약과 architecture living doc은 같은 PR에서 갱신한다.
