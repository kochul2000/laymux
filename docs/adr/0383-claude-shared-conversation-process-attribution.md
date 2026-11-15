# 0383. Claude의 공유 대화는 서로 다른 live 프로세스에 귀속할 수 있다

- Status: Proposed
- Date: 2026-11-15
- Source: 사용자 종료 실패 보고(`activeButUnidentified`), 해당 두 WSL 프로세스의 PID 세션 파일, [data-flow §13](../architecture/data-flow.md), [ADR-0222](0222-agent-session-checkpoint-coordinator.md)
- 관계: [ADR-0120](0120-wsl-agent-session-attribution.md)·ADR-0222의 중복 거부를 Claude의 대화 ID 중복과 프로세스 소유권 충돌로 구분한다. Codex·Grok·미소비 복원 요청 정책은 유지한다.

## Context

Claude의 `-c`와 `--resume`은 서로 다른 프로세스에서 같은 대화를 열 수 있다. 사용자 pane의 두 live PID 파일이 같은 ID를 명시했지만, 기존 판정은 대화 ID가 pane마다 유일해야 한다고 가정하여 정확한 귀속을 모두 제거했다. 따라서 일반 저장은 복원 ID를 지우고 종료의 critical checkpoint는 실패했다. workspace 방문 여부는 증거가 아니며, 새 GUI에서 두 번째 PTY를 관측하게 되는 시점이 증상에 영향을 줄 수 있다.

## Decision

**Claude는 pane별 live 프로세스와 PID 파일이 직접 증명한 대화 ID를 보존하고, 같은 프로세스를 여러 pane이 소유한다고 주장할 때만 충돌로 거부한다.**

- 프로세스 키는 native PID 또는 WSL distribution과 guest PID다. 서로 다른 키의 동일 대화 ID는 허용한다. 한 키를 여러 pane이 선택하면 모두 미식별로 처리한다.
- PID 세션 파일의 이름과 본문 PID가 선택한 live PID와 일치해야 한다. 손상·누락·잘못된 ID·최상위 프로세스 모호성은 기존 실패 경로를 따른다. CWD·방문 여부·저장된 ID로 귀속을 추정하지 않는다.
- generation 확인, critical 이중 관측, 입력 fence와 저장 완료 조건은 유지한다. API와 영속 스키마를 추가하지 않는다. native·WSL에 같은 원칙을 적용한다.
- 실행 상태와 transcript config root는 terminal별로 소유하여 같은 대화 ID의 다른 프로세스 상태·저장소가 서로 덮이지 않게 한다.
- 공유 대화의 동시 편집 충돌 해결 및 다른 provider의 귀속 정책 변경은 범위 밖이다.

## Alternatives Considered

- 중복 대화를 무조건 거부: 정확한 현재 대화를 아는데도 정상 종료를 차단하고 복원 연결을 잃는다.
- 최신 PID 하나만 선택: 다른 pane의 정확한 복원점을 임의로 버린다.
- 모든 중복 검사를 제거: 중첩 프로세스 트리 등에서 하나의 프로세스를 두 pane에 귀속하는 오류를 놓친다.
- 미방문 workspace 제외: 실제 실행 중인 작업의 저장 보호를 우회한다.

## Consequences

정확한 PID 증거가 있는 공유 대화는 양쪽 pane에 저장된다. 복원 이후에도 같은 대화를 열 수 있으며 이는 현재 실행 상태를 보존하는 결과다. process-key 충돌과 PID 파일 불일치 회귀를 보강하고 dev에서 renderer 없는 미방문 pane·재기동·방문 전후·실제 종료 저장을 검증한다. provider가 PID 파일 의미를 변경하면 직접 귀속 계약을 재검토한다. 설정 마이그레이션은 없다.
