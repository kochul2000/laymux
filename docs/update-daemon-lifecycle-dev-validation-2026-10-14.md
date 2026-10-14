# 업데이트 준비와 명시적 종료의 dev 검증

- 날짜: 2026-10-14
- 대상: PR #1187, `fix/update-daemon-checkpoint`, 실행 바이너리 빌드 commit `35bf570493d135bd2a69b37d40c81da1c03d95c2`
- ADR: [0323](adr/0323-update-checkpoint-follows-pty-ownership.md)

실제 Codex에 CLI override를 준 동일한 조건에서 **업데이트는 대화 확인·Ctrl+C 없이 저장했고, 명시적 종료는 기존 대화 확인을 실행해 CLI override 오류로 중단했다.** 업데이트 인계 후 같은 데몬 세션·프로세스·미전송 초안이 새 GUI에 이어졌고, 정상 명시적 종료에서는 Ctrl+C 정리와 PTY 종료가 실행됐다.

## 환경과 측정

Windows native dev 19281, 실제 Codex CLI 0.162.1과 PowerShell pane 두 개를 사용했다. health의 dev 빌드, 실행 파일 경로, worktreeRoot, gitCommit, gitBranch를 대조했다. `APPDATA`·`LOCALAPPDATA`·`WEBVIEW2_USER_DATA_FOLDER`는 작업 트리의 `.tmp/update-dev/` 아래로 격리했다. `VITE_LAYMUX_STRICT_MODE=0`으로 release와 같은 mount 수명으로 실행했다. 테스트용 CODEX_HOME은 별도 폴더이며 사용자 설정·훅을 수정하지 않았다.

첫 pane에서 `codex --no-alt-screen -c model_reasoning_effort=low`를 실행하고 `UPDATE_KEEP_DRAFT`를 제출하지 않은 채 입력했다. 두 번째 pane은 PowerShell 루프로 400ms마다 PID·tick·시각을 파일에 기록하고 터미널에 출력했다. 모델 요청은 제출하지 않았다. 이 Codex의 읽기 기반 귀속은 `fresh`, 두 번째 pane은 `noAgent`였다. 미식별 데몬 대화는 별도 자동 회귀 테스트가 검증한다.

업데이트는 실제 `app_update_install::prepare`를 호출하는 dev `POST /api/v1/dev/update-handoff`의 `{"mode":"prepare"}`를 사용했다. backend fence/drain·실제 native 요청·제품 frontend listener·SQLite 저장·출력 캐시·ACK를 모두 통과한다. 성공 IPC나 판독 결과를 mock하지 않았다. 기존 `installer` 모드는 별도로 호출해 실제 설치 직전 teardown과 GUI `process::exit(0)`을 실행했다.

계측은 실제 WebView2 CDP의 `Debugger.setBreakpointOnFunctionCall`로 Tauri invoke를 관측하고 즉시 resume했다. payload는 command·request ID·terminal ID·진행 상태만 기록했다. native checkpoint 이벤트와 update status 이벤트도 별도로 구독했다. 스크린샷은 dev screenshot API로 캡처하고 실제 이미지를 확인했다.

## 확인 결과

| 경로 | 실제 관측 | 결과 |
| --- | --- | --- |
| CLI override Codex가 있는 명시적 창 닫기 | `begin_app_close` → `begin_codex_status_checkpoint` → 기본 설정/CLI override 오류 | 종료가 중단되고 종료 취소 가능. 초안 유지 |
| 같은 Codex와 긴 작업이 있는 업데이트 준비 | native request ID 1, `requireConclusive=false`, `terminalIds=[]` | 성공, SQLite commit revision 7 |
| 업데이트 단계와 IPC | checkpoint → caching 4/4 → ACK. Codex 확인·상태 입력·`interrupt_terminal_on_exit` 호출 0회 | 저장·출력 캐시는 유지하고 종료 전용 단계는 생략 |
| GUI가 없는 인계 구간 | 이전 GUI PID 47360 종료. Codex PID 29672와 셸 PID 67304·28712 생존 | tick 439 → 498 증가 |
| 새 GUI 재결합 | GUI PID 17012. 데몬 `g3-8afc8d2a0492`, sessionId, childPid 동일. attachEpoch 증가 | 두 pane 모두 adopted 로그, Codex 프로세스 시작 시각 동일, 초안 유지, tick 662까지 증가 |
| 정상 명시적 창 닫기 | 테스트 Codex 종료 후 긴 작업이 있는 상태에서 실제 window.close 요청 | checkpoint → interrupting → settling → caching → closing |
| 명시적 종료의 정리 | 두 terminal에 Ctrl+C 3회씩, 총 6회. `close_terminal_session` 두 호출 | GUI와 두 셸 종료. tick은 811에서 멈추고 계속 증가하지 않음 |

업데이트 IPC 순서는 `save_session_checkpoint` → `save_terminal_output_cache` → 최종 캐시 진행 → `acknowledge_session_checkpoint`였다. 업데이트 API 응답에는 `checkpointCommitId:7`, `preparation:{stage:"caching",completed:4,total:4,warning:null}`이 있었다. 준비 후 업데이트 상태는 idle로 복귀했고 후속 명시적 종료 요청이 정상 수락됐다.

인계 전후 데몬 세션은 다음과 같았다. GUI 종료 완료 뒤에도 증가한 파일 tick을 확인했으므로, 이전 화면·출력 캐시만으로 생존을 추정하지 않았다.

| pane | sessionId | childPid | 재결합 |
| --- | --- | --- | --- |
| Codex | `terminal-pane-900c221a#1-e9bb48b8873f4e2aa17b201715de5890` | 67304 | 동일 세션·동일 셸·동일 Codex PID 29672 |
| 긴 PowerShell 작업 | `terminal-pane-cd81a057#2-f46bcc1b19f34da2a5f89d131a90e1c0` | 28712 | 동일 세션·tick 연속 증가 |

## 증거와 범위

- `.tmp/update-dev/evidence/`: health, native 요청·상태·SQLite snapshot, 준비 결과, IPC JSONL, 인계 전후 프로세스·PTY inventory·tick, 재검증 summary를 저장했다.
- `.screenshots/screenshot_1791941401321.png`: 실제 명시적 종료 실패 화면. 작업 정리·터미널 기록 저장·앱 종료 단계가 남아 있고 CLI override 오류가 표시된다.
- `.screenshots/screenshot_1791941607567.png`: 새 GUI에 재결합한 실제 Codex 초안과 계속 증가하는 PowerShell tick.
- 재검증 스크립트는 준비의 확인·인터럽트 호출 0회, 저장→캐시→ACK 순서, GUI PID 변경, 데몬/session/child PID 및 Codex 시작 시각 일치, 초안 보존, 인계 동안 tick 증가, 명시적 종료의 5단계와 Ctrl+C 6회, 종료 후 tick 정지를 assert했다.
- 추가 dev 준비 guard 테스트 3개와 updater 관련 27개가 통과했고 `cargo clippy --lib -- -D warnings`도 통과했다. 기존 PR의 UI 160개, checkpoint 29개, 실제 데몬 adoption 20개 검증을 합하면 관련 자동 테스트는 236개다.

실제 release 설치기의 다운로드·서명 검증·파일 교체와 Linux 실행은 이 검증에 포함하지 않는다. 내부 PTY fallback의 미확인 귀속 차단은 이번 dev 실측 대신 실제 handle 분류와 frontend critical 회귀 테스트로 확인했다. 검증 뒤 테스트 Codex·긴 작업·dev GUI를 종료하고 복제한 인증 파일을 삭제했다. release 19280은 조작하지 않았다.
