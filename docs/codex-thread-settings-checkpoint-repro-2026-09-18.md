# 모델 변경만 한 Codex 빈 대화의 체크포인트 실패

2026-09-18, 기준 `c4f87474`와 `fix/codex-fresh-thread-settings`의 변경을 비교했다. 원래 사용자 오류는 `terminal-pane-98e5f58e: activeButUnidentified`이며 실행 중인 release는 1.0.5였다.

## 원래 pane의 증거

release API·PTY·설정·프로세스는 변경하지 않고 WSL `/proc`와 해당 Codex 진단을 읽었다. Ubuntu-22.04의 Codex 0.154.0 PID 4149329가 해당 terminal marker를 소유했다. 대화 선택 기록의 현재 ID는 `01a0ae7c-4cb2-7370-a6e3-58c9f60b62a2`였다.

- thread/start 기록 141050121 뒤 같은 대화의 ThreadSettings submission 141050430·141050432만 있었다. 각각 모델과 reasoning effort를 변경했다.
- 현재 대화의 rollout 파일과 열린 rollout FD는 없었다. 이전 대화의 Shutdown 기록은 별도 ID에 속했다.
- 설치된 도구와 dev 도구 모두 같은 lifecycle 행 11개를 반환했다. 로그 조회 누락이 아니라 공통 lifecycle 판정이 설정 변경을 입력으로 세는 문제였다.

