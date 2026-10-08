# 0304. 데몬 업무 이벤트를 제한된 journal로 GUI에 전달한다

- Status: Proposed
- Date: 2026-10-08
- Source: PR #1143 완주 지시, [ADR-0302](0302-pty-daemon-gui-projection-and-control-barriers.md), [data-flow §13.5](../architecture/data-flow.md#135-체크포인트-조정과-파괴-전-barrier)
- 관계: ADR-0302의 업무 OSC 전달과 source/delivery generation 분리를 구체화한다.

## Context

PTY가 GUI 밖에서 OSC를 처리해도 CWD·제목·활동 변경을 GUI에 전달하지 않으면 Explorer와 selector가 오래된 상태를 표시한다. raw VT 재생으로 업무 이벤트를 다시 만들면 중복 알림·query reply가 발생한다. 느린 GUI 때문에 source의 이벤트 보관량이나 callback 대기가 무한히 증가해서도 안 된다.

## Decision

**업무 이벤트는 source generation과 증가 sequence에 결부된 bounded journal에 기록하고 인증된 GUI가 읽는다.**

- journal은 허용된 구조화 이벤트만 보관한다. raw terminal output·GUI 제어·인증 credential은 전달하지 않는다.
- journal 예산은 serialized payload 기준 1 MiB와 4,096개다. 초과 시 오래된 이벤트를 제거하며 현재 sequence보다 미래인 cursor는 거절한다. cursor가 보관 범위를 벗어나면 gap을 명시하고 source catalog로 상태를 재시드한다. 누락된 알림을 새 알림으로 합성하지 않는다.
- source callback은 bounded 메모리 작업만 수행하며 GUI transport를 기다리지 않는다. GUI는 독립 인증 조회 연결에서 journal을 읽고 incarnation·attachment·source generation을 검증한다.
- GUI mirror가 존재하는 현재 source generation의 이벤트만 적용한다. generation 필드는 현재 GUI delivery generation으로 변환한다. source generation을 presentation generation으로 직접 게시하지 않는다.
- GUI 재접속과 gap 복구는 catalog의 현재 CWD·제목을 게시한다. 이미 지나간 transient 알림은 새 접속에 재생하지 않는다. 입력이나 query reply를 재전송하지 않는다.

## Alternatives Considered

- raw OSC를 GUI에서 재파싱: 소유권이 분산되고 업무·query 부작용이 중복된다.
- callback에서 동기 IPC 전송: GUI 지연이 source PTY reader를 막는다.
- 무제한 이벤트 보관: 출력과 활동 부하에 비례하여 메모리 사용이 증가한다.
- 상태만 polling: 짧은 command 완료와 알림을 놓쳐 기존 의미를 보존하지 못한다.

## Consequences

GUI 없이도 source는 상태·저장을 진행하며 재접속한 GUI는 현재 상태를 표시한다. journal의 부하는 고정 예산으로 제한된다. gap 동안 발생한 transient 알림은 전달 보장이 없고 상태 재시드가 필요하다. sequence/generation 변환·gap·느린 GUI·실제 OSC CWD 변경을 테스트하며 예산 조정은 측정과 새 결정으로 기록한다.
