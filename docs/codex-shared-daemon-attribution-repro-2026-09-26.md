# Codex 기본 공유 데몬의 pane 귀속 조사

- 날짜: 2026-09-26
- Laymux 기준: `c7112b24` (1.0.18)
- Codex: Windows native 0.157.1, 기본 `codex` 실행
- 상태: 원인·대안 및 선택 옵션 구현의 dev 실측. 릴리즈 완료 기록이 아니다.

## 원인

기존 귀속은 PTY 자식의 최상위 Codex PID를 찾고, 그 PID의 SQLite 진단에서 현재 대화를 확인한다. 기본 공유 데몬 모드에서는 이 PID가 TUI이고, 실제 대화 진단은 여러 pane이 공유하는 app-server PID에 기록된다. 살아 있는 TUI에 thread ID가 없어서 `ActiveButUnidentified`가 된다. rollout의 파일 나이 제한을 해제한 1.0.18도 이 별도 문제를 해결하지 않는다. viewer 활성 여부와 무관하다.

보고된 `terminal-pane-6833d0cd`는 `laymux-dev` workspace 왼쪽 첫 pane이다. TUI PID 52300과 오른쪽 pane의 TUI PID 49320은 app-server PID 19876을 공유했다. 실제 현재 대화는 각각 `01a0dc40-4edd-7fc0-833f-bfd2464d3b9f`, `01a0dc57-19cb-7cf3-8334-a086fc44c972`였다.

## 확인한 공식 계약