Codex [0.154.0의 공식 protocol](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/protocol.rs#L599)은 ThreadSettings를 턴 시작 없이 설정을 적용하는 operation으로 정의한다. 기존 코드는 현재 ID에 session-loop 기록이 하나라도 있으면 fresh를 취소했다. ID는 선택됐지만 rollout도 fresh 자격도 없어 통합 귀속이 미식별이 됐다.

v1.0.5 태그는 `0b262d10`이며, 이후의 WSL Claude Chrome 호스트 수정은 v1.0.6에 포함됐다. 그러나 **이번 Codex lifecycle 판정은 v1.0.5와 v1.0.6에서 동일**하다. Chrome 문제나 버전 업데이트만으로 이번 실패를 해결했다고 보지 않는다.

## 같은 사용자 프로세스의 수정 전후 조회

`commands::session_attribution::live_wsl_tests::live_wsl_codex_settings_only_session_is_fresh`는 별도 AppState와 쓰지 않는 가짜 PTY writer만 만들고 실제 production provider lookup·WSL liveness·통합 귀속을 실행한다. 사용자 앱의 PTY에 붙거나 설정을 저장하지 않는다.

```powershell
$env:LAYMUX_TEST_WSL_DISTRO='Ubuntu-22.04'
$env:LAYMUX_TEST_TERMINAL_ID='terminal-pane-98e5f58e'
$env:LAYMUX_TEST_SESSION_ID='01a0ae7c-4cb2-7370-a6e3-58c9f60b62a2'
cargo test --manifest-path src-tauri/Cargo.toml --lib live_wsl_codex_settings_only_session_is_fresh -- --ignored --nocapture
```

테스트 실행 파일 옆에는 같은 빌드의 WSL 보조 바이너리를 스테이징했다. 수정 전에는 `ActiveButUnidentified`로 기대 assertion이 실패했다(1.09초). 수정 후에는 **같은 PID·같은 ID의 Fresh를 독립 조회 두 번 모두 반환**했다(2.66초). 사용자가 실행 중인 1.0.5 앱 자체의 판정을 바꾼 것은 아니다.

## dev 실기

dev 19281만 사용했다. 원래 dev PID 28932에서 실패를 유발했고, 수정 빌드는 PID 41632에서 확인했다. 대화 복원은 재시작한 PID 22040, 빈 대화 복원은 PID 39448에서 확인했다. health의 worktree는 `D:\PycharmProjects\laymux`, 실행 파일은 `target/debug/laymux.exe`이며 수정 빌드 버전은 1.0.7이다.

APPDATA·WebView·Codex 설정과 대화 저장소를 격리했다. native backend와 native CLI는 같은 테스트 CODEX_HOME을 사용했다. WSL CLI는 별도 Linux 테스트 저장소를 사용했으며 재시작 검증에서는 dev WSL 프로필에 그 환경을 명시했다. 인증은 기존 계정을 사용하되 모델 선택은 테스트 설정 파일에만 저장했다.

CDP에서 현재 WebView가 실제로 로드한 Vite 모듈 URL을 사용했다. HMR의 `?t=`를 무시한 import는 별도 Zustand store를 만들 수 있으므로 DOM의 workspace와 실제 PTY 생성도 대조했다. 이 초기 하니스 문제를 제품 실패로 집계하지 않았다.

WSL 재시작용 테스트 환경은 전용 shell wrapper에서 CODEX_HOME·CODEX_SQLITE_HOME을 설정한 뒤 laymux의 Bash 초기화 인자를 그대로 실행했다. 처음에 프로필에 Bash를 중복 지정한 하니스 오류는 수정하고 재실행했다. Codex 자체 업데이트 선택 화면은 설치를 건너뛰고 CLI 초기화와 실제 ID 조회가 끝난 뒤 판정했다.

| 조건 | 결과 |
| --- | --- |
| 수정 전 WSL 새 대화 | fresh와 critical checkpoint 성공 |
| 같은 대화에서 `/model`로 Astra → Sol 선택 | ThreadSettings 기록이 도착한 뒤 activeButUnidentified 및 동일한 critical checkpoint 오류 |
| 수정 후 Windows Astra → Sol | 같은 ID의 ThreadSettings 2건·rollout 부재를 실제 DB에서 확인, fresh·idle 유지 |
| 수정 후 WSL Astra → Sol → Astra | 같은 ID의 ThreadSettings 4건·rollout 부재를 실제 DB에서 확인, fresh·idle 유지 |
| 수정 후 두 pane의 전체 critical checkpoint | 두 번 안정 관측 및 실제 설정 저장 성공, 두 pane 모두 lastAgentFresh=codex |
| 두 pane에서 첫 질문 제출 | 실제 running과 identified로 전환, 각각 LX_SETTINGS_OK 응답과 completed 확인 |
| 첫 질문 완료 뒤 전체 critical checkpoint | 정확한 두 session ID를 저장하고 fresh 필드 제거 |
| dev 재시작 후 답변 있는 대화 복원 | Windows·WSL 모두 이전과 같은 session ID·completed·LX_SETTINGS_OK 기록 확인, 전체 critical checkpoint 성공 |
| 복원한 대화에서 `/clear` 후 다시 모델 변경 | 두 새 ID 각각 ThreadSettings 2건·rollout 부재 확인, 두 pane 모두 fresh로 저장 |
| 모델을 변경한 빈 대화 저장 후 dev 재시작 | Windows Astra·WSL Sol 모두 새 빈 session ID·fresh·idle, 전체 critical checkpoint 성공 |

답변 있는 대화의 ID는 Windows `01a0b269-a343-7922-aaf9-a4df5eeb95ca`, WSL `01a0b269-5dfe-7ee3-8e15-b55c8fb8871a`이며 재시작 전후 일치했다. 빈 대화 저장은 `lastAgentFresh=codex`와 session ID 제거를 실제 settings.json에서 확인했다. 다시 켠 뒤에는 각각 `01a0b279-7b56-7201-88a7-774821fc40ee`, `01a0b279-7dd2-7c32-bb9f-4f287e2c86d9`의 새 빈 대화가 시작됐다.

첫 질문은 도구·파일 접근 없이 고정 문자열만 응답하도록 했다. 상태값과 store를 합성하지 않았으며 모델 선택은 실제 PTY 키 입력이었다. 화면 증거는 dev 스크린샷과 실제 xterm 셀로 확인했다. 이 검증에서 설치 프로그램은 실행하지 않았다.

## 자동 검증

- 설정 변경 뒤 fresh를 기대하는 회귀 테스트의 RED를 먼저 확인했다.
- Codex Rust 테스트 42개 통과. native·guest, DELETE·WAL, 로그 정리와 rollout 부재·정상·손상·중복·만료 조합 1,400개를 포함한다.
- 통합 귀속 테스트 17개 통과. 명시적 실기용 ignored 테스트는 위 절차로 별도 실행했다.
- UI 저장·snapshot 테스트 120개 통과.
- Rust strict workspace/all-targets clippy, dev 앱 빌드, rustfmt·diff 검사와 릴리즈 채널 테스트 통과.
- 1차 독립 코드 리뷰: P1·P2·Nit 지적 없음.

로컬 상세 자료는 `.tmp/attribution-98e5f58e-20260918/`의 `installed-rows.json`, `dev-*.json`, `source-settings-*.json`과 실행 스크립트에 있다. 수정 전 화면은 `.screenshots/screenshot_1789699302397.png`, 답변 있는 대화 복원은 `screenshot_1789700603141.png`, 빈 대화 복원은 `screenshot_1789700730634.png`다. 화면은 직접 열어 두 pane의 실제 내용을 확인했다. 로컬 자료와 인증 파일은 git에 포함하지 않는다.

ADR: [0256](adr/0256-codex-thread-settings-preserve-fresh.md). 정확한 ThreadSettings만 예외로 인정하며 입력·종료·resume·미확인 기록·rollout 검증 실패의 보호는 유지한다.
