# 0256. Codex의 설정 변경만으로 새 빈 대화의 복원 자격을 취소하지 않는다

- Status: Accepted
- Date: 2026-09-18
- Source: v1.0.5 사용자 보고(`terminal-pane-98e5f58e: activeButUnidentified`), [data-flow.md §13.5](../architecture/data-flow.md), [Codex 0.154.0 Op::ThreadSettings](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/protocol.rs#L599)
- Extends: [ADR-0238](0238-codex-lifecycle-storage-checkpoint.md)의 미영속 새 대화 증거 분류

## Context

새 Codex 대화는 첫 질문 전에는 rollout을 만들지 않는다. 모델 등의 설정을 변경하면 턴을 시작하지 않는 `ThreadSettings`가 질문과 같은 submission queue의 `session_loop` 진단에 남는다. 모든 loop 기록을 입력으로 취급하면 정확한 새 대화 ID를 관측했어도 fresh 자격을 잃고 업데이트 체크포인트가 계속 거부된다. 실제 WSL pane은 새 thread/start 뒤 ThreadSettings 두 건만 기록했고 rollout과 열린 rollout FD가 모두 없었다.

v1.0.5와 v1.0.6의 이 판정은 같다. Chrome 호스트 역할 판정과 상태 아이콘 수정으로는 해결되지 않는다. 범위는 설정 변경의 분류이며, 미확인 대화의 강제 저장이나 runtime 설정 전체의 복원은 포함하지 않는다.

## Decision

**정확한 새 대화의 검증된 `ThreadSettings` submission은 턴 입력 증거로 세지 않는다.**

- native와 WSL은 같은 lifecycle 판정 함수를 사용한다. 기존 PID·incarnation·현재 대화 선택·rollout 검증·이중 관측을 유지한다.
- 로그의 구조적 시작 위치에서 session-loop의 대화 ID, submission ID와 최상위 `op: ThreadSettings`를 확인한 경우에만 설정 변경으로 인정한다. 사용자 본문에 인용된 문자열이나 다른 operation의 내부 필드는 증거가 아니다.
- 실제 입력·중단·종료 및 식별하지 못한 loop 기록은 기존처럼 fresh 자격을 취소한다. 이후 설정 변경이 취소된 자격을 되살리지 않는다. resume는 설정 변경만 있어도 fresh가 되지 않는다.
- rollout이 있으면 기존 검증 결과를 따른다. 파일 손상·만료·중복·조회 실패를 fresh로 바꾸지 않는다. IPC·설정 스키마·업데이트 barrier의 계약은 유지한다.

## Alternatives Considered

- 모든 session-loop 기록으로 차단: 질문 없는 설정 변경도 영구 차단하는 실측 반례가 있다.
- 알려진 질문 operation만 차단: 새 operation이나 잘린 기록을 입력 부재로 오인할 수 있어 기각한다.
- ThreadSettings 부분 문자열 검색: 질문 본문에 인용된 문자열이 보호 판정을 우회하므로 기각한다.
- 이전 session ID 재사용·체크포인트 우회: 현재 대화와 복원점의 일치를 보장하지 못하므로 기각한다.

## Consequences

모델 설정만 바꾼 빈 대화도 기존 fresh 복원 경로를 사용할 수 있다. Codex 내부 진단 형식에 대한 의존은 남으므로 미확인 형식은 보수적으로 차단한다. 새 operation을 예외에 넣을 때는 턴을 시작하지 않는 공식 의미와 실제 진단을 다시 확인한다. native·WSL의 설정 변경 전후 및 첫 질문 후 동작, 인용·유사 operation·중단·resume·rollout 장애 회귀와 dev critical checkpoint를 검증한다.