- [App-server API](https://learn.chatgpt.com/docs/app-server): `thread/loaded/list`는 서버 전체에 적재된 대화 ID이며 현재 TUI 선택 목록이 아니다. `thread/read`는 resume하지 않고 읽는다. `thread/unsubscribe`는 연결의 구독을 제거하지만 즉시 runtime을 제거하지 않는다.
- [기본 데몬](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server-daemon/README.md): 여러 클라이언트가 하나의 서버를 공유한다.
- [TUI task-tools MCP](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/dynamic_tools_mcp.rs): TUI별 loopback listener를 만들고 thread 요청의 MCP 설정으로 전달한다.
- [MCP 상태 API](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server/src/request_processors/mcp_processor.rs): 대화별 `codex_tui.httpOrigin`을 조회할 수 있다.
- [타이틀 항목](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/bottom_pane/title_setup.rs): `thread-id` 항목과 `session-id` 별칭을 지원한다.
- [실제 타이틀 출력](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/chatwidget/status_surfaces.rs): 현재 ChatWidget ID를 사용하지만 UUID를 앞 29자와 `...`로 축약한다. `Full thread UUID` 설명만 보고 온전한 ID라고 가정하면 안 된다.

## MCP 포트만 사용하는 대안은 기각

읽기 진단에서 현재 대화의 `codex_tui.httpOrigin`은 `127.0.0.1:57240`, 오른쪽 대화는 `127.0.0.1:58432`였다. OS LISTEN PID도 각각 두 TUI와 일치했다. 그러나 이것은 최초 연결을 확인할 뿐 현재 화면의 대화 선택을 보장하지 않는다.

독립 서브에이전트의 공식 소스 리뷰로 다음 문제가 확인됐다.

1. 이미 적재된 대화에 다른 TUI가 resume하면 새 MCP 설정 override를 무시할 수 있다. A가 B를 보고 있어도 A의 옛 대화와 A 포트의 연결이 유일하게 남을 수 있다. 따라서 유일성 검사만 추가해도 다른 대화를 저장할 위험이 있다.
2. `mcpServerStatus/list`의 `toolsAndAuthOnly`도 전체 MCP 클라이언트를 Eager 모드로 기동한다. 주기적인 세션 감지에 사용하면 외부 MCP 프로세스·연결을 반복 생성할 수 있다.

관련 구현: `app-server/src/request_processors/thread_processor.rs`의 `thread_unsubscribe`, `try_resume_running_thread`; `codex-mcp/src/mcp/mod.rs`의 snapshot 수집. 이 대안으로 제품 코드를 작성하거나 릴리즈하지 않았다.

## 기본 데몬을 유지한 타이틀 연동 실측

release 19280의 사용자 pane에는 입력하거나 설정을 변경하지 않았다. dev 19281에 `codex-daemon-attribution-repro` workspace와 테스트 PowerShell pane 두 개를 만들고 기본 `codex`를 실행했다. 둘의 `/status`는 `Server: Local background server`와 서로 다른 대화 ID를 출력했다.

워크트리의 무시되는 `.codex/config.toml`에만 다음 재현 설정을 추가했다. 사용자 홈의 Codex 설정은 변경하지 않았다.

```toml
[tui]
terminal_title = ["app-name", "thread-id", "codex-version", "spinner", "project"]
```

테스트 pane에서 `/new`로 설정을 다시 읽은 뒤 다음 값을 확인했다.

- `/status`: `01a0ddb4-4ea8-7fd2-a0ef-84598df1dc45`
- OSC title: `codex | 01a0ddb4-4ea8-7fd2-a0ef-84598... | 0.157.1 | laymux-fix-codex-daem...`
- `/status`의 서버: 계속 `Local background server`

입력이 없는 위 새 대화는 `state_5.sqlite`에 아직 행이 없었다. SQLite prefix 조회만으로는 0개가 반환되지만, `thread/loaded/list`의 실제 ID 중 타이틀 앞 29자에 맞는 항목은 정확히 하나였고 `/status`의 전체 ID와 일치했다. 그 ID의 `thread/read(includeTurns: false)`는 `parentThreadId: null`, `status: idle`을 반환했다. 따라서 fresh 대화까지 다루려면 축약 타이틀을 현재 적재된 ID 목록과 대조하는 읽기 어댑터가 필요하다. MCP 상태 API는 이 경로에 필요 없다.

두 번째 dev pane에서 `!echo laymux-daemon-title-repro`만 실행하여 LLM 요청 없이 저장 가능한 대화를 만든 뒤, 첫 pane에서 `/resume 01a0ddae-6830-7290-94e7-0fc5eac60219`로 같은 대화를 열었다. 첫 pane의 타이틀은 `codex | 01a0ddae-6830-7290-94e7-0fc5e... | 0.157.1 | ...`로 바뀌었고 `/status`의 전체 ID와 일치했다. SQLite에도 그 prefix에 대응하는 전체 ID가 정확히 하나 있었다. 다른 TUI에서 만든 대화를 여는 경우에도 타이틀은 실제 표시된 대화를 따라갔다. 두 pane이 같은 ID를 표시할 때의 기존 중복 귀속 차단은 유지해야 한다.

재현 후 테스트용 두 Codex TUI를 `/quit`으로 종료하고 임시 프로젝트 타이틀 설정을 제거했다. 사용자 홈 설정과 실행 중인 사용자 pane은 변경하지 않았다.

`-c tui.terminal_title=...`를 실행 명령에 무조건 추가해서는 안 된다. 0.157.1의 daemon exclusion이 이 override를 허용하지 않아 embedded 방식으로 바뀐다. `--remote unix://` 강제도 로컬 CWD·권한 해석을 바꾼다. 설정 파일의 타이틀 항목은 기본 데몬을 유지하면서 현재 선택을 밖으로 내보내는 검증된 경로다. 이것을 유일한 가능한 방법으로 단정하지 않는다.

## 타이틀 설정 외 대안의 추가 조사

사용자는 기본 데몬을 지원해야 한다고 했으며, 타이틀 설정 변경 외의 방법을 더 찾아달라고 요청했다. 아래는 stock Codex 0.157.1 소스와 공식 문서·이슈를 추가 확인한 결과다. 사용자 설정과 release pane에는 변경을 가하지 않았다.

| 경로 | 확인 결과 | 현재 선택 귀속의 한계 |
| --- | --- | --- |
| `/status` 화면 출력 | 기본 타이틀·기본 공유 데몬에서 전체 Session ID를 출력함을 dev에서 실측 | 사람이 확인할 수 있지만 자동 주입은 composer·메뉴·키맵 상태와 충돌할 수 있다. 과거 출력은 현재 선택의 증거가 아니다. |
| `/statusline`의 session ID | 공식 문서에 지원 항목으로 명시 | 타이틀은 유지하지만 별도 Codex 설정 및 화면 파싱이 필요하다. 이번 조사에서는 실측하지 않았다. |
| hook/`notify` | Session ID는 있지만 TUI별 PID·pane 식별자가 없다. legacy `client` 값도 `codex-tui`라는 앱 이름이다. | hook은 공유 서버 쪽에서 실행되어 특정 TUI에 연결할 근거가 부족하다. |
| `app-server proxy` | stdio와 control socket 사이의 바이트 중계다. | 이미 접속한 다른 TUI의 통신이나 선택 상태를 관찰하는 API가 아니다. |
| IDE IPC | TUI가 `workspaceRoot`를 보내 IDE context를 받는 경로다. | Desktop의 비공개 owner/follower 기능이 TUI의 현재 선택 조회 계약이라는 근거가 없다. |
| TUI 녹화·진단 로그 | `CODEX_TUI_RECORD_SESSION`의 inbound는 대부분 AppEvent 변종만, outbound는 AppCommand payload 전체를 기록한다. `UserTurn.client_user_message_id`는 서버 UserMessage의 `clientId`까지 전달된다. | 메시지를 보낸 대상은 연결할 수 있으나 현재 화면 선택을 직접 뜻하지 않는다. 빈 세션·사용자 턴 없는 resume·전환에는 단서가 없으며, 실행 중인 TUI에 녹화를 소급 적용할 수 없다. |
| TUI telemetry | `app/startup.rs`가 `SessionTelemetry::new(ThreadId::new(), ...)`로 별도 ID를 만든다. | telemetry의 session 값이 현재 표시된 대화 ID라는 가정은 성립하지 않는다. |
| `CODEX_THREAD_ID` 환경변수 | 실행 도구의 자식 프로세스에 주입되는 실제 대화 ID다. | 공유 서버의 도구 프로세스와 이를 표시하는 TUI는 별도 소유 관계다. TUI 현재 선택의 범용 조회가 아니다. |

추가 근거:

- [공식 slash command 문서](https://learn.chatgpt.com/docs/developer-commands): `/status`는 chat ID를 출력하며 `/statusline`은 session ID 항목을 지원한다.
- [동일한 hook 귀속 제약 보고 #37537](https://github.com/openai/codex/issues/37537): 공유 데몬에서 hook이 terminal을 특정하지 못하는 문제이며 조사 시점에도 open이다. 보고서 자체를 API 계약으로 취급하지 않고 [현재 hook schema](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/hooks/src/schema.rs)와 [legacy notify](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/hooks/src/legacy_notify.rs)를 함께 확인했다.
- [Desktop 활성 thread 조회 요청 #25914](https://github.com/openai/codex/issues/25914): 별도 Desktop 사례이며 CLI의 동작 증거로 대체하지 않는다. 언급된 IPC 경로는 [TUI ide_context/ipc.rs](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/ide_context/ipc.rs)에서 확인했다.
- [TUI telemetry 초기화](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/app/startup.rs), [session log](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/session_log.rs), [기본 데몬 제외 조건](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/daemon_startup.rs).

독립 리뷰에서 녹화 로그의 UserTurn ID가 서버의 UserMessage `clientId`로 이어짐을 추가 확인했다. 따라서 로그를 아무 단서도 없는 경로로 분류해서는 안 된다. 다만 `app/input.rs`의 Alt+Left/Right는 AppCommand 없이 `select_agent_thread`를 호출해 화면을 바꾼다. 뒤의 `ResetTranscriptForThreadSwitch` 기록으로 기존 귀속을 무효화할 여지는 있지만 새 대상 ID는 얻지 못한다. 또한 `submit_thread_op(thread_id, op)`가 녹화에 thread ID 인자를 포함하지 않고, 백그라운드 voice owner의 명령도 녹화에 들어갈 수 있다. 로그 연계는 보조 경로 후보이며 모든 현재 선택을 식별하는 완성된 해결책은 아니다.

### `/status` dev 재현

19281에 `codex-status-attribution-repro` workspace와 PowerShell pane 하나를 만들고, 별도 설정이나 인자 없이 `codex`를 실행했다. 타이틀은 프로젝트명만 표시했다. `/status`에서 다음을 확인했다.

- `Server: Local background server`
- `Session: 01a0dde5-db8c-72b0-aeda-1979a4fec22f`

미전송 입력 `LAYMUX_UNSENT_DRAFT` 뒤에 `/status`를 붙여 Enter 없이 화면을 읽으면 `LAYMUX_UNSENT_DRAFT/status`가 그대로 composer에 남았다. 이 입력은 모델에 보내지 않았다. 테스트 입력을 비운 후 `/status`를 실행하자 동일한 전체 ID가 다시 출력됐다. `/quit`으로 테스트 TUI를 종료하고 테스트 workspace를 삭제했다.

이 경로는 설정 없는 수동 확인이나 명시적인 일회성 확인 UI의 후보지만, 그대로 백그라운드 자동 감지에 사용하면 안 된다. 입력 보존·모달·vim mode·응답 대기·동시 입력·대화 전환을 다뤄야 하며, 단순히 scrollback의 마지막 Session 행을 저장하면 오래된 대화를 선택할 수 있다.

### 현재 결론의 범위

타이틀 이외의 방법이 전혀 없는 것은 아니다. `/status`는 실제 작동하고 `/statusline`도 공식 설정 경로다. 다만 **기본 공유 데몬, 사용자 설정 변경 없음, TUI 입력·화면 조작 없음, 현재 선택의 확정 귀속**을 모두 만족하는 외부 조회 경로는 이번 조사에서 확인하지 못했다.

이 조건을 유지하는 설계 대안은 Codex TUI가 현재 표시하는 전체 thread ID와 전환·해제 이벤트를 전용 터미널 신호나 조회 API로 내보내도록 하는 것이다. 공유 데몬의 전체 thread 목록 또는 소유 client 목록만 추가해서는 한 TUI가 여러 대화에 연결되는 경우의 현재 선택을 해결하지 못한다. 이 대안은 upstream 변경 또는 별도 Codex 빌드가 필요하며, 이번 조사에서 구현·검증한 기능으로 보고하지 않는다.

조사 문서만 작성한 단계에서는 ADR이 필요하지 않았다. 이후 사용자가 선택한 종료 전 `/status` 조회의 계약은 [ADR-0270](adr/0270-codex-status-checkpoint-probe.md)에 기록한다.

## 구현 전에 결정할 경계

타이틀 연동은 Codex 설정을 관리하는 새 외부 계약이므로 ADR이 필요하다. 사용자 설정 변경을 허용할지 먼저 방향을 논의한다. 구현한다면 PTY generation과 현재 TUI liveness, 엄격한 타이틀 형식, 전체 ID의 유일한 대조, 최상위 역할·rollout 검증을 결합해야 한다. 축약 ID 충돌·타이틀 소실·대화 전환·프로세스 교체는 추정하지 않는다. 설정 보존·동시 편집·native/WSL 환경 차이와 두 pane 간 resume가 필수 회귀 범위다.

## 2026-09-27: Ctrl+C 종료 출력의 ID 수집 대안

종료 후 읽기 전용 SQLite 조회로 추가 검증했다. 입력 없는 첫 ID(`01a0e102-1a52-7541-b098-c967fbd58dc6`)는 `threads` 행이 없었다. 셸 명령을 실행한 두 번째 ID(`01a0e103-7bcb-7a20-89c0-2dc0472f2957`)는 `threads` 행이 존재하고 rollout 첫 `session_meta`의 ID와도 일치했다. 종료 안내에 ID가 있다는 사실만으로 영속된 복원 대상이라고 간주하면 안 된다.


사용자는 종료 시 Ctrl+C로 Codex를 종료하면 세션 ID가 출력된다는 대안을 제시했다. Codex 0.157.1 기본 공유 데몬과 기본 타이틀로 dev 19281에서 직접 확인했다.

- 새 대화의 `/status`가 `Local background server`임을 확인했다. Ctrl+C 한 번으로 idle TUI가 종료되며 `Reconnect: codex resume 01a0e102-1a52-7541-b098-c967fbd58dc6`을 출력하고 PowerShell로 돌아왔다.
- 다른 새 대화에서 `!echo laymux-exit-id-repro`를 실행하고 완료를 기다린 뒤 Ctrl+C를 보냈다. `Reconnect: codex resume 01a0e103-7bcb-7a20-89c0-2dc0472f2957`과 셸 복귀를 확인했다. 모델 요청은 사용하지 않았다.
- `app/exit_summary.rs`는 현재 ChatWidget의 ID를 우선 사용하며, 기본 데몬에서는 `Reconnect: codex resume <전체 UUID>`를 출력한다. embedded 경로는 저장 가능한 대화에 `To continue this session, run:`와 resume 명령을, 그 외 ID가 있으면 `Session ID:`를 출력한다.
- 같은 소스와 `app/input.rs`에서 공유 데몬의 실행 중 작업은 Ctrl+C에 `Task is still running` 메뉴가 나올 수 있음을 확인했다. `Cancel task`, `Run in background`, `Exit`는 다른 동작이다. 따라서 일정 횟수 Ctrl+C만 전송했다고 종료 완료로 간주하면 안 된다. 이 active-turn 메뉴는 이번 실측 범위에 포함하지 않았다.
- 종료 문구의 `Any running work continues`는 TUI 연결 종료와 공유 데몬 작업 종료가 별개임을 알린다. 데몬 전체를 종료할 필요는 없지만, 작업 중단을 원하는 옵션은 `Exit`의 중단 후 종료 동작을 별도로 다뤄야 한다.

현재 Laymux의 `exit.interruptTerminals`는 checkpoint 저장 후 Ctrl+C를 보내고 화면 기록을 캐시한다. 해당 출력의 ID를 최종 복원 ID로 채택하지 않는다. 종료 출력 방식은 기존 기능에 연결할 수 있는 유효한 후보이며, 타이틀이나 녹화 설정을 요구하지 않는다.

구현하려면 현재 생존 프로세스·PTY generation과 출력 시작 위치를 기록하고, 이번 종료에서 새로 출력된 ID와 실제 TUI 종료를 확인해야 한다. 이전 scrollback의 ID를 재사용하지 않는다. 새 대화에 ID가 출력되더라도 영속 rollout이 없을 수 있으므로 저장 가능한 대화와 fresh를 구분한다. 실패한 종료·다중 후보·프로세스 교체는 성공으로 처리하지 않는다. 업데이트는 현재 critical checkpoint가 Ctrl+C보다 먼저이므로, 이 대안을 도입할 때는 최종 저장 순서와 종료 이후 귀속 보존을 ADR로 정해야 한다.

테스트용 TUI는 모두 종료했으며 테스트 workspace도 삭제했다. 사용자 release pane과 설정에는 변경이 없다.

## 2026-09-27: 선택 옵션의 `/status` 조회 검증

사용자가 종료 출력 대신 입력창을 편집 키로 지운 뒤 `/status`를 읽는 방식을 선택했다. `codex.verifySessionOnExit`는 기본 true이며, 일반 종료와 업데이트의 마지막 저장 직전에만 조회한다. 구현 계약과 미지원 상태는 ADR-0270과 architecture 문서가 정본이다.

Codex 0.157.1 Windows native 기본 공유 데몬을 dev 19281에서 실행했다. 사용자 Codex 설정과 release 앱은 변경하지 않았다.

- 기존 수동 관측이 `activeButUnidentified`인 TUI에서 현재 전체 UUID를 확인했다. 영속 기록이 없는 대화는 Fresh로, 테스트 셸 명령으로 기록이 생긴 뒤에는 같은 ID의 identified로 저장 준비를 통과했다.
- 62×44 pane에서 실제 xterm과 PTY를 96×44로 넓혀 조회한 뒤 62×44로 복구했다. 입력창에 여러 줄 초안을 넣고 커서를 중간에 둔 경우까지 약 2.6초에 처리됐다.
- 입력 초안에 `normal`, `INSERT`가 포함돼도 일반 텍스트로 처리했다. 실제 Vim footer만 미지원 상태로 판정한다.
- 저장된 rollout을 읽기 전용으로 확인하여 정확한 session_meta ID와 테스트 셸 명령의 기록을 확인했다. 삭제한 미전송 초안은 rollout에 없었다.
- 초기화 중 Session ID 없는 화면과 shell composer는 조회 실패로 처리했다. 불확실한 화면에서 Enter를 보내지 않는다.
- 최신 main(`9220ef73`, 1.0.19)을 반영한 dev에서 설정 UI로 옵션을 켜고 실제 창 닫기를 실행했다. shell composer에서는 실패 모달의 종료 취소로 돌아왔고 입력이 다시 가능했다. 일반 composer의 여러 줄 초안과 중간 커서 상태에서는 창이 정상 종료됐고, settings.json의 해당 pane `lastCodexSession`에 정확한 UUID가 남았다.
- 같은 테스트 설정으로 dev를 재실행하고 workspace를 활성화하자 이전 대화가 자동 복원됐다. 다시 일반 종료한 뒤에도 동일 UUID가 저장됐다. 삭제한 최종 초안이 rollout에 없는 것을 확인했다. 설정 옵션과 실패 모달은 screenshot API로 시각 확인했다.

단위·화면 테스트는 오래된 status 출력, 모달로 지워진 명령 메뉴, 토큰 만료와 지연 저장, generation·프로세스 변경, 실제 프로세스의 별도 Codex/SQLite 홈, 설정 override, close/update fence, 실패 후 종료 취소를 포함한다. 이 실측은 Windows native 범위이며 WSL 실제 TUI 종료·복원까지 검증한 기록은 아니다.
