# 0280. Codex app-server는 대화 프로세스 후보에서 제외한다

- Status: Accepted
- Date: 2026-09-29
- Source: 사용자 보고(셸 pane의 Codex 종료 확인 실패), dev 19281 재현, [data-flow §13.5](../architecture/data-flow.md)
- Extends: [ADR-0253](0253-wsl-claude-chrome-helper-role.md)의 WSL 보조 프로세스 역할 판정, [ADR-0009](0009-process-tree-interactive-app-liveness.md)의 native 후보 판정
- Related: [ADR-0278](0278-codex-status-current-screen.md), [ADR-0120](0120-wsl-agent-session-attribution.md), [ADR-0134](0134-wsl-guest-interactive-app-liveness.md)

## Context

Codex TUI와 `codex app-server`는 실행 파일 이름이 같다. 서버가 TUI 종료 후에도 pane의 `LX_TERMINAL_ID`를 상속한 채 살아 있으면 이름 기반 귀속과 liveness는 셸을 Codex 대화로 판정한다. 사용자 보고의 pane marker를 가진 서버 두 개를 실제 WSL에서 확인했다. 격리한 dev에서도 서버를 백그라운드로 실행한 셸에 종료 확인을 요청하면 입력창 검사 오류가 발생했다.

서버는 여러 TUI가 사용하는 서비스일 수 있어 현재 pane의 대화나 입력창을 나타내지 않는다. 서버 종료나 marker 변경으로 사용자 환경을 손대지 않고 관측하는 역할을 구분해야 한다. 후속 교차 플랫폼 검증에서 Windows PowerShell의 직접 자식으로 실행한 app-server도 같은 오탐을 재현했다. 범위는 native·WSL의 관측된 app-server 모드이며 모든 비대화 CLI 모드를 일반화하지 않는다.

## Decision

**Codex의 첫 실행 인자(`argv[1]`)가 정확히 `app-server`이면 native·WSL 세션 귀속과 liveness의 대화 후보에서 제외한다.**

- WSL의 두 소비자는 동일한 게스트 역할 검사 함수를 사용한다. 기존 Claude Chrome 호스트 판정도 유지한다.
- native는 OS snapshot의 Codex 후보 PID에만 command line을 조회하고, 동일한 프로세스 이름·부모 PID와 명시적 서버 역할이 확인되면 helper로 표시한다. 각 소비자가 따로 조회하지 않고 동일한 snapshot의 역할을 사용한다. 조회 불가·불일치는 기존 후보를 유지한다.
- NUL 인자 경계를 검사하며 개행·부분 문자열·옵션 값·프롬프트에서 역할을 추측하지 않는다. cmdline을 읽지 못하거나 모드를 알 수 없으면 후보를 유지한다.
- PID·PPID 행은 보존하고 helper 자격만 설정한다. helper가 root이거나 중간 조상이어도 자손 탐색을 계속한다. 실제 TUI의 선택과 복수 TUI의 모호성 판정은 유지한다.
- 서버의 열린 rollout 파일은 pane의 대화 증거가 아니므로 WSL 귀속 probe에서 서버 FD를 열거하지 않는다. 실제 TUI의 FD 수집은 유지한다.
- 서버만 남으면 대화 provider는 부재이며 `/status` 입력을 보내지 않는다. critical checkpoint도 같은 provider 부재를 사용한다. 세션 ID의 과거 값으로 서버를 대화로 보완하지 않는다.
- WSL argv 원문은 게스트 밖으로 반환하지 않고 native argv도 snapshot에 보관하거나 로그에 기록하지 않는다. 서버·사용자 설정·rollout을 변경하지 않으며 기존 distro·기한·generation 검증을 유지한다.

## Alternatives Considered

- 입력창이 없으면 `/status`만 건너뛰기: liveness와 최종 세션 귀속에 잘못된 Codex가 남아 다른 종료 단계가 계속 실패하므로 기각한다.
- 서버 종료 또는 marker 제거: 공유 서비스와 사용자 프로세스를 변경하므로 기각한다.
- rollout 존재나 CWD로 TUI 추정: 서버도 대화 저장소를 사용하고 실제 TUI의 초기화 중 부재도 가능하므로 역할 증거가 아니다.
- 모든 Codex 서브명령·전역 옵션 파싱: 이번 실행 증거를 넘는 CLI 문법 의존성을 도입하므로 명시적으로 관측된 첫 인자만 처리한다.

## Consequences

서버가 남은 셸은 종료 확인에서 제외되고 실제 대화는 계속 보호된다. Codex 후보마다 cmdline 조회가 추가되며 알려지지 않은 실행 형식은 보수적인 오탐을 유지할 수 있다. native의 표시 경로는 기존 snapshot TTL을 그대로 사용하고 critical 조회는 fresh snapshot을 사용한다. 프로덕션 shell probe의 역할·인자 경계 테스트, Rust 후보 선택 테스트, Windows·WSL dev의 서버 단독·TUI 공존·TUI 종료 후 checkpoint를 검증한다. 새 서버 실행 형식은 별도 실측 후 범위를 재검토한다.
