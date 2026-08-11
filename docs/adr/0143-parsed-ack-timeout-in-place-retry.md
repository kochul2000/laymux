# 0143. v3 parsed ACK timeout 은 교체 없이 제자리 재시도한다 (0095 Amend)

- Status: Accepted
- Date: 2026-08-11
- Source: 실사용 재현(`docker logs` 급 출력 버스트에서 pane 이 `parsed_ack_timeout` fail-stop), [ADR-0086](0086-terminal-output-control-epoch-watchdog.md), [ADR-0095](0095-terminal-output-bounded-envelope-and-frame-continuation.md), [ADR-0126](0126-terminal-output-repair-timeout-budget.md)
- **Amends:** ADR-0095 의 control liveness 를 parsed ACK 에도 일관 적용한다. receipt/hold/close 의 timeout→동일 identity/payload 재시도, orphan cap 에서만 fail-stop 규칙은 그대로다.

## Context

v3 parsed ACK IPC 는 5초 control watchdog 을 가진다. 대량 출력 버스트 중 메인 스레드가 대형 envelope emit dispatch 로 포화되면 ACK **응답** 왕복이 5초를 넘을 수 있다 — 백엔드는 ACK 를 정상 수락해 parsed frontier 가 전진 중인데도. 기존 v3 분기는 이 지연 스파이크를 즉시 치명 처리(`parsed_ack_timeout` fail-stop)해 close/recreate 를 강제했다.

ADR-0095 는 receipt/hold/close 에 대해 "timeout 뒤에는 동일 identity/payload 로만 retry 하고, orphan cap 에 도달하면 fail-stop" 을 규정했고 `terminal-output-delivery-control.ts` 가 이를 구현한다. parsed ACK 만 timeout 즉시 fail-stop 인 비대칭이 결함의 원인이다. 백엔드의 5초 parsed-progress deadline 은 **실제 진행 정지**를 감시하므로, frontend watchdog 이 왕복 **지연**만으로 pane 을 죽일 이유가 없다.

## Decision

**v3 parsed ACK watchdog timeout 은 sender 를 폐기하지 않고 제자리 재시도한다. fail-stop 은 orphan hard cap 에서만 일어난다.**

- timed-out ACK Promise 는 취소할 수 없으므로 registry orphan 으로 과금을 유지한 채, 교체 전송이 **같거나 더 나중의 coalesced contiguous prefix** 를 보낸다. seq 는 단조증가만 가능하다.
- 늦은 정착의 흡수 규칙: late `true` 는 confirmed prefix 를 `max` 로 전진(단조라 항상 안전), late `false` 는 기존대로 lease-lost fail-stop, stale send 의 late reject 는 현재 send 의 watchdog·rejection retry 를 건드리지 않는다.
- 동시 orphan 은 기존 admission(terminal 당 6 / WebView 전체 6)이 상한이다. cap 소진 시 기존 `control_orphan_cap` fail-stop 이 유한한 종단을 소유한다. 재시도 예산 최대 약 6×5 s = 30 s 는 서버 delivery expiry 40 s(ADR-0126) 안쪽이다.
- **백엔드 멱등 흡수:** orphan 과 교체 ACK 두 IPC 가 동시에 존재하므로, 유효 generation/token 에서 `seq < parsed_seq`(delivery)·`seq < parsed_ack`(flow) 인 늦은 중복은 contract fault 가 아니라 stale no-op 성공으로 처리한다. frontier 는 단조라 정보 손실이 없다. `seq > observed/write` 경계 위반은 계속 fault 다.
- v2 는 ADR-0086 의 epoch 교체 watchdog 경로를 그대로 유지한다. ADR-0095 의 replacement attach·reset/replay 금지도 그대로다 — 이 재시도는 lease/token/epoch 를 일절 교체하지 않는다.

## Alternatives Considered

### timeout 시 즉시 fail-stop 유지 (기존)

왕복 지연 스파이크와 실제 진행 정지를 구분하지 못해 건강한 pane 을 죽인다. 진행 정지는 백엔드 parsed-progress deadline 이 이미 감시하므로 중복 방어이며 기각한다.

### 재시도 payload 를 orphan 과 동일 seq 로 고정

ADR-0095 문구에는 더 가깝지만, orphan 미정착 중에도 정상 진행 ACK 가 더 큰 seq 를 계속 보내므로 낮은 seq 늦은 실행 레이스는 그대로 남는다. 백엔드 멱등 흡수 없이는 불충분해 기각한다.

### v3 에서 replacement attach 허용

ADR-0095 가 명시 기각한 reset/replay·토큰 교체를 되살린다. 기각한다.

## Consequences

- `docker logs` 급 버스트에서 ACK 왕복이 일시적으로 5초를 넘어도 pane 은 살아서 진행을 계속한다. bridge 가 실제로 죽으면 약 30초 안에 `control_orphan_cap` 으로, 진행이 실제로 멈추면 백엔드 expiry 로 여전히 유한하게 fail-stop 한다.
- 백엔드가 낮은 seq 늦은 중복을 흡수하므로 "역방향 ACK" 버그 검출력은 약해진다. frontier 단조 불변식은 유지되므로 실질 피해는 없다.
- `parsed_ack_timeout` fail-stop reason 은 더 이상 생성되지 않는다.
