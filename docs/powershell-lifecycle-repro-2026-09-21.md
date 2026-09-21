# PowerShell 연속 명령 상태 재현과 수정 검증

[#1058](https://github.com/kochul2000/laymux/issues/1058)을 Windows PowerShell 5.1.26100.9444의 실제 ConPTY와 dev WebView에서 확인했다. 결정은 [ADR-0262](adr/0262-powershell-command-lifecycle.md)다.

## 환경과 재현

- 수정 전: main `12707ed9483fb451a007a30fe99d20d80d691aeb`.
- 수정 후 최종 구현: `61ffe306` (`fix/1058-powershell-lifecycle`).
- health의 `buildKind=dev`, `port=19281`, `worktreeRoot=D:\PycharmProjects\laymux`, 실행 파일 `target/debug/laymux.exe`, `gitCommit`을 각 빌드와 대조했다.
- `.tmp/issue-1058/appdata`와 `webview`로 설정·브라우저 데이터를 격리했다. 기존 Vite 포트 사용과 충돌하지 않도록 이 검증의 Vite는 1421이며 Automation은 정본 19281이다. release는 조작하지 않았다.
- 새 PowerShell pane(`powershell.exe -NoLogo`)에서 `Write-Output FIRST_DONE` 완료 후 `Write-Output SECOND_START; Start-Sleep -Seconds 8; Write-Output SECOND_DONE`을 실행했다.
- 입력은 실제 PTY에 본문과 CR을 별도로 전송했다. 250ms 간격으로 store의 task·출력 활동·공통 정책·알림과 실제 xterm inspector를 읽고, 실행 중 Automation screenshot을 캡처했다. 상태값이나 lifecycle 이벤트를 주입하지 않았다.

## 수정 전 결과

`SECOND_START`가 실제 화면에 있고 아직 `SECOND_DONE`과 다음 프롬프트가 없을 때에도 `task=ended/success/confirmed`, `taskId=0`, `outputActive=false`, 선택기 ✓였다. 같은 시점 `clearAllowed=true`, `inhibitSleep=false`였다. 프롬프트가 돌아와야 sequence만 증가했다.

로컬 trace: `.tmp/issue-1058/run-windows-1789983018669.json`. 실행 중 화면: `.screenshots/screenshot_1789983011984.png`.

## 수정 후 결과

| 시나리오 | 관측 |
| --- | --- |
| 새 통합 PowerShell 프롬프트 | idle/confirmed, 대시, 알림 없음 |
| 첫 명령 완료 후 두 번째 8초 대기 | 새 taskId의 running/confirmed, 무출력 동안 ⏳, clear 차단·자동 절전 억제 |
| 실제 프롬프트 복귀 | ended/success, ✓, 해당 작업 완료 알림 1회, clear 허용·자동 절전 억제 해제 |
| `Write-Error`와 native `exit 7` | failure/✗, 실패 알림 각각 1회 |
| native 실패 뒤 성공한 cmdlet | success/✓, 과거 `$LASTEXITCODE`를 결과로 재사용하지 않음 |
| 빈 Enter와 주석 | 이전 taskId·sequence·결과·알림 개수 유지 |
| 여러 줄의 완성된 블록을 연속 전송 | 실행 단위당 시작/종료 1회 |
| `begin { ... }` | 새 taskId와 정상 종료 |
| 실행 중 Ctrl+C | 결과 없는 ended/대시, 성공을 합성하지 않음 |
| WSL Bash 대조군의 `sleep 8; (exit 7)` | running/⏳ → failure/✗ 유지 |
| CMD의 무출력 대기 | task 미확인·대시 유지 |
| CMD에서 raw PowerShell 출력 후 대기 | task는 계속 미확인, 출력 중만 ⏳, 출력 해제 후 대시 |

첫 수정 dev 실측에서 두 번째 제출 약 0.261초에 running, 약 8.103초에 success로 바뀌었다. 이 값은 250ms 표본의 관측 시점이지 처리 지연 상한이 아니다. 동시 PowerShell·Bash·CMD 화면은 `.screenshots/screenshot_1789983696115.png`다. 최종 구현의 시나리오별 trace와 자동 assertion 결과는 `.tmp/issue-1058/final-summary.json`에 기록했다. 로컬 JSON/스크린샷은 git에 포함하지 않는다.

## TDD와 자동 검증

```powershell
cargo test -p laymux --test powershell_lifecycle -- --test-threads=1
cargo test -p laymux --lib terminal:: -- --test-threads=4
cargo clippy -p laymux --test powershell_lifecycle -- -D warnings
```

`src-tauri/tests/powershell_lifecycle.rs`는 mock 없이 실제 ConPTY와 생성된 통합 스크립트를 사용한다. 입력 편집·공백/주석/구분자·멀티라인·한 번의 여러 줄 전송·연속 실행·native/cmdlet 실패·이전 `$LASTEXITCODE` 보존·중단과 PSReadLine 없는 경로를 검증한다. 테스트 셸은 history 저장을 끄고 Drop에서 PTY를 종료한다.

- 수정 전 3개 모두 실패: 실행에서는 기대한 C 없이 D만 수신, PSReadLine 없는 경로에서도 D가 생성됨.
- 구현 후 3개 통과. 추가한 `begin` 사례는 최초 구현에서 C/D가 모두 없어 실패했고 입력 토큰 판정으로 수정한 뒤 통과.
- 관련 Rust 단위 테스트 80개, UI 테스트 160개 통과. UI 범위는 `useSyncEvents`, `terminal-task`, `terminal-task-observers`, `terminal-task-presentation`, `codex-turn-subscription` 5개 파일이다.
- clippy `-D warnings`, 변경 Rust 파일 rustfmt, `git diff --check` 통과. 최종 구현 커밋으로 `cargo tauri dev --no-watch` 빌드·기동 성공.

## 검증 한계

PSReadLine 없는 PowerShell은 별도 실제 PowerShell 프로세스에서 OSC 7만 나오는 것을 검사했다. 이 경로와 CMD는 조용한 작업을 추론하지 않으며 clear의 기존 best-effort 예외가 남는다. 실행 후 reader/prompt를 사용자가 재정의하는 경우는 지원 범위 밖이다. pwsh/Linux PowerShell 실기는 수행하지 않았다. Claude/Codex 확인된 idle은 관련 UI 회귀 테스트로 검증했으며 이번 실기에서 실제 에이전트를 새로 실행하지 않았다. OS 클립보드 붙여넣기 대신 실제 PTY에 여러 줄을 한 번에 전송했다.

## 제한 언어 리뷰 반영과 v1.0.11

추가 회귀 테스트는 PSReadLine을 로드한 별도 PowerShell 프로세스에서 `LanguageMode=ConstrainedLanguage`로 전환한 뒤 통합 스크립트를 파싱한다. 대화형 입력 부분만 고정 문자열을 반환하는 원래 reader로 대체하고 나머지는 실제 PowerShell 엔진에서 실행한다. `$ErrorActionPreference='Stop'`에서 수정 전 `CannotCreateTypeConstrainedLanguage`로 입력 반환이 중단되는 실패를 확인했다.

설치 조건에 `FullLanguage` 가드를 추가한 뒤 원래 reader 객체·반환 명령·실제 명령 실행과 OSC 7 두 번을 확인했다. stderr와 OSC 133은 없었다. 기존 실제 ConPTY 시나리오를 포함한 4개 테스트가 모두 통과했다. 이는 언어 모드의 동작 검증이며 실제 AppLocker/WDAC 정책 배포 시험은 아니다.

사용자의 수정·머지·릴리즈 요청에 따라 ADR-0262를 Accepted로 전환하고 Cargo·Tauri·lockfile 버전을 1.0.11로 맞췄다. 릴리즈 버전·채널 정책은 기존 ADR-0190/0240을 그대로 적용하며 새 설계 결정은 추가하지 않는다.
