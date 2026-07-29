# ADR-0094: 정상 ACK 용량 경쟁과 attach 안전 경계

- **Status:** Accepted
- **Date:** 2026-07-29
- **Source:** Issues #659, #669; `docs/architecture/data-flow.md` §8.8; `docs/architecture/api-contracts.md` §13.4; ADR-0080, ADR-0084, ADR-0086, ADR-0092
- **Numbering:** PR #668이 ADR-0093을 `main`의 `d8e43df`로 병합했다. 이 ADR 브랜치는 그 최신 `main`에 rebase했고 ADR-0093/0094/0095의 번호 연속성과 충돌 부재를 다시 확인했다.
- **Relation:** 미게시 로컬 `fix/659` 브랜치의 Proposed ADR-0094가 기록한 관측된 ACK 결정을 흡수·대체한다. 이 문서만 해당 결정의 단일 후보 정본이며, 기존 브랜치의 동명 ADR은 별도로 게시·병합하지 않는다. ADR-0092의 physical output write 스케줄링은 변경하지 않는다.
- **Amends:** ADR-0086의 ACK 경로 중 **command 호출 전 정상 composite capacity 거절**을 epoch 폐기·replacement가 아니라 동일 token의 FIFO wait로 바꾼다. 실제 호출 뒤 watchdog, timed-out orphan hard cap과 stale completion 경계는 유지한다.

## Context

데스크톱 출력의 ACK 전송은 정상적인 동시 처리만으로도 frontend command Promise 용량에 도달할 수 있다. #659에서 관측된 결함은 이 정상 용량 경쟁을 전송 실패나 세대 손상으로 해석하여 screen reset/replay를 시작했고, 그 결과 이미 표시된 출력이 다시 보이거나 화면이 비는 것이었다. 용량 대기는 데이터 손상 증거가 아니므로 복구 경로와 분리해야 한다.

#669가 제기한 attach admission 결함은 아직 승인된 재현 절차에서 확인되지 않았다. attach에는 initial, replacement, recovery 등 서로 다른 수명주기가 있고, 재현 없이 FIFO, token 교체 시점 또는 barrier 순서를 고정하면 실제 소유권을 잘못 문서화할 위험이 있다. 따라서 이 ADR은 관측된 ACK 경로만 구체적으로 결정하고 attach에는 공통 안전 불변식과 재현 gate만 둔다.

이 결정은 ACK payload 형식, parsed credit, 출력 ring, attach snapshot 또는 `TerminalWriteBatchQueue`의 물리 바이트 스케줄링을 바꾸지 않는다. 그 데이터 평면은 ADR-0095의 범위다.

## Decision

정상 ACK command 용량 경쟁은 동일 terminal generation과 lease token 안에서 FIFO로 기다리는 control-plane admission이며, 실패·복구 신호가 아니다.

### 관측된 ACK admission

- WebView/window-scoped registry가 ADR-0086의 physical terminal-local/WebView-global composite slot, FIFO reservation, outstanding operation 회계와 cancellation을 계속 단독 소유한다. unmount/stale owner는 자기 waiter와 미사용 reservation을 반환하고 registry가 다음 eligible waiter를 깨운다.
- ACK sender는 동일 `(terminal id, generation, lease token)`의 logical waiter, coalesced parsed prefix와 한 개의 logical in-flight ACK를 소유한다. physical slot이 없으면 registry에 waiter 하나만 등록하고 새 Promise를 만들지 않는다.
- 아직 전송되지 않은 동일 identity의 ACK는 가장 앞선 parsed prefix를 보존하는 범위에서 최신 단조 prefix로 coalesce할 수 있다. 전송 중 요청의 identity나 payload는 바꾸지 않는다.
- 용량 대기 자체는 command watchdog을 시작하지 않으며 ACK epoch, frontend readiness, generation 또는 lease token을 바꾸지 않는다.
- 용량이 생기면 기존 token과 generation으로 전송을 계속한다. 정상 경쟁을 이유로 screen reset/replay, replacement attach, 새 token 발급 또는 출력 폐기를 수행하지 않는다.
- 실제 command 호출 뒤의 timeout, timed-out orphan cap과 stale completion 처리는 ADR-0086의 기존 경계를 유지한다. orphan hard cap 도달은 정상 capacity 대기가 아니다. stale generation/token의 완료는 registry의 자기 composite lease만 정착하며 현재 sender slot, waiter 또는 ACK prefix를 해제하지 않는다.

### attach 안전 경계와 재현 gate

- 정상 capacity 경쟁만으로 attach를 실패·복구 상태로 분류하거나 screen reset/replay를 시작해서는 안 된다.
- #669는 PR B의 candidate SHA에서 승인된 initial attach/remount 재현 절차로 증상이 확인된 경우에만 PR C 범위에 들어간다.
- 재현 전에는 initial/replacement/recovery attach의 FIFO 순서, token 유지·교체 시점, barrier 소유권을 이 ADR로 결정하지 않는다.
- 재현된 attach 구현은 수명주기별 상태 소유권과 순서를 고정하는 새 ADR 또는 이 ADR을 명시적으로 확장하는 후속 ADR을 PR C에 먼저 포함해야 한다. ADR 보완 없이 attach admission 알고리즘을 구현하지 않는다.
- 재현되지 않으면 #669 관련 코드 변경은 하지 않고 공통 acceptance 결과만 기록한다.

## Alternatives Considered

### 용량 경쟁마다 reset/replay

대기열을 만들 필요는 없지만 정상 부하를 데이터 손상으로 오인한다. 이미 적용된 출력의 중복, 빈 화면, 다른 세대 상태 노출을 유발하므로 기각한다.

### ACK마다 독립 Promise를 즉시 생성

평균 지연은 낮을 수 있으나 동시 출력에서 orphan과 watchdog 수가 무제한으로 늘며 순서와 최신 prefix의 소유권이 흐려진다. bounded admission 요구를 만족하지 못해 기각한다.

### ACK와 attach를 하나의 구체적인 FIFO 알고리즘으로 즉시 고정

공통 queue를 재사용할 수 있지만 아직 재현되지 않은 attach 수명주기의 token/barrier 의미를 추측하게 된다. 관측된 결함보다 결정 범위를 넓히므로 기각한다.

### #669를 재현 없이 함께 수정

완료 조건은 넓어지지만 실패 원인과 수정 효과를 분리할 수 없다. 재현 gate와 후속 ADR 없이 구현하지 않는다.

## Consequences

- ACK 정상 부하는 순서를 유지하며 bounded하게 대기하고, capacity 경쟁이 화면 복구로 증폭되지 않는다.
- registry의 physical FIFO/reservation과 ACK sender의 logical waiter/coalescing, identity별 stale completion 검증이 필요해 control-plane 상태와 테스트가 늘어난다.
- 느린 command는 reset/replay로 숨겨지지 않으므로 diagnostics에서 queue wait와 command timeout을 구분해 관측해야 한다.
- attach의 상세 해결은 #669 재현 전까지 의도적으로 미결정 상태다. 이는 조기 구현을 막지만 PR C가 필요할 경우 별도 결정 검토 비용이 생긴다.
- 이 ADR PR은 ADR-0093을 도입한 #668을 먼저 병합하고 최신 `main`에 rebase해야 한다는 선행 조건을 충족했다. `d8e43df`의 ADR-0093과 이 ADR-0094/0095 사이 번호와 관계를 재확인했다.
- 재검토 조건은 ACK 용량 대기가 실제 데이터 손상과 구별되지 않는다는 재현 증거가 생기거나, command transport가 Promise admission과 stale completion 계약을 제거하는 경우다.
