# WSL Claude Chrome 호스트의 세션 귀속 충돌 재현

- 날짜: 2026-09-17
- 사용자 실행 버전: Windows laymux 1.0.4
- 수정 기준: `0b262d10`(main, 1.0.5). 이 버전의 아이콘 변경은 해당 귀속 경로를 수정하지 않았다.
- 대상: `terminal-pane-54e49f2e`, Ubuntu-22.04, Claude Code 2.1.274
- 결정: [ADR-0253](adr/0253-wsl-claude-chrome-helper-role.md)

## 실제 실패 증거

사용자가 보고한 오류는 `Session attribution is not conclusive for terminal-pane-54e49f2e: activeButUnidentified`다. release API 호출·PTY 입력·프로세스 종료 없이 `/proc`와 해당 PID의 세션 메타데이터를 읽었다. 환경 전체나 대화 본문은 수집하지 않았다.

| 구분 | PID | 부모 계보 | 실행 모드 | PID 세션 파일 |
| --- | --- | --- | --- | --- |
| 실제 대화 | 997318 | bash 984482 → Relay 984468 | `claude --dangerously-skip-permissions` | 존재 |
| Chrome 호스트 | 2718444 | chrome 2641428 → Relay 984468 | `claude --chrome-native-host` | 없음 |

두 프로세스 모두 동일한 `LX_TERMINAL_ID=terminal-pane-54e49f2e`를 상속했다. 실제 대화 파일의 `sessionId`는 `113222c2-8d47-40aa-9e00-b70190b6a66c`였다. Chrome 호스트는 현재 대화 프로세스의 자손이 아니었다.

수정 전 production shell probe를 그대로 실행하면 두 PID 모두 `comm=claude`인 P 행으로 반환됐다. 부모 bash·chrome의 `/proc/environ`에는 이 marker가 노출되지 않아 귀속 그룹에서 두 Claude 모두 깊이 0이었다. liveness의 전체 조상 탐색에서도 두 PID의 깊이는 5로 같았다.

귀속 선택기는 같은 깊이의 두 후보 때문에 `Some(None)`을 반환했다. 따라서 **정상 대화의 세션 파일을 읽기도 전에 실패**했다. liveness는 같은 앱의 동률을 `Running(Claude)`로 유지했고 통합 결과는 `activeButUnidentified`였다. 세션 파일의 최신성이나 이전 Codex 로그 보존 SQL은 이 실패를 설명하지 않는다.

## 수정 전후 검증

`commands::session_attribution::live_wsl_tests`는 가짜 PTY writer와 별도 `AppState`만 만들고 실제 production provider 조회기와 WSL liveness를 호출한다. 실제 PTY handle·release 앱 상태·설정 파일은 변경하지 않는다. 테스트는 환경변수를 명시한 경우에만 `--ignored`로 실행한다.

```powershell
$env:LAYMUX_TEST_WSL_DISTRO='Ubuntu-22.04'
$env:LAYMUX_TEST_TERMINAL_ID='terminal-pane-54e49f2e'
$env:LAYMUX_TEST_SESSION_ID='113222c2-8d47-40aa-9e00-b70190b6a66c'
cargo test --manifest-path src-tauri/Cargo.toml --lib live_wsl_claude_attribution_matches_its_session_file -- --ignored --nocapture
```

같은 대화·Chrome 호스트 프로세스를 종료하거나 다시 실행하지 않고 대조했다.

- **수정 전:** `{"generation":7,"state":"activeButUnidentified","provider":"claude"}`. `Identified` 기대 assertion 실패. 관측 0.74초.
- **수정 후:** `{"generation":7,"state":"identified","provider":"claude","sessionId":"113222c2-8d47-40aa-9e00-b70190b6a66c"}`를 독립 조회 두 번 모두 반환. 테스트 통과, 두 관측 합계 1.40초.

역할 검사는 실행 파일 이름과 NUL argv의 첫 실행 인자만으로 Chrome 호스트임을 증명한다. helper는 대화 후보에서 빠지고 부모 연결 행은 남는다. 미확인 argv·실제 두 대화는 기존 보수 판정을 유지한다.

## 회귀 검증

- `npm run test:wsl-agent-role`: 실제 production shell을 격리한 `/proc` fixture에 실행. 수정 전 11개 실패, 수정 후 **11개 통과**. 대화+helper, helper 단독, 자손 계보, 진짜 두 대화, 유사 인자, 개행, 프롬프트 인자, argv 조회 실패를 포함한다.
- Rust `commands::wsl_agent_session` 17개, `commands::claude_session` 21개, `commands::session_attribution` 17개, `wsl_liveness` 15개: **70개 통과**. 수동 실기 테스트는 기본 스위트에서 제외하고 위 명령으로 별도 통과했다.
- Windows `ui`에서 `npx vitest run src/lib/persist-session.test.ts src/lib/settings-snapshot.test.ts`: **120개 통과**. 미식별 상태의 critical checkpoint 거절과 식별된 Claude 세션의 저장·보존 계약을 확인한다.
- 독립 서브에이전트 코드 리뷰: 수정이 필요한 지적 없음. 실제 shell 테스트 11개도 독립 실행하여 통과했다.

이 검증은 원래 실패 pane의 정확한 세션 귀속과 체크포인트 계약을 확인한다. 사용자 앱에서 업데이트 설치나 critical checkpoint를 직접 실행하지 않았고, 다른 pane의 독립적인 미식별 원인 또는 native Windows의 helper 판정까지 해결했다고 주장하지 않는다. 현재 실행 중인 1.0.4에는 코드 변경이 자동 반영되지 않는다.

## PR #1056 머지 전 재확인

2026-09-17, #1057이 포함된 main `babd4588`을 병합하고 ADR 번호 충돌을 0253으로 정리했다. 독립 리뷰에서 P1/P2 지적은 없었으며 shell fixture 11개를 리뷰어도 별도로 통과했다. Windows에서 shell fixture 11개, 위 Rust 회귀 70개, UI 저장·체크포인트 120개와 변경 Rust 파일 rustfmt를 다시 실행해 모두 통과했다.

이 시점에는 위 실기 기록의 대화 PID 997318과 Chrome 호스트 PID 2718444가 모두 종료된 상태여서 같은 프로세스에 대한 실기 대조는 재실행하지 않았다. 앞 절의 실기 결과는 PR 작성 당시 기록이며, 이번 재검증 결과와 구분한다. 사용자 release API·PTY·설정은 변경하지 않았다.
