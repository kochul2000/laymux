# 0119. WSL agent 세션은 terminal 환경 marker와 Linux PID로 귀속한다

- Status: Proposed
- Date: 2026-08-02
- Source: 사용자 후속 요구, PR #739 실기 검증, [architecture/data-flow.md §13](../architecture/data-flow.md#13-session-persistence--cache), [ADR-0118](0118-codex-session-pid-attribution.md) 확장
- Extends: [ADR-0118](0118-codex-session-pid-attribution.md)

## Context

ADR-0118은 native host에서 PTY 자식 process tree와 provider 저장소가 함께 증명한 session ID만 pane에 귀속한다. Windows laymux의 WSL profile에서는 host process tree가 `wsl.exe`까지만 보이고 실제 Claude/Codex는 WSL VM의 별도 Linux PID namespace에서 실행된다. provider 상태도 Windows 홈이 아니라 해당 distro의 Linux 홈에 있으므로 native 경로는 세션이 실제로 존재해도 `null` 귀속으로 끝난다.

laymux는 WSL bash rcfile에 pane별 `LX_TERMINAL_ID`를 이미 주입하며 agent와 모든 자식이 이를 상속한다. WSL의 `/proc/<pid>/environ`과 `/proc/<pid>/status`는 이 marker, provider PID, 부모 관계, `HOME`과 `CODEX_HOME`을 함께 제공한다. 또한 `/proc/<pid>/fd`는 현재 Codex process가 열고 있는 rollout을 그 Linux PID에 직접 묶어 준다. Windows는 `\\wsl.localhost\<distro>`를 통해 Claude session 파일과 Codex rollout header를 read-only로 열 수 있다. 이 경계를 결합하면 CWD나 시작 시각을 추정하지 않고 WSL pane과 provider session을 연결할 수 있다.

실기에서 Windows `rusqlite`로 `\\wsl.localhost\...\logs_2.sqlite`를 open하는 것은 성공했지만, WSL Codex가 WAL DB를 사용하는 동안 query는 `SQLITE_BUSY (database is locked)`로 실패했다. 즉 UNC를 통한 live SQLite lock 공유는 저장 시점 귀속의 기반이 될 수 없다.

범위는 Windows host에서 로컬 WSL profile로 직접 실행한 Claude Code와 Codex CLI다. Direct SSH, container 내부의 추가 PID namespace, 임의 shell wrapper가 marker를 지우는 경우는 비목표다.

## Decision

Windows host의 WSL agent session 귀속 SoT는 **정확한 distro 안에서 `LX_TERMINAL_ID`를 상속한 Linux provider PID와 그 PID가 가리키는 provider 저장소**다.

- WSL terminal의 distro는 해당 `TerminalSession.wsl_distro`, profile command line의 `-d`/`--distribution`, bare WSL의 default distro 순서로 해당 pane에서만 결정한다. 명시 값이 잘못됐으면 bare WSL로 재해석하지 않고 fail-closed하며, 다른 pane의 distro를 빌리지 않는다.
- Rust는 `crate::process::headless_command()`와 bounded timeout으로 `wsl.exe -d <distro> --exec sh` read-only probe를 실행한다. terminal ID나 distro를 shell 문자열에 보간하지 않고 argv로 전달한다. default-distro 조회와 모든 distro probe는 하나의 3초 deadline을 공유해 종료 저장의 5초 기본 예산 안에 끝낸다.
- probe는 `/proc`에서 `LX_TERMINAL_ID`가 있는 process의 PID·PPID·실행 이름·`HOME`·`CODEX_HOME`과 open rollout FD symlink만 반환한다. provider 이름과 ancestry로 전체 Claude/Codex 후보 중 하나의 top-level agent PID를 증명하며, provider별로 각각 최상위를 고르지 않는다. 같은 깊이의 후보가 여럿이면 fail-closed한다.
- Claude는 WSL PID와 `<HOME>/.claude/sessions/<pid>.json`을 직접 연결한다. Codex는 선택된 PID의 FD 중 해당 process `CODEX_HOME/sessions` 아래 rollout만 Windows-accessible 경로로 변환한다. rollout header의 ID·CWD·source를 검증하고 subagent·exec를 제외한 top-level ID가 하나일 때만 귀속한다.
- provider process는 확인됐지만 distro, session 파일 또는 rollout 검증이 실패하면 해당 terminal을 `null` 귀속으로 반환해 stale session ID를 제거한다. CWD·최신 파일·다른 distro fallback은 사용하지 않는다.
- native와 WSL 결과를 모두 합친 뒤 동일 session ID가 둘 이상의 terminal에 귀속되면 충돌한 terminal을 전부 `null`로 바꾼다. host 경계를 넘어서도 session 하나는 pane 하나에만 귀속된다.
- native Windows/Linux 귀속 경로와 startup resume 명령 계약은 바꾸지 않는다. WSL에서도 저장된 명령은 기존 rcfile startup 경계 안에서 `claude --resume <id>` 또는 `codex resume <id>`로 실행한다.

## Alternatives Considered

- Windows `wsl.exe` PID와 Linux PID를 시작 시각이나 순서로 대응: 두 namespace 사이에 안정된 공개 parent 관계가 없고 동시 pane에서 뒤바뀔 수 있어 기각한다.
- WSL CWD별 최신 session을 배정: 동일 CWD pane을 구분하지 못해 ADR-0118의 정확 귀속 불변식을 다시 깨므로 기각한다.
- provider hook/설정을 강제 주입해 session ID를 host로 전송: 정확하지만 사용자 Claude/Codex 설정 소유권을 변경하고 기존 hook을 덮을 수 있어 기각한다.
- WSL 안에 별도 상주 daemon을 설치: 빠른 조회는 가능하지만 설치·업데이트·수명주기·보안 경계가 기능 규모보다 커서 기각한다.
- Windows에서 WSL live `logs_*.sqlite`를 Rust SQLite reader로 조회: 도구 추가가 없지만 UNC가 WAL lock을 공유하지 못해 실기에서 `SQLITE_BUSY`로 실패했으므로 기각한다.
- WSL 안의 `sqlite3`/Python/Node로 DB를 쿼리: 배포판별 도구 존재 여부에 의존하고 추가 executable contract을 만드므로 기각한다.
- PID의 open rollout FD를 사용: Linux kernel이 process→file 귀속을 제공하고 WSL 기본 userland만 필요하며 live DB lock이 없어 채택한다.

## Consequences

Windows laymux의 WSL Claude/Codex pane도 같은 CWD 여부와 무관하게 자신이 실제로 실행한 session으로 복원된다. 기존 terminal marker를 재사용하므로 provider 설정이나 session 파일 형식을 새로 변경하지 않는다.

대신 저장 snapshot 시 WSL distro마다 bounded helper process와 `/proc` scan 비용이 추가된다. WSL 또는 UNC filesystem이 응답하지 않으면 timeout 뒤 fail-closed하며 종료 저장이 무기한 멈추지 않는다. Codex가 current rollout FD를 더 이상 열어 두지 않도록 구현을 바꾸면 WSL Codex 귀속은 fail-closed하며 adapter를 재검토해야 한다. distro 이름·Linux path·probe 출력·FD rollout header를 Windows 실기 테스트로 검증한다. WSL이 provider PID/session을 공식적으로 직접 노출하는 API를 제공하면 `/proc` adapter를 교체할 수 있다.
