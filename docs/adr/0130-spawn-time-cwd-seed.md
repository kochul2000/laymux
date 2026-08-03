# 0130. 세션 CWD 는 스폰 시점 시작 디렉터리로 시딩한다 (0003 확장)

- Status: Accepted
- Date: 2026-08-04
- Source: 사용자 보고(세션 복원으로 시작한 pane 옆 GitHubView 가 리포를 인지 못함), [ADR-0003](0003-cwd-single-source-syncgroup.md), [api-contracts.md §CWD 전파 가드](../architecture/api-contracts.md)

## Context

`TerminalSession.cwd` 는 ADR-0003 이 정한 CWD 단일 진실 소스이지만, 그 값을 채우는 경로는 지금까지 OSC 7 / OSC 9;9 하나뿐이었다. 그리고 그 OSC 는 소스 터미널이 `TerminalActivity::Shell` 일 때만 수용된다 — `Running`/`InteractiveApp` 의 OSC 7 은 사용자의 `cd` 가 아니므로 로컬 갱신조차 건너뛴다.

이 두 규칙이 겹치면 CWD 가 **영구히 비는** 조합이 생긴다. 세션 복원으로 pane 이 곧바로 `claude --resume` / `codex resume` 을 실행하면 첫 바이트부터 interactive app 으로 분류되므로, 셸 프롬프트가 한 번도 그려지지 않고 수용되는 OSC 7 도 발행되지 않는다. `session.cwd` 는 세션이 끝날 때까지 `None` 이고, CWD 를 따르는 모든 소비자가 함께 눈이 먼다: sync-group `cd` 전파, `propagate_cwd_once`, MCP/remote 터미널 요약, 그리고 같은 sync group 의 `GitHubView` — 디스크에 GitHub 리포가 있어도 "리포 아님" 으로 보인다.

`FileExplorerView` 나 워크스페이스 선택기는 이 창을 각자 `lastCwd`(설정에 저장된 마지막 CWD)로 렌더 시점에 메우고 있었다. 즉 View 마다 보정이 흩어졌고, 백엔드 SoT 는 여전히 비어 있어 전파 계열은 보정 대상조차 아니었다.

범위는 "PTY 가 실제로 시작한 디렉터리를 SoT 에 반영한다" 까지다. interactive app 이 내부적으로 디렉터리를 옮기는 것을 추적하는 것은 비목표다(OSC 없이는 관측 불가).

## Decision

**`TerminalSession.cwd` 는 PTY 스폰이 실제로 적용한 시작 디렉터리로 시딩한다.** OSC 는 그 이후의 *변경* 을 싣는 두 번째 경로로 남는다.

- 시딩 값은 추측이 아니라 **PTY 에 실제로 적용된 디렉터리** 다. `wsl --cd <dir>` 로 넘어간 경로거나, 자식 프로세스의 OS 작업 디렉터리로 설정된 경로다. 설정된 시작 디렉터리가 없거나 존재하지 않아 적용을 건너뛰었으면 시딩하지 않는다(`None` 유지) — 자식은 상속된 CWD 에서 시작하므로, 요청값을 시딩하면 있지도 않은 위치를 주장하게 된다.
- 단 `wsl --cd` 경로는 존재 검사를 하지 않는다. 경로가 distro 내부에 있고 이 지점에서는 distro 가 확정되지 않으며, 검사가 필요하지도 않다 — 없는 디렉터리를 주면 `wsl` 은 다른 곳에서 셸을 띄우는 대신 실행 자체를 실패시킨다(`Wsl/ERROR_FILE_NOT_FOUND`). 즉 "살아 있는 자식이 시딩값과 다른 곳에 있는" 상태가 만들어지지 않는다.
- 시딩 값의 형태는 OSC 7 유래 CWD 와 같은 정규형(`normalize_wsl_path`)이다. 두 경로가 같은 비교 함수(`filter_targets_needing_cd` 등)를 지나기 때문이다.
- 시딩은 `terminal-cwd-changed` 를 발행하지 않는다(변경이 아니라 초기값). 프론트 스토어는 `create_terminal_session` 응답의 `cwd` 필드로 같은 값을 받는다.
- activity 가드는 그대로다. 가드는 "이 OSC 가 사용자 의도의 `cd` 인가" 를 판정하는 것이고, 스폰 시작 디렉터리는 OSC 가 아니라 우리가 방금 지정한 사실이다.

## Alternatives Considered

- **`GitHubView` 에만 `lastCwd` 폴백 추가** — 증상이 보고된 View 는 고치지만, 같은 pane 에서 `propagate_cwd_once` 와 MCP 요약은 여전히 CWD 를 모른다. 보정이 View 마다 늘어나는 기존 부채를 키운다.
- **restore 시 activity 가드를 완화해 첫 OSC 7 을 수용** — 가드가 막으려던 대상(interactive app 이 프롬프트 재렌더마다 흘리는 OSC 7)을 그대로 통과시킨다. 복원 pane 은 정확히 그 상태이므로 가드가 사실상 무력화된다.
- **`lastCwd` 를 백엔드에 전달해 그대로 SoT 에 기록** — PTY 가 그 디렉터리를 적용하지 못한 경우(삭제된 경로 등)에도 SoT 가 거짓이 된다. 스폰 결과를 관측해 시딩하면 이 거짓이 구조적으로 불가능하다.

## Consequences

- CWD 소비자는 복원 pane 에서도 첫 렌더 직후 디렉터리를 얻는다 — `GitHubView` 리포 인지, sync-group `cd`, `propagate_cwd_once`, MCP/remote 요약이 함께 살아난다.
- `session.cwd` 쓰기 지점이 둘(스폰 시딩, OSC 수용)로 늘어난다. 스폰 시딩은 세션 생성 경로 한 곳에서만 일어나고 그 이후로는 OSC 만 갱신한다는 순서를 유지해야 한다.
- 시딩된 CWD 는 interactive app 이 내부에서 디렉터리를 옮기면 오래된 값이 된다. 이는 가드가 있는 한 기존 interactive app pane 과 동일한 한계이며, 더 이상 나빠지지는 않는다.
- `create_terminal_session` 응답 계약에 `cwd` 필드가 추가된다(선택 필드). 프론트 스토어 시딩이 이 필드에 의존한다.
- 후속 재검토 조건: 셸 통합 없이도 자식 프로세스의 실제 CWD 를 주기적으로 관측할 수단(예: 프로세스 핸들 조회)을 도입하면, 시딩값의 staleness 자체를 없앨 수 있다.
