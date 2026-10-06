# 0294. 훅 우선 종료 확인은 정확한 프로세스 대화 귀속도 증거로 사용한다

- Status: Accepted
- Date: 2026-10-06
- Source: 사용자 Windows Codex `/status` 재실행 제보, [ADR-0292](0292-codex-hook-lifecycle-session-proof.md), [ADR-0222](0222-agent-session-checkpoint-coordinator.md), architecture/api-contracts.md, [Codex 0.160 hook runtime](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/hook_runtime.rs)
- 관계: ADR-0292의 종료 증거를 확장한다. 제목 기반 훅 연결의 기존 조건은 유지한다.

## Context

Codex는 `SessionStart`를 다음 요청에서 실행한다. 실제 Windows TUI에서 작업 완료 후에는 훅으로 종료 ID를 확인하지만, 같은 대화를 `resume`한 직후에는 다음 요청 전까지 새 훅이 없어서 `/status`를 실행한다. 앱 재시작으로 훅 레지스트리가 비어도 같은 문제가 생긴다. 이때 프로세스별 진단과 최상위 rollout은 이미 현재 대화를 정확히 식별한다. 제목 기반 공유 서버 연결과 프로세스별 정확 귀속은 서로 다른 증거다. 종료 입력을 줄이면서 대화 전환·PID 재사용·다른 저장소·subagent를 잘못 복원하지 않아야 한다. 일반 작업 상태 감지와 휴리스틱 모드의 정책은 이번 범위가 아니다.

## Decision

**훅 우선 모드의 종료 checkpoint는 활성 훅 설치와 현재 프로세스의 정확한 대화 귀속을 함께 검증하면 새 훅 수신 전에도 `/status`를 생략한다.**

- 실제 Codex PID·생성 시각·배포판·저장소·PTY generation은 기존 프로세스 선택 경로로 검증한다. 현재 프로세스의 진단이 유일한 전체 UUID를 선택하고 해당 저장소의 최상위 rollout/Fresh 검증을 통과해야 한다. argv의 resume ID, 저장된 마지막 ID, CWD, 가장 최근 파일, 과거 pane 표시를 대체 증거로 사용하지 않는다.
- 그 저장소의 훅 설치가 활성이고 오류 없이 확인되어야 한다. 프로세스 귀속은 제목 설정이나 새 훅 이벤트를 요구하지 않는다. 현재 세대의 유효한 제목이 다른 ID를 가리키면 증거를 거부한다.
- I/O 후 현재 프로세스 대화 선택을 다시 조회한다. checkpoint 안에는 프로세스 기반과 제목 기반의 증거 종류를 보존하고, 저장용 조회마다 동일 종류로 다시 검증한다. 프로세스 증거는 현재 선택이 사라지면 제목 증거로 낮춰 유지하지 않는다. 제목 snapshot·generation·프로세스·설치·rollout과 중복 ID 및 이중 관측 검사를 유지한다.
- 제목 기반 훅 증거는 ADR-0292의 수신 대화 유일성·설정 루트·SessionEnd 거부·제목 설정 검증을 그대로 따른다. SessionEnd 후 다시 resume한 새 프로세스는 이전 종료 훅을 재활용하지 않고 현재 진단으로 증명한다.
- 두 증거를 확보하지 못하면 기존 `/status` fallback을 사용한다. 훅 설치 제거·비활성·읽기 실패 및 휴리스틱 모드에서의 기존 정책은 유지한다. Windows native와 Windows의 WSL을 같은 검증 계약으로 처리한다.

## Alternatives Considered

- 다음 프롬프트를 제출해 시작 훅을 강제로 받기: 사용자 대화와 입력을 변경하고 모델 요청이 발생한다.
- 마지막 훅이나 영속 ID를 그대로 사용하기: resume·대화 전환·PTY 교체 후 현재 프로세스 소유권을 증명하지 않는다.
- 제목만으로 전체 ID를 복원하기: 축약 ID와 공유 서버 충돌을 해결하지 못한다.
- 현재 진단이 확정한 ID도 항상 `/status`로 재확인하기: 입력 초안과 화면을 변경하며 복원 직후 같은 중복 확인을 반복한다.

## Consequences

작업 없이 복원 직후 종료해도 정확한 프로세스 귀속이 있으면 `/status`를 생략한다. 종료 시 진단을 한 번 더 읽는 비용과 증거 종류를 토큰에 보존하는 책임이 생긴다. shared server 등 프로세스 귀속이 불가능한 경우에는 기존 제목·훅 연결이나 `/status`가 계속 필요하다. 새 설정과 외부 payload 변경은 없다. native/WSL의 훅 미수신 resume, 제목 누락과 충돌, checkpoint 중 선택 변경·소실, 훅 제거와 기존 fallback을 검증한다. 프로세스 진단의 정확 귀속 계약이 바뀌면 이 결정을 재검토한다.
