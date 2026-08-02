# 0117. Codex CLI 세션을 CWD 기반으로 복원한다

- Status: Accepted
- Date: 2026-08-02
- Source: 사용자 요구, issue #734, [architecture/api-contracts.md §10 Codex 설정](../architecture/api-contracts.md#codex-설정), [architecture/data-flow.md §13](../architecture/data-flow.md#13-session-persistence--cache), [ADR-0031](0031-extension-viewer-profile-path-conversion.md)의 startup override 경계 확장

## Context

laymux는 Claude Code pane의 세션 ID를 종료 시 저장하고 다음 앱 시작에서 `claude --resume <id>`로 복원한다. Codex CLI도 `codex resume <SESSION_ID>`를 지원하고 로컬 rollout에 세션 ID와 CWD를 기록하지만, 현재 Codex 설정에는 상태 메시지 옵션만 있어 같은 재시작 연속성을 제공하지 못한다.

Claude의 세션 파일은 PID를 기록하므로 PTY 프로세스 트리와 직접 연결할 수 있다. Codex rollout의 `session_meta`에는 PTY PID나 laymux pane ID가 없고, 같은 CWD에서 실행된 최상위 대화와 subagent 대화가 함께 기록될 수 있다. 상태 루트도 기본 `~/.codex`와 `CODEX_HOME` 두 형태를 지원해야 한다.

범위는 실행 중이던 최상위 Codex 대화의 자동 복원과 그 설정 UI이다. Codex의 shell mode는 부모 TUI의 CWD를 바꾸는 계약이 아니므로 Claude의 `syncCwd: "command"`를 복제하지 않는다. Claude 고유 세션 리미트 문구를 파싱하는 자동 복귀도 안정적인 Codex 출력 계약이 확인되기 전에는 확장하지 않는다.

## Decision

Codex 세션 복원은 `codex.restoreSession`(기본 `true`)과 `codex.sessionMaxAgeHours`(기본 `24`, `0`은 필터 해제)로 제어하고, 종료 시 알려진 Codex terminal의 현재 CWD와 `CODEX_HOME/sessions/**/rollout-*.jsonl`을 비교해 동일 CWD의 최신 최상위 rollout ID를 `lastCodexSession`으로 영속한다.

rollout 탐색은 다음 불변식을 따른다.

- laymux host process의 `CODEX_HOME`이 있으면 그 디렉터리를 우선하고, 없으면 host OS 사용자 홈의 `.codex`, 마지막으로 상대 `.codex`를 사용한다.
- 날짜 디렉터리 `sessions/YYYY/MM/DD`까지만 순회하고 `rollout-*.jsonl`만 읽는다.
- 각 파일은 첫 `session_meta` 행만 256 KiB 상한으로 읽는다. 전체 대화 기록은 읽지 않는다.
- `payload.source.subagent`, non-null `parent_thread_id`, 또는 `thread_source: "subagent"`가 있는 subagent rollout과 `source: "exec"`인 비대화형 rollout은 자동 복원 후보에서 제외한다.
- 최대 나이를 설정하면 cutoff 이전 `YYYY/MM/DD` 디렉터리는 파일을 열거하기 전에 제외하고, `restoreSession`을 끄면 rollout 수집을 생략하며 저장된 Codex ID도 제거한다.
- 최대 나이는 파일 수정 시각의 nanosecond 정밀도로 판정한다. 같은 CWD에서는 수정 시각이 가장 최신인 후보를 선택하고, 시각이 같으면 session ID 사전순으로 결정해 파일시스템 열거 순서에 의존하지 않는다.

다음 시작에서 TerminalView는 영숫자로 시작하고 이후 영숫자·하이픈·밑줄만 포함하는 ID를 `codex resume <id>`로 변환한다. Rust도 `claude --resume <id>`와 `codex resume <id>` 두 정확한 형태만 비구조화 `startupCommandOverride`로 허용한다. 사용자가 실행한 Restart View는 기존 Claude 복원과 같이 새 세션으로 시작한다.

한 pane의 저장된 agent session ID는 상호배타적이다. 새 Codex ID를 얻으면 stale `lastClaudeSession`을 제거하고, 새 Claude ID를 얻으면 stale `lastCodexSession`을 제거한다. backend tracker도 같은 상호배타 원칙을 유지한다.

## Alternatives Considered

- Claude와 같은 PID tree 매칭: Codex rollout에는 PID가 없어 신뢰할 수 있는 연결 키가 없다.
- `codex resume --last` 사용: 같은 CWD와 최대 나이 정책을 보장하지 못하고, 여러 pane의 독립 복원에도 부적합하다.
- subagent rollout도 최신 후보로 허용: 부모 대화보다 늦게 기록되는 subagent를 잘못 복원할 수 있다.
- 세션 선택기를 항상 표시: 자동 복원 요구와 맞지 않고 앱 시작을 사용자 입력으로 막는다.
- Codex에 종료 훅이나 별도 IPC를 주입: 로컬에 이미 기록되는 rollout보다 침습적이며 Codex 실행 계약에 결합된다.

## Consequences

Codex pane도 앱 재시작 뒤 대화를 이어갈 수 있고 사용자는 복원 여부와 유효 기간을 Settings에서 제어한다. subagent와 명령 옵션을 세션 ID로 오인하는 경로를 차단하며, settings metadata는 상태 메시지 필드에는 `live`, 복원 필드에는 `nextUse`를 개별 보고한다.

startup override의 공통 세션 ID 검증은 첫 문자를 영숫자로 제한하므로 기존 Claude 경로에서도 `_`나 `-`로 시작하는 값은 더 이상 허용하지 않는다. 실제 Claude/Codex UUID에는 영향이 없고, CLI 옵션을 세션 ID로 오인하지 않는 안전 경계를 우선한다.

동일 CWD에 최상위 Codex session이 여러 개면 가장 최신 rollout을 선택하므로 여러 pane이 같은 대화를 복원할 수 있다. 이는 Codex metadata에 pane/PID 연결 정보가 없는 현재 제약의 보수적 결과다.

native Windows/Linux의 host rollout은 지원하지만, Windows host의 laymux는 WSL 내부 `~/.codex`나 shell profile 안에서만 설정한 `CODEX_HOME`을 자동 탐색하지 않는다. WSL-isolated rollout 지원은 distro/profile과 세션 루트를 안전하게 연결하는 별도 계약이 필요하므로 후속 범위다. Codex rollout의 경로·`session_meta` 형식·최상위 대화 표식이 바뀌거나 안정적인 pane 연결 키가 제공되면 이 결정을 재검토한다.
