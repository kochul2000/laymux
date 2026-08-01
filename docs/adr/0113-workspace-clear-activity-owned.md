# 0113. 워크스페이스 클리어는 activity handler 가 클리어 방법을 소유하고, 모르는 앱은 건드리지 않는다

- Status: Proposed
- Date: 2026-08-02
- Source: 사용자 요구(issue #726 "액티비티에 따라, 전체 워크스페이스를 클리어하는 편의 기능"), [ADR-0005](0005-display-state-raw-separation-compute.md)(원시 상태 분리 → 단일 계산 함수), [ADR-0004](0004-settings-vs-ui-state-separation.md)(설정 vs UI 상태)

## Context

한 워크스페이스에 shell, Claude Code, Codex pane 이 섞여 있는 것이 평상시 배치다. 화면을 정리하려면 pane 마다 포커스를 옮겨 각각 다른 것을 쳐야 한다 — shell 은 `clear`, 에이전트는 `/clear`. pane 이 6개면 6번이다.

"전부 클리어"를 한 동작으로 묶으려면 세 가지를 정해야 한다.

1. **무엇을 칠지 누가 아는가.** `clear` 를 Claude 입력창에 치면 클리어가 아니라 프롬프트가 되고, `/clear` 를 shell 에 치면 command not found 다. pane 별 판단 근거는 이미 `terminalStore` 의 activity 원시 상태와 `lib/activity-handler.ts` 의 provider 레지스트리에 있다.
2. **모르는 앱을 어떻게 다룰까.** activity 가 `interactiveApp` 이어도 `nvim`·`htop`·`less` 처럼 전용 handler 가 없는 앱이 있다. `getHandler()` 는 이들에게 shell handler 를 돌려주므로, 아무 방어 없이 handler 에게 물으면 vim 버퍼에 `clear` 라는 글자가 박힌다.
3. **작업 중인 pane 을 어떻게 할까.** 이슈가 명시적으로 세 갈래를 제시했다 — 멈추고 클리어 / 강제 클리어(restart view) / 그냥 두기.

범위는 워크스페이스 격자의 `TerminalView` pane 이다. Dock 은 워크스페이스 전환에 영향받지 않는 고정 표면이므로([overview.md §3.1](../architecture/overview.md)) "워크스페이스 클리어"의 대상이 아니다. 스크롤백 삭제(`clear` 가 하는 일 이상)나 PTY 재사용 없는 세션 초기화는 비목표다.

## Decision

**클리어할 텍스트와 "지금 쳐도 되는가"는 그 pane 의 activity handler 가 소유하고, 전용 handler 가 없는 interactive app 은 클리어 대상에서 제외한다. 작업 중인 pane 의 처리는 `settings.workspaceClear.busyPolicy` 한 값이 정하며 기본값은 건드리지 않는 것이다.**

- **handler 가 클리어 계약을 갖는다.** `ActivityHandler` 에 `clearInput(shellClearCommand)` 와 `isBusy(raw)` 를 추가한다. `ShellActivityHandler` 가 기본 구현(설정된 shell 명령 / `outputActive || activity==="running"`)을 주고, Claude·Codex handler 가 `/clear` 와 자신의 working·input-pending 신호로 덮어쓴다. provider 지식이 이미 모여 있는 곳에 한 축을 더하는 것이지, 새 분기 테이블을 만들지 않는다.
- **전용 handler 가 없는 `interactiveApp` 은 skip 한다.** 레지스트리 등록 여부(`isRegisteredInteractiveApp`)가 유일한 판정 기준이다. "shell 로 폴백"은 vim·htop 에 텍스트를 흘려 넣는 동작이고, 클리어는 되돌릴 수 없는 쓰기이므로 모를 때는 아무것도 하지 않는 쪽이 기본값이다. `nvim` 을 클리어하고 싶어지면 `nvim` handler 를 등록하는 것이 그 요구의 답이다.
- **busy 정책은 값 하나다.** `skip`(기본) · `interrupt`(Ctrl+C `interruptRounds` 회 → `settleMs` 대기 → 클리어 입력) · `restart`(입력 없이 view 재시작). 기본값이 `skip` 인 이유는 이 기능이 편의 기능이고, 돌고 있는 작업을 끊는 것은 사용자가 명시적으로 켤 일이기 때문이다. 유휴 pane 은 정책과 무관하게 항상 클리어된다.
- **계획과 실행을 가른다.** `lib/workspace-clear.ts` 의 `planWorkspaceClear()` 는 원시 상태 + 설정 → `ClearAction[]` 인 순수 함수이고([ADR-0005](0005-display-state-raw-separation-compute.md)), `runWorkspaceClear()` 는 주입된 write/interrupt/restart/sleep 만 쓴다. "어떤 pane 에 무엇을 칠 것인가"가 Tauri 없이 단위 테스트로 고정되는 지점이 이 파일 하나다.
- **shell 클리어 명령은 설정값이다.** `settings.workspaceClear.shellCommand` 기본 `clear`. cmd.exe(`cls`) 나 커스텀 셸을 쓰는 사용자가 앱 수정 없이 맞출 수 있어야 한다. 앱은 이 문자열을 해석하지 않는다.
- **제출 경로는 사람 입력과 같다.** `write_terminal_input(submit: true)` 를 쓴다 — bracketed paste 처리와 본문/CR 분리가 이미 그 경로에 있고(#490), human-control lease 게이트도 그대로 적용된다. 원격이 제어권을 쥔 동안 데스크톱이 몰래 쓰는 경로를 새로 뚫지 않는다.
- **restart 요청 상태의 SoT 는 store 다.** 지금까지 재시작 epoch 는 `PaneGrid`/`Dock` 의 로컬 state 였고, 컴포넌트 밖에서는 재시작을 요청할 방법이 없었다. `stores/terminal-restart-store.ts` 로 옮겨 두 컴포넌트가 같은 store 를 읽게 한다. 로컬 state 를 남긴 채 요청 채널만 추가하면 같은 사실의 소유자가 둘이 된다.

## Alternatives Considered

- **profile 이름으로 분기(`profile.includes("claude")`).** 프로파일은 셸을 정할 뿐이고 그 안에서 무엇이 도는지는 모른다. 같은 PowerShell pane 이 Claude 를 띄웠다 껐다 한다. activity 가 이미 그 사실의 SoT 다.
- **모르는 앱에도 shell 클리어를 보낸다.** 커버리지는 넓지만 실패가 조용하지 않다 — vim 버퍼 오염, `less` 검색창 입력 등 사용자가 되돌려야 하는 상태를 만든다.
- **busy 판정을 `computeStatus().icon === "⏳"` 로 재사용.** 표시용 아이콘에 동작을 걸면 아이콘 변경이 곧 동작 변경이 된다. input-pending 은 아이콘이 ✓ 이지만 클리어를 치면 모달에 답이 들어가므로 busy 로 다뤄야 한다 — 두 개념이 실제로 다르다.
- **busy 정책을 pane 마다 오버라이드.** 요구는 전역 편의 기능이었고, pane 별 축을 열면 해석 계층과 UI 가 함께 늘어난다([ADR-0111](0111-github-view-display-settings.md) 과 같은 판단).
- **Rust 백엔드가 워크스페이스를 순회.** activity 판정·handler 레지스트리·pane↔terminal 매핑이 전부 프론트에 있다. 백엔드로 옮기면 같은 지식을 두 벌 유지해야 한다.
- **Dock 터미널까지 포함.** Dock 터미널은 활성 워크스페이스 id 로 등록되지만 `workspace.panes` 에는 없다. 포함하면 "워크스페이스 클리어"가 워크스페이스를 넘어가고, pane 조회 기반의 restart 경로도 성립하지 않는다.

## Consequences

- 기본값(`busyPolicy: "skip"`)에서는 돌고 있는 pane 이 조용히 남는다. 사용자가 "클리어했는데 안 됐다"고 느낄 수 있으므로 실행 결과에 skip 사유를 담아 Automation 응답으로 돌려준다.
- `ActivityHandler` 인터페이스가 2개 멤버 늘었다. 새 provider handler 를 추가할 때 클리어 계약도 함께 정해야 한다 — `ShellActivityHandler` 상속으로 기본값은 얻는다.
- 재시작 epoch 가 store 로 이동했으므로 `PaneGrid`/`Dock` 의 로컬 state 는 사라진다. 두 컴포넌트가 같은 pane id 공간을 공유하지만 pane id 는 전역 유일하므로 충돌하지 않는다.
- `restart` 정책은 PTY 를 새로 만든다 — 스크롤백과 셸 히스토리 세션이 사라진다. `clear` 와 의미가 다르다는 것을 설정 설명에 남긴다.
- Automation `POST /api/v1/workspaces/{id}/clear` 가 생겨 자율 검증 루프에서 이 기능을 트리거할 수 있다. 반대로 이 엔드포인트는 원격에서 워크스페이스 전체에 쓰기를 유발하므로 human-control 게이트를 우회하지 않는다는 점이 계약의 일부다.
- 재검토 조건: 전용 handler 가 없는 TUI 를 클리어해 달라는 요구가 반복되면 "등록되지 않은 앱 = skip" 규칙을, 워크스페이스마다 다른 busy 정책 요구가 나오면 전역 전용 결정을 각각 다시 정한다.
