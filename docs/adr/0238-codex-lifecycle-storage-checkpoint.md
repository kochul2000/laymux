# 0238. Codex 복원점은 프로세스별 대화 전환 기록으로 선택한다

- Status: Proposed
- Date: 2026-09-07
- Source: 사용자 요구(훅 설정 없이 빈 대화 복원), dev Windows·WSL Codex 0.153.4 실측, architecture/data-flow.md §13.5
- Amends: ADR-0118·0120의 Codex 후보 선택, ADR-0222·0232의 결론적 체크포인트 상태

## Context

clear 뒤 이전 rollout FD가 유지되며 제목 생성도 최신 로그를 남긴다. 따라서 열린 파일 집합과 마지막 활동은 현재 선택된 대화를 뜻하지 않는다. 실측에서 질문 전 thread/start 및 기존 대화 재선택 thread/resume의 TUI 진단 span에 정확한 ID가 있었다. 빈 대화는 영속 rollout이 없을 수 있으며 has_user_event=0은 실제 질문이 있는 대화에서도 관측됐다.

## Decision

Codex는 정확한 프로세스의 SQLite 진단에 기록된 TUI 대화 전환으로 현재 ID를 선택하고, 새 대화임이 확인된 미영속 상태는 명시적 fresh 복원점으로 저장한다.

- 기존 pane→PID 귀속, process incarnation, generation 검사와 이중 안정 관측을 유지한다. CWD·최신 파일·파일 부재 단독 추측과 훅 강제 설정은 금지한다.
- 제목 생성용 temporary-structured 요청은 제외한다. 일반 메시지에 인용된 span은 증거가 아니다. 전환 증거가 있지만 ID가 미확정이면 이전 ID로 후퇴하지 않는다.
- 새 thread/start의 ID를 확인하고 해당 ID의 턴 입력 기록 및 rollout이 없을 때만 fresh를 인정한다. resume나 조회 실패를 fresh로 바꾸지 않는다.
- fresh 상태는 provider와 관측 ID를 이중 관측 fingerprint에 포함한다. 영속 pane에는 lastAgentFresh=codex를 저장하고 이전 provider ID는 삭제한다. 다음 생성 시 설정된 Codex 명령을 resume 없이 실행한다. 설정된 명령과 정확히 같은 문자열만 backend에서 허용한다.
- Windows native는 기존 rusqlite를, WSL은 해당 distro에서 이미 설치된 python3의 sqlite3 모듈을 읽기 전용으로 사용한다. 사용자 설정·패키지 설치는 하지 않는다. Python 부재·DB 잠금·불완전 응답은 Unknown이며 FD 부재로 우회하지 않는다.

## Alternatives Considered

- 훅: 사용자 설정과 신뢰 승인을 요구하므로 기각.
- 최신 로그·FD 한 개: 백그라운드 및 clear의 실측 반례로 기각.
- has_user_event: 실제 대화에서 0인 반례로 기각.
- WSL DB를 UNC로 열기: Linux SQLite 잠금과 호환되지 않는 실측 때문에 기각.

## Consequences

새 IPC 상태와 pane 복원 필드가 추가된다. 마이그레이션은 없다. Codex 내부 진단 형식에 의존하므로 형식 변화는 보수적으로 실패하며 새 버전은 회귀 검증해야 한다. WSL Python 부재 환경은 저장소 조회 지원이 제한된다. 기록 지연과 provider 자율 변화에 대한 보장은 기존 ADR-0222의 관측 경계까지만 유지한다. 저장·시작·native/WSL 실기 검증이 필수다.
