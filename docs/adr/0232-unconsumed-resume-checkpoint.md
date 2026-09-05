# 0232. 입력 전 복원 요청은 generation에 결부된 복원점으로 보존한다

- Status: Proposed
- Date: 2026-09-05
- Source: 사용자 보고(미진입 pane의 업데이트 `activeButUnidentified` 실패), 이전 세션 보존 요구, architecture/data-flow.md §13, ADR-0222
- Amends: ADR-0222의 startup 대기와 파괴 전 checkpoint 허용 판정

## Context

Remote의 pane 선택도 desktop workspace를 활성화한다. 따라서 직접 선택하지 않은 형제 pane의 PTY도 시작될 수 있다. PTY 생성과 provider의 세션 파일 준비는 별개이며 15초가 지났다는 사실은 기존 복원점이 무효라는 증거가 아니다. 현재 일반 저장은 실행 중이지만 식별되지 않은 pane의 이전 ID를 삭제하고, critical 저장은 실패한다.

## Decision

검증된 명시적 resume 요청을 실행한 PTY는 첫 비프로토콜 입력 또는 정확한 귀속 관측 전까지 그 요청의 provider와 ID를 generation-local 복원점으로 보존한다.

- Rust의 PTY handle이 복원 요청과 일방향 소비 상태를 소유한다. 프론트 방문·포커스·시간은 증거로 사용하지 않는다.
- 건강한 `NoAgent`, 또는 정확히 선택된 WSL Codex process에 rollout FD가 없다는 추가 증거가 있는 동일 provider의 `ActiveButUnidentified` 관측에만 `RestorePending(provider, sessionId)`를 반환한다. 단순한 미식별 결과는 파일 미생성의 증거가 아니다. native와 다른 provider의 실행 중 미식별 상태는 이번 범위에서 예외를 적용하지 않는다. 이는 현재 세션의 정확한 식별이 아니라, 아직 소비하지 않은 기존 복원 요청을 유지하는 판정이다.
- 첫 일반 입력은 enqueue 전에 복원점 사용을 영구 중단한다. Local·Remote·Automation·MCP·sync CWD 모두 같은 PTY 쓰기 경로를 따른다. 실패하거나 일부만 전송된 입력도 보수적으로 소비한 것으로 본다. 별도 protocol-reply 경로와 resize는 소비하지 않는다.
- 정확한 귀속 또는 다른 provider/복수 provider 관측도 기존 요청을 소비한다. 이후 미식별 상태로 돌아가도 이전 요청으로 후퇴하지 않는다. 조회 실패는 우회하지 않는다.
- materialized 후보의 검증 실패·중복·모호한 process 선택은 missing-rollout 증거를 만들지 않는다. 최종 snapshot에서 다른 pane의 정확한 ID 또는 pending ID와 같은 provider/ID를 주장하는 pending 복원점도 거부하고 소비한다. 정확히 식별된 다른 pane의 판정은 유지한다.
- `RestorePending`은 일반 저장에서 해당 요청 ID를 유지한다. 기존 finalization fence와 generation/provider/ID 이중 안정 관측을 만족하면 update·eviction도 허용한다.
- 신규 CLI, profile startup, viewer, 명시적 fresh restart에는 이 증거가 없다. 저장된 ID 또는 세션 파일 부재만으로 예외를 만들지 않는다. 다른 프로세스의 CWD·최신 파일을 추측하지 않는다.

## Alternatives Considered

- 미방문 workspace/pane을 coverage에서 제외: Remote와 형제 pane startup 및 실제 입력을 놓친다.
- 모든 미식별 pane의 이전 ID로 업데이트 허용: 새 작업을 이전 세션으로 덮을 수 있다.
- grace 연장: 수시간 대기나 느린 startup을 해결하지 못한다.
- 별도 복원점 DB: 기존 settings와 PTY generation으로 충분하다.

## Consequences

IPC 판정 하나가 추가된다. 기존 파일 스키마와 마이그레이션은 바뀌지 않는다. 입력이 없는 명시적 복원에만 적용하므로 신규 CLI의 영속 파일 미생성은 계속 업데이트를 차단한다. provider가 입력 없이 다른 세션으로 자율 전환하는 경우는 기존 이중 관측의 잔여 race와 함께 별도 quiescence 계약이 필요하다. 단위 테스트와 isolated dev의 실제 PTY/IPC 경로에서 입력 전 허용·입력 후 거부·generation 교체를 검증한다.
