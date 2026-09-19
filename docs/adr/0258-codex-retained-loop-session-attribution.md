# 0258. Codex 로그 정리 뒤 종료된 선택을 폐기하고 유일한 대화 소유권을 검증한다

- Status: Accepted
- Date: 2026-09-19
- Source: v1.0.7 사용자 보고(`activeButUnidentified`), [data-flow.md §13.5](../architecture/data-flow.md), [Codex의 독립적인 thread 로그 정리](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/state/src/runtime/logs.rs)
- Extends: [ADR-0238](0238-codex-lifecycle-storage-checkpoint.md), [ADR-0248](0248-codex-turn-lifecycle-activity.md)

## Context

Codex는 thread 없는 로그와 각 thread의 로그를 독립적으로 정리한다. 실제 Windows 프로세스에서 이전 대화 A의 resume·Shutdown은 남고 현재 대화 B의 시작 기록은 지워졌다. 기존 판정은 남아 있는 A를 선택했다. 다른 pane이 A를 정상적으로 resume하자 중복 방어가 양쪽 귀속을 거부했다. 이전 threadless 정리 검증은 이 조건을 다루지 않았다.

시작 기록의 존재만으로 현재 소유권을 확정할 수 없다. 반대로 최근 파일·최근 활동만 고르면 보조 에이전트나 이전 대화를 복원할 수 있다. native와 WSL에 같은 증거 규칙이 필요하며, 사용자 DB를 변경하거나 파괴 전 체크포인트의 보호를 우회하지 않는다.

## Decision

**선택 이후의 정확한 Shutdown은 그 선택을 폐기하며, 시작 기록이 사라진 경우에는 같은 프로세스에서 종료되지 않은 유일한 최상위 loop 대화를 rollout과 대조해 복구한다.**

- 구조적 session-loop ID와 DB thread ID가 일치해야 한다. 최상위 Submission의 정확한 Shutdown과 정확한 루트 `Agent loop exited`만 종료 증거다. 후자는 submission 채널이 닫힌 종료와 Shutdown 행이 먼저 정리된 경우도 포함한다([Codex 구현](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/session/handlers.rs)). 인용·유사 operation·중첩 span은 종료로 해석하지 않는다. 이후 명시적 resume는 이전 종료보다 새로운 선택이다.
- 부모 loop 안에서 보조 대화를 초기화하는 행은 외부 span의 부모 ID와 DB의 자식 ID가 다를 수 있다. 정확한 자식 rollout으로 보조 대화임이 확인된 행만 소유권 증거에서 제외한다. 보조 역할 확인에는 복원 대상의 나이 제한을 적용하지 않는다. 파일 누락·손상·다른 최상위 대화의 ID 불일치는 계속 실패로 처리한다.
- 미완료 명시적 전환은 복구를 차단한다. 살아 있는 명시적 선택은 이전 대화의 늦은 활동보다 우선한다. 폐기된 선택 뒤의 복구 후보는 그 선택 이후의 loop 기록을 가져야 한다. Codex는 이전 대화의 종료를 지연할 수 있으므로 종료 시각을 새 대화의 시작 경계로 삼지 않는다.
- 복구는 유효한 최상위 rollout을 가진 후보가 정확히 하나일 때만 허용한다. 증명된 보조 대화와 종료된 loop는 제외한다. ID가 일치하는 일반 loop에서도 보조 역할은 나이 제한 없이 확인하며, 복원할 최상위 대화에는 나이 제한을 적용한다. 미확인·누락·만료·중복·손상 후보는 이전 대화로 건너뛰지 않는다. 복구로 fresh를 합성하지 않는다.
- 복구 선택 키는 process UUID와 대화 ID에 결부한다. 로그 정리로 남은 첫 행이 바뀌어도 키가 흔들리지 않고 프로세스가 바뀌면 달라진다.
- native/WSL은 공통 판정을 사용한다. 동봉 WSL 도우미는 한 SQLite 읽기 트랜잭션에서 얻은 `{process_uuid, rows}` 객체를 반환한다. 호스트와 도우미를 함께 배포하며 구 형식은 실패로 처리한다. IPC·설정 스키마·중복 소유권 거부·이중 관측·업데이트 barrier는 유지한다.

## Alternatives Considered

- 남은 최신 start/resume를 무조건 신뢰: 종료된 대화를 재선택하는 실측 반례가 있다.
- 가장 최근 loop·파일을 선택: 보조 대화와 이전 대화의 늦은 활동이 현재 선택을 덮을 수 있다.
- 귀속 실패나 중복 판정을 무시하고 업데이트 진행: 잘못된 대화를 저장할 수 있다.
- 메모리에 마지막 ID 캐시: 앱 재시작 뒤에는 작동하지 않으며 새 전환 실패를 숨길 수 있다.

## Consequences

대화별 로그 정리 뒤에도 검증 가능한 소유권을 복구한다. 복수 최상위 후보나 미완료 전환은 여전히 미식별이며 새로운 Codex 진단 형식도 보수적으로 처리한다. 내부 진단 의존은 남는다. 독립 thread 정리·종료·동일 ID 재개·보조 대화·파일 장애·PID 재사용을 회귀 검증하고, dev에서 실제 native/WSL 대화의 정리 전후 체크포인트와 재시작 복원을 확인한다. 소유권을 직접 제공하는 공식 인터페이스가 생기면 이 진단 의존을 재검토한다.
