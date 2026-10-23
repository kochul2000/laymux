# 0354. 워크스페이스 닫기는 호스트가 소유하는 복원 유예 후 확정한다

- Status: Proposed
- Date: 2026-10-23
- Source: 사용자 요구(PC·모바일 닫기 토스트와 즉시 복원), architecture/overview.md §3.2, architecture/api-contracts.md §13, ADR-0322
- 관계: ADR-0322의 Remote workspace 닫기 시점과 ADR-0211·ADR-0333의 workspace 닫기 사전 확인을 정정한다. pane 닫기는 유지한다.

## Context

워크스페이스를 즉시 제거하면 터미널도 언마운트되어 실행 중인 작업을 되돌릴 수 없다. PC와 모바일에서 닫기를 실행한 직후 복원할 기회를 제공해야 한다. 모바일 연결 종료나 화면 이동이 실제 종료 시점을 소유해서는 안 된다.

## Decision

사용자의 워크스페이스 닫기는 호스트의 5초 복원 유예를 거친 후 기존 제거 경로로 확정한다.

- 호스트 workspace store의 일시적인 pendingWorkspaceCloses가 대기 상태의 정본이다. 호스트 타이머가 각 요청을 독립적으로 확정하며 화면 컴포넌트의 수명과 무관하다.
- PC·Remote의 workspace 닫기는 한 번 누르면 즉시 유예를 시작한다. 사전 두 번 확인 대신 토스트의 복원으로 실수를 되돌린다. 다른 파괴적 작업의 확인 설정은 기존대로 따른다.
- 대기 중 workspace·pane ID·터미널·오버라이드·작업은 유지한다. 선택 목록과 이동 후보에서는 제외하고 활성 workspace를 닫을 때는 남은 표시 workspace로 착지한다. 마지막 표시 workspace는 닫기 대기에 넣지 않는다.
- PC는 WorkspaceSelectorView 하단에서 기존 숨김 복원 토스트와 같은 위치·모양으로 닫기 토스트를 표시한다. 숨김·닫기 토스트는 같은 스택에 쌓아 겹치지 않는다. Remote는 화면 하단 가로 토스트를 사용한다. 두 표면은 같은 만료 시각과 대기 목록을 표시한다. 복원은 대기만 취소하며 활성 workspace를 강제로 바꾸지 않는다. 여러 닫기 요청은 각각 토스트를 갖는다.
- Remote close는 기존 lease gate 아래 대기 요청을 수행하고, 동일 gate의 restore-close는 취소한다. navigation에는 pendingWorkspaceCloses를 추가하고 대기 workspace는 목록에서 제외한다. Automation의 명시적인 즉시 삭제 workspaces.remove는 유지한다.
- 대기 상태는 디스크에 저장하지 않는다. 유예 중 호스트 재시작은 아직 제거하지 않은 workspace를 복원한다. 유예 만료 시 기존 제거와 언마운트 정리 경로를 사용한다.

## Alternatives Considered

- 삭제 후 구성만 재생성: 프로세스와 출력·입력 상태를 복원할 수 없다.
- 각 클라이언트가 종료 타이머 소유: 모바일 연결 종료·백그라운드 타이머 제한에 따라 실제 종료가 누락된다.
- 기존 숨김 상태 재사용: 숨김 자동 종료와 영속 상태에 닫기 유예를 섞어 복원 중 터미널 보존을 보장하기 어렵다.

## Consequences

실수로 닫아도 실행 중 작업을 그대로 복원할 수 있다. 유예 동안 자원을 유지하는 비용과 대기 상태를 이동 후보에서 제외하는 책임이 생긴다. 타이머·중복 요청·복원 경쟁·마지막 workspace 보호·모바일 lease와 navigation 갱신을 검증한다. 웹뷰 재시작 시 닫기 요청까지 재개해야 한다면 영속 정책을 다시 결정한다.
