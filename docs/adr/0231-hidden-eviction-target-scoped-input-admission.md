# 0231. 숨김 자동 종료의 입력 차단은 대상 terminal에 한정한다

- Status: Proposed
- Date: 2026-09-05
- Source: 사용자 보고(숨김 이후 장시간 입력 유실, 미진입 복원 예정 pane), [조사 기록](../hidden-eviction-input-loss-investigation.md), [data-flow §13.5](../architecture/data-flow.md)
- Amends: [ADR-0222](0222-agent-session-checkpoint-coordinator.md)의 숨김 eviction 전역 입력 차단. 업데이트의 전역 차단과 결론적 checkpoint 요구는 유지한다.

## Context

숨김 자동 종료의 저장 실패가 반복되면 전역 finalization fence가 주기적으로 모든 pane의 키 입력·붙여넣기를 거부한다. 미방문 workspace는 PTY가 없지만 자동 종료 후보에는 포함돼 실패 대상이 계속 재시도된다. background 리소스 회수 실패가 foreground 작업을 파괴해서는 안 된다. 저장을 생략해 세션 복원 증거를 잃는 것 역시 허용하지 않는다.

## Decision

**숨김 eviction은 대상 terminal의 입력만 차단하고 drain하며, 업데이트만 앱 전체 terminal 입력을 차단한다.**

Rust checkpoint runtime이 대상 집합과 terminal별 승인 입력 수를 소유한다. Human raw/structured/binary 입력과 xterm protocol reply는 terminal별 permit을 가진다. admission과 대상 집합 변경은 하나의 짧은 mutex로 직렬화한다. 대상 입력과 이미 승인된 generic mutation을 drain한 뒤 기존 이중 안정 checkpoint와 close를 수행한다. 다중 terminal을 변경할 수 있는 generic mutation 및 생성/종료는 eviction 동안 기존 admission 경계에서 대기 또는 거부되며 대상 증거를 변경하지 않는다. unrelated terminal 입력은 drain 완료 조건에 포함하지 않는다.

eviction scope는 모든 오류·취소에서 RAII로 해제한다. 업데이트가 시작되면 신규 eviction과 모든 입력을 막고 기존 eviction 완료도 drain한다. bounded drain 실패 시 updater의 전역 fence는 해제한다. checkpoint 미확정·저장 오류를 성공으로 변환하지 않는다.

UI는 PTY 생성 완료가 관측된 hidden terminal만 자동 종료 요청 대상으로 삼는다. backend도 live handle이 전혀 없는 요청에는 fence 없이 반환한다. 미진입 pane의 저장된 resume ID와 lazy mount 계약은 보존한다. 이 정책은 Windows·Linux에 동일하게 적용한다.

## Alternatives Considered

- 재시도 backoff만 추가: 유실 빈도를 낮추지만 다른 pane 입력을 버리는 원인은 남는다.
- checkpoint 생략 또는 unknown을 noAgent로 취급: 복원 세션 증거를 잃으므로 기각한다.
- 모든 mutation을 terminal별로 전면 재설계: multi-target group/structural 명령의 범위까지 확장되므로 이번 변경에서는 입력 경계만 세분화한다.

## Consequences

실패하는 숨김 정리 중에도 unrelated terminal 입력이 유지된다. terminal permit과 전역 permit의 drain 경계를 함께 검증해야 한다. 다중 pane generic 명령은 아직 eviction 동안 제한된다. 업데이트가 진행 중인 eviction을 기다리는 시간은 기존 bounded drain 예산을 따른다. 세션 복원 포맷·설정 migration은 없다. 대상 입력 drain, unrelated raw/paste, 취소, update 경합, 미진입 pane 제외를 테스트와 dev에서 검증한다.
