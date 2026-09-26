# 0267. 프로세스 기록으로 확인한 현재 Codex 대화는 파일 나이로 만료시키지 않는다

- Status: Proposed
- Date: 2026-09-26
- Source: 실행 중인 WSL Codex의 `activeButUnidentified`로 업데이트가 막힌 사용자 보고, [data-flow.md §13.5](../architecture/data-flow.md)
- Supersedes: [ADR-0258](0258-codex-retained-loop-session-attribution.md)의 최상위 대화 나이 제한(나머지 결정은 유지)
- Amends: [ADR-0118](0118-codex-session-pid-attribution.md)의 Codex 후보 검증

## Context

72시간 제한을 설정한 pane에서 Codex는 살아 있었지만 rollout의 마지막 수정 시각이 72시간을 넘었다. 같은 프로세스의 종료되지 않은 최상위 loop와 정확한 rollout ID가 현재 대화를 증명했는데도 나이 필터가 이를 버려 업데이트 체크포인트가 실패했다. 파일 수정 시각은 현재 대화의 소유권이나 프로세스 종료를 나타내지 않는다.

기존 PID·process UUID·PTY generation 귀속과 파괴 전 이중 관측을 유지하면서, 명확한 현재 대화와 lifecycle 기록이 없는 구버전의 후보 조회를 구분해야 한다. Claude/Grok의 정책, IPC·설정 스키마, 시작 시 resume 명령은 이번 결정 범위 밖이다.

## Decision

**현재 프로세스의 Codex lifecycle로 확인한 대화는 rollout 나이와 무관하게 검증하고, lifecycle 증거가 없는 native 구버전 후보 조회에만 `codex.sessionMaxAgeHours`를 적용한다.**

- 명시적 thread/start·thread/resume 선택과 ADR-0258의 유일한 미종료 최상위 loop 복구에 같은 정책을 적용한다. native와 WSL은 공통 판정을 사용한다.
- 나이만 제외한다. rollout의 존재·유일성·정확한 header ID·최상위 역할을 계속 검증한다. 미완료 전환·Shutdown·복수 최상위 후보·손상·조회 실패를 다른 대화나 fresh 상태로 대체하지 않는다.
- 원본 rollout의 mtime이나 사용자 설정을 수정하지 않는다. 오래된 파일에서 ID를 추측하거나 CWD·최신 활동으로 고르는 fallback을 추가하지 않는다.
- 나이 제한이 남는 구버전 후보 조회는 최신 후보가 만료되면 실패하며 이전 후보로 건너뛰지 않는다. 프로세스·pane 간 중복 소유권, generation 교체와 체크포인트 안정성 검사는 그대로 유지한다.
- 설정 설명은 나이 제한의 적용 범위를 명시한다. 설정값과 IPC 인자는 보존하며 데이터 마이그레이션은 없다.

## Alternatives Considered

- 제한을 더 크게 설정하거나 모든 provider에 무제한을 적용: 시간이 지나면 재발하거나 이번 문제와 무관한 후보 검증까지 완화한다.
- rollout의 mtime 갱신: 사용자 대화 파일을 변경하고 유효한 증거 대신 부수 효과에 의존한다.
- 오류를 무시하고 업데이트: 복원점이 실제로 불명확한 pane까지 종료할 수 있다.
- 최근 파일이나 열린 FD로 현재 대화 선택: 이전·보조 대화가 남는 기존 반례를 다시 허용한다.

## Consequences

장시간 대기한 Codex 대화도 소유권이 확인되면 저장과 업데이트를 계속할 수 있다. 오래된 파일이라는 이유만으로 lifecycle 증거를 거부하던 ADR-0258의 정책을 정정한다. lifecycle 증거가 없는 구버전의 나이 제한과 모든 불확실성 차단은 유지된다.

실제 SQLite·rollout fixture에서 72시간 제한을 넘긴 명시적 선택과 정리 후 loop 복구를 native/WSL 경로로 검증한다. 손상·중복·종료·미완료 전환·PID 재사용 회귀와 구버전 만료 거부도 함께 유지한다. Codex가 현재 소유권을 공식적으로 제공하거나 lifecycle의 의미가 바뀌면 이 정책을 재검토한다.
