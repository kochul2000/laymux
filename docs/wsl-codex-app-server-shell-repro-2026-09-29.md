# WSL 셸의 Codex 종료 확인 오탐 재현과 수정 검증

- 날짜: 2026-09-29
- ADR: [0280](adr/0280-wsl-codex-app-server-role.md)
- 환경: `D:\PycharmProjects\laymux`, main `89adf9cc` 기반 수정 빌드, dev API 19281, 격리 APPDATA·WebView, Ubuntu-22.04, Codex 0.158.0.

## 원인과 수정 전 재현

사용자가 보고한 `terminal-pane-5a82177b`의 marker를 상속한 WSL `codex` PID 1054321·1395554의 첫 인자는 모두 `app-server`였다. 사용자 프로세스에는 입력·종료·설정 변경을 하지 않고 이름·역할·marker만 읽었다.

dev의 `terminal-pane-66eb69f1`에서 별도 CODEX_HOME `/tmp/laymux-shell-repro-0929`로 실제 `codex app-server --listen unix:///tmp/laymux-shell-repro-0929/server.sock`를 백그라운드 실행했다. 셸은 `SHELL_READY`를 출력하고 프롬프트로 돌아왔다. 수정 전 `begin_codex_status_checkpoint`는 이 pane을 대상으로 반환했고 실제 `withCodexStatusCheckpoint`가 사용자와 동일한 `needs an idle text composer with the default keymap` 오류로 실패했다.

이는 화면 파서의 오인이 아니라 서버를 TUI 후보로 선택한 오인이었다. 세션 귀속과 liveness 양쪽의 공통 게스트 역할 검사에서 첫 인자가 정확히 `app-server`인 Codex만 제외하도록 수정했다.

## 수정 후 실제 dev 검증

| 상황 | 결과 |
| --- | --- |
| 서버 없이 셸만 실행 | status 대상 없음 |
| app-server가 실행 중인 셸 | status 대상 없음 |
| 같은 pane의 서버와 실제 Codex TUI 공존 | TUI를 status 대상으로 유지 |
| TUI에서 실제 status 조회와 critical checkpoint 저장 | `fresh`, Codex UUID `01a0e88e-a19e-7751-b8ef-d513c14ff132`로 저장 성공 |
| Codex 0.158.0 TUI를 Ctrl+C로 종료하고 셸 복귀 | 서버 3개가 남아도 status 대상 없음 |
| 서버만 남은 셸에서 실제 status wrapper와 critical checkpoint 완료 | `noAgent`, generation 2, commit 4로 저장 성공 |

최종 검증에는 `withCodexStatusCheckpoint(true, undefined, () => flushSessionCheckpoint({reason: 'close', requireConclusive: true}))`를 사용했다. 조회·최종 저장·완료 IPC가 모두 실행되며 성공한 종료 fence는 창 파괴 전까지 유지된다. 이 상태에서 추가 begin을 거절한 것은 정상적인 fence 동작이다. 검증 후 dev는 전용 종료 스크립트로 종료하고 다시 기동한다.

실제 `/exit` 문자열과 Enter를 한 번에 보낸 시도에서는 TUI가 종료되지 않고 초안에 남았다. 이를 종료 성공으로 세지 않았으며, 후속 Ctrl+C와 현재 화면·프로세스 확인으로 실제 셸 복귀를 검증했다. 체크포인트 이후 dev 재시작에서는 복원된 TUI가 열릴 수 있으므로 입력 전에 현재 화면을 다시 확인해야 한다.

최종 화면 `.screenshots/screenshot_1790608144755.png`에는 이전 Codex 출력 아래 현재 셸 프롬프트가 보인다. 화면을 직접 확인했으며 과거 출력의 Codex 헤더를 지우지 않아도 provider가 `noAgent`로 저장된다. 증거와 실행 스크립트는 `.tmp/codex-shell-repro/`에 있고 `final-checkpoint.json`은 실제 저장 결과, `final-processes.txt`는 남은 서버 관측이다.

## 회귀 검증과 범위

- `npm run test:wsl-agent-role`: 19개 통과. 수정 전 신규 2개가 서버 PID를 대화로 반환하여 실패했고 수정 후 통과했다. 실제 프로덕션 sh probe를 WSL에서 실행한다.
- `cargo test --lib commands::wsl_agent_session::tests`: 18개 통과. 서버 단독·실제 TUI 공존·실제 TUI 두 개의 모호성을 포함한다.
- `cargo clippy --workspace --all-targets -- -D warnings`: 통과.
- 변경 Rust 파일의 rustfmt와 `git diff --check`: 통과. 전체 fmt 검사에는 이번 diff 밖 `remote_server/font_assets.rs`의 기존 서식 차이가 남아 있다.

실제 업데이트 다운로드·설치 프로그램 실행, 모든 Codex 서브명령, native Windows의 서버 역할 판정까지 검증한 것은 아니다. release 19280에는 접근하지 않았다. 설정 스키마와 화면 검사 조건은 변경하지 않았다.
