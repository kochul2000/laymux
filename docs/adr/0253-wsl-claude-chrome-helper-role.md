# 0253. WSL Claude의 Chrome 호스트는 대화 프로세스 후보에서 제외한다

- Status: Proposed
- Date: 2026-09-17
- Source: v1.0.4 사용자 보고(`terminal-pane-54e49f2e: activeButUnidentified`), [data-flow.md §9·§13](../architecture/data-flow.md), [재현 기록](../wsl-claude-chrome-helper-repro.md)
- Extends: [ADR-0120](0120-wsl-agent-session-attribution.md)의 WSL provider 프로세스 선택, [ADR-0134](0134-wsl-guest-interactive-app-liveness.md)의 게스트 liveness 후보 판정
- Related: [ADR-0222](0222-agent-session-checkpoint-coordinator.md)의 정확한 귀속 체크포인트

## Context

Claude Code의 대화 프로세스와 `claude --chrome-native-host` 브라우저 보조 프로세스는 같은 실행 파일 이름을 사용한다. 브라우저가 pane의 `LX_TERMINAL_ID`를 상속하고 원래 agent 계보 밖으로 재배치되면, 브라우저가 실행한 보조 프로세스도 대화와 같은 깊이에 놓일 수 있다. 이름·marker·깊이만 보는 귀속은 이를 대화 두 개로 판정하여 정상 PID 세션 파일을 읽기 전에 포기한다. 반면 liveness는 같은 이름의 프로세스가 살아 있다고 판정하므로 critical checkpoint가 `activeButUnidentified`로 계속 막힌다.

실제 실패 pane에서는 정상 대화 PID의 세션 파일이 존재했고, Chrome 호스트 PID에는 대화 세션 파일이 없었다. 파일 존재 여부로 후보를 고르면 아직 세션 파일이 준비되지 않은 진짜 두 번째 대화를 숨길 수 있다. 프로세스가 명시한 실행 역할로만 대화 후보를 구분해야 한다.

범위는 Windows laymux가 WSL `/proc`로 관측하는 Claude Chrome 호스트다. native Windows의 command-line 열거, 다른 helper 실행 모드, provider 세션 형식·age 정책은 이 결정에 포함하지 않는다.

## Decision

**WSL의 Claude 프로세스에서 첫 실행 인자(`argv[1]`)가 정확히 `--chrome-native-host`임을 읽어 증명하면 대화 후보에서 제외한다.**

- 세션 귀속과 liveness는 동일한 게스트 역할 판정을 사용한다. 실행 파일 이름과 NUL로 구분된 argv의 경계를 함께 검사하며, 전체 command line의 부분 문자열이나 CWD·세션 파일 부재로 역할을 추정하지 않는다.
- 보조 프로세스도 세션 귀속의 PID·PPID 관계에는 남긴다. 후보 자격만 제거하여 자손의 깊이 계산을 보존한다.
- 명시적으로 증명된 Chrome 호스트만 남으면 대화 provider는 부재다. 같은 최상위 깊이에 실제 대화가 여러 개면 기존 모호성 판정과 critical checkpoint 차단을 유지한다.
- argv를 읽지 못하거나 알려진 실행 모드와 일치하지 않으면 기존 후보 판정을 유지한다. 증거 부족을 helper라는 증거로 바꾸지 않는다.
- probe는 argv 내용을 host로 반환하거나 로그에 기록하지 않고 역할 여부만 전달한다. 사용자 프로세스·provider 설정·세션 파일에는 쓰지 않는다. 기존 distro·deadline·generation·ID 충돌 정책을 유지한다.

## Alternatives Considered

- **세션 파일이 있는 PID 우선**: 진짜 두 대화 중 하나가 초기화 중이거나 조회 실패하면 잘못된 단일 귀속을 확정하므로 기각한다.
- **Chrome 자손 또는 `.claude/chrome` CWD 제외**: 실제 대화의 실행 경로와 CWD를 제한하고 역할을 증명하지 못하므로 기각한다.
- **marker 제거·helper 종료**: 사용자 프로세스를 변경하고 다음 Chrome 실행에서 재발하므로 기각한다.
- **checkpoint를 우회하거나 저장된 ID 재사용**: 정확한 현재 대화 복원이라는 ADR-0222의 불변식을 깨므로 기각한다.
- **모든 플랫폼·모든 helper 모드에 대한 command-line 수집**: Windows 열거 비용과 실패 정책까지 확장해야 하며 이번 실측 증거를 넘는다. 관측된 WSL 실행 모드부터 한정해 수정한다.

## Consequences

- Chrome 보조 프로세스가 대화 세션 식별과 종료 판정을 가로막지 않는다. 역할 확인은 Claude 후보에만 추가 `/proc/<pid>/cmdline` 읽기 비용을 낸다.
- argv 경계, 동일 깊이·더 얕은 helper, helper 단독, 실제 두 대화, 읽기 실패, helper를 경유하는 자손을 실제 shell probe와 Rust 선택기로 회귀 검증한다. 원래 pane은 읽기 전용 adapter로 수정 전 실패와 수정 후 정확 ID를 대조한다.
- 다른 Claude 실행 모드나 native Windows의 동일 문제를 모두 해결하는 결정은 아니다. 새로운 실패에서는 구체적인 provider·PID·역할·세션 증거를 확보하고 범위를 확장한다.
