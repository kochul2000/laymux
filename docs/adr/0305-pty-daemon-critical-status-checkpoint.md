# 0305. 파괴 전 Codex 확인은 source의 headless 화면에서 수행한다

- Status: Proposed
- Date: 2026-10-08
- Source: PR #1143 완주 지시, [ADR-0302](0302-pty-daemon-gui-projection-and-control-barriers.md), 기존 Codex status checkpoint와 [data-flow §13.5](../architecture/data-flow.md#135-체크포인트-조정과-파괴-전-barrier)
- 관계: source receipt·critical probe의 책임을 구체화한다. 정상 업데이트 detach는 파괴 전 probe를 사용하지 않는다(ADR-0300).

## Context

GUI mirror에는 native PID가 없고 delivery generation/sequence는 source와 다르다. GUI의 재생된 화면과 제목을 기존 `/status` 확인에 넣으면 현재 대화 증거가 될 수 없다. 실제 종료와 hidden eviction에는 현재 프로세스·rollout 검증과 파괴 전 fence를 계속 유지해야 한다.

## Decision

**daemon 모드의 critical checkpoint는 native source가 입력을 fence하고 headless의 현재 화면에서 기존 Codex `/status` 절차를 실행한다.**

- source receipt의 capture·commit·재사용은 native generation·입력/제목 revision·provider file과 source writer DB revision으로 검증한다. GUI projection은 receipt를 발급하지 않는다.
- GUI finalization과 source finalization을 함께 drain한다. source `/status` 작업은 원래 25초 전체 예산 안에서 프로세스와 terminal generation을 계속 재검증한다. GUI는 source operation의 token만 보유하며 source generation을 GUI delivery generation으로 사용하지 않는다.
- 현재 headless 화면의 idle composer·지원 가능한 메뉴·빈 draft·선택된 Status builtin을 확인한 뒤에만 Enter를 전송한다. draft 삭제·geometry 확대와 실패 시 복구는 기존 정책을 적용한다. 실제 최신 source sequence의 안정된 status 화면과 현재 provider 파일을 모두 확인한다.
- 확인 실패·owner 폐기·deadline 초과는 종료 승인을 만들지 않으며 fence/geometry를 복구한다. complete 전에는 conclusive 저장을 완료한다. 정상 GUI detach/update는 이 파괴적 절차를 호출하지 않는다.
- GUI 재접속은 끝난 이전 attachment의 finalization을 새 owner에게 상속하지 않는다. 미완료 physical 작업이 있으면 재접속을 승인하지 않는다.

## Alternatives Considered

- GUI 화면의 generation을 source generation으로 바꾸어 전달: sequence·기하·현재 프로세스의 증거가 일치하지 않는다.
- cached title이나 provider ID만으로 파괴를 허가: 변경된 대화와 미완료 확인을 구별하지 못한다.
- 모든 source close에 강제 성공을 합성: 기존 destructive barrier의 실패 의미를 잃는다.

## Consequences

GUI와 source의 화면 세대가 달라도 실제 종료의 확인 조건을 유지한다. headless 화면의 composer 판정과 기존 frontend 판정이 같은 제약을 따라야 하며 실제 Codex 버전의 변경을 회귀 fixture와 dev에서 검증해야 한다. 입력 fence·token·geometry 복구 및 owner 단절 테스트가 추가로 필요하다.
