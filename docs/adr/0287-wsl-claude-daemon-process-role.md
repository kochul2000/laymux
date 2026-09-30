# 0287. WSL Claude daemon은 대화 프로세스 후보에서 제외한다

- Status: Proposed
- Date: 2026-09-30
- Source: 사용자 보고(`lx:pane:ai-inference:2`, 화면 클리어 후 실행 중 Codex가 shell로 표시), 해당 pane 읽기 전용 `/proc` 검사, Claude Code `daemon --help`, [data-flow §9](../architecture/data-flow.md)
- Extends: [ADR-0253](0253-wsl-claude-chrome-helper-role.md), [ADR-0280](0280-codex-app-server-process-role.md)의 명시적 보조 역할 검사
- Related: [ADR-0284](0284-codex-title-hook-binding.md)

## Context

WSL Codex TUI가 살아 있는 pane에서 같은 marker를 상속한 `claude daemon`이 더 얕은 조상 깊이로 남았다. daemon의 stdin/stdout은 `/dev/null`이고 Codex는 실제 PTY에서 실행 중이었다. 기존 게스트 프로브는 daemon을 대화 Claude로 세어 Codex liveness와 정확한 훅 연결을 거부했다. 화면 클리어 뒤에도 제목과 Codex 화면은 유지됐지만 표시 상태는 shell이었다.

`claude daemon --help`는 이 모드를 대화 TUI가 아닌 background supervisor의 lifecycle 명령으로 설명한다. 사용자 daemon을 종료하거나 marker를 바꾸지 않고 관측 역할만 바로잡아야 한다. 이번 범위는 실측한 WSL 실행 형식이다. native 역할 판정이나 미관측 Claude 모드를 일반화하지 않는다.

## Decision

**WSL Claude의 첫 실행 인자(`argv[1]`)가 정확히 `daemon`이면 liveness와 세션 귀속의 대화 후보에서 제외한다.**

- 두 소비자는 기존 공통 게스트 역할 검사를 사용한다. Chrome 호스트와 Codex app-server의 기존 역할은 유지한다.
- NUL 인자 경계를 검사하고 개행·부분 문자열·옵션 값·프롬프트에서는 역할을 추정하지 않는다. cmdline 조회 실패나 알 수 없는 모드는 기존 후보를 유지한다.
- helper의 PID·PPID 행과 자손 탐색은 보존한다. 실제 대화의 선택과 복수 대화의 모호성 판정은 유지한다. daemon만 남으면 대화 실행의 근거로 쓰지 않는다.
- argv 원문은 게스트 밖으로 반환하거나 프로덕션 로그에 저장하지 않는다. 사용자 프로세스·설정·세션 파일을 변경하지 않는다. 기존 배포판·deadline·generation·정확한 ID 검증과 훅 선택 계약을 유지한다.

## Alternatives Considered

- 제목의 Codex 문자열이나 훅 pane ID를 우선하기: 남은 프로세스의 오탐을 숨기며 제목·과거 환경만으로 현재 대화를 확정하게 된다.
- daemon 종료·marker 변경: 다른 대화가 사용하는 서비스에 영향을 주며 다음 실행에서 재발한다.
- `/dev/null`·CWD·세션 파일 부재로 helper 추정: 실제 대화의 초기화·리다이렉션·접근 실패와 구분하지 못한다.
- 모든 플랫폼·서브명령 파싱: 이번 실측 범위를 넘는 실행 비용과 CLI 문법 의존성을 도입한다.

## Consequences

WSL daemon이 실행 중인 Codex·Claude를 가리거나 셸을 대화로 유지하지 않는다. Claude 후보마다 알려진 모드 확인 비용이 추가된다. 프로덕션 shell probe로 daemon 단독·TUI 공존·자손 보존·인자 경계·조회 실패를 회귀 검증하고 dev에서 실제 Codex의 클리어와 셸 복귀를 확인한다. 새로운 실행 모드나 native의 동일 문제가 관측되면 별도 증거로 범위를 재검토한다. 기존 표시·귀속 오류 수정이므로 버전 영향은 patch다.
