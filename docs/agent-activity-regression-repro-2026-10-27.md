# Windows·WSL 에이전트 activity·작업 상태 재회귀 조사

## 제보와 관측

v3.4.1(HEAD `d3095170`)에서도 WSL Remote Codex가 작업 미확인으로 돌아왔고, Windows·WSL Codex/Claude의 activity 식별까지 사라졌다는 제보를 받았다. 사용자는 정상 식별 후 재회귀하며 1분 재확인을 의심한다고 특정했다.

사용자가 지목한 `v3-ai-0`은 `ws-default`이며, 첫 pane은 `terminal-pane-2f4685c5`(당시 Codex), 둘째는 `terminal-pane-f5748845`(당시 Claude)였다. 조사 초기에 두 pane의 frontend activity가 각각 Codex·Claude인 스냅샷과, 뒤에 둘 다 shell인 스냅샷을 확보했다. generation은 각각 9·10으로 같았다. 다른 WSL pane도 같은 구간에 shell로 내려갔다. 직접 읽은 게스트 생존 프로브는 첫 pane의 Codex PID 2962760, 둘째 pane의 Claude PID 2759를 같은 terminal marker로 찾았다.

후속 읽기 전용 시계열(2026-10-27 08:10:31–08:12:12 UTC)에서는 두 pane의 backend·frontend 앱 식별이 유지됐다. 이 구간의 60초 전체 재발행에서도 새 shell 강등은 없었다. 첫 pane의 작업 상태는 계속 미확인이었다. 이후 부하 검증 시에는 둘째 pane의 실제 앱이 Codex로 바뀌어, 검증도 그때의 생존 프로세스와 대조했다.

원본 스냅샷·시계열·프로브 결과는 로컬의 git 제외 디렉터리 `.screenshots/agent-state-20261027/`에 보존했다. 사용자 대화와 원시 훅 내용은 이 문서에 싣지 않는다. 조사 중 사용자 pane에 입력·resize·interrupt를 보내거나 앱을 종료하지 않았다.

## 확인한 결함과 인과관계의 한계

1. `detect_terminal_state`가 출력 버퍼 없음·빈 버퍼를 먼저 반환하여, 살아 있는 프로세스가 있어도 shell로 분류할 수 있었다. 최근 ring의 다른 앱 제목이 실제 생존 프로세스보다 우선하는 경우도 있었다.
2. activity 재판정은 직전 에이전트가 후보에서 사라지면 프로세스 관측의 `Unknown`·`Ambiguous`를 구분하지 않고 종료 정리까지 실행했다. Codex live 제목 식별자를 지워, 앱이 다시 식별돼도 조용한 대화의 작업 복구 증거를 잃을 수 있었다. 60초 전체 재발행도 이 후보를 frontend로 보낼 수 있었다.

두 결함은 수정 전 실패하는 결정적 테스트로 고정했다. 다만 release 프로세스의 해당 실패 순간 liveness cache·ring 내용·로그는 확보하지 못했다. 따라서 당시 강등이 프로브 실패, 빈 ring, 또는 다른 경로 중 무엇에서 시작했는지는 확정하지 않는다. 작업 상태 60초 재조회와 activity 60초 전체 재발행은 독립된 타이머이며, 단순히 같은 주기라는 이유로 전자를 원인으로 단정하지 않는다.

## 수정과 검증

[ADR-0359](adr/0359-agent-reconcile-requires-exit-evidence.md)에 따라 생존 프로세스를 출력 스캔보다 우선하고, 미확인 패스는 직전 에이전트의 diff 기준만 보존해 발행·종료 정리를 보류한다. 확인된 종료와 다른 프로세스로의 handover는 기존 정리를 수행한다. 작업 상태를 유휴·성공으로 합성하지 않는다.

`replay_frontend_wsl_polling_load`는 이미 실행 중인 게스트의 marker를 읽으며 실제 PTY를 생성·연결·입력·종료하지 않는다. 테스트 바이너리의 부모 디렉터리(`target/debug/deps/`)에도 동일한 bundled WSL Codex probe를 배치해야 실제 진단 부하가 포함된다. 헬퍼 없이 실행한 초기 결과는 이 검증으로 세지 않았다.

헬퍼를 배치한 65초 부하 검증에서 턴 59회·훅용 귀속 31회·기록 59회·liveness 18회·critical checkpoint 4회 조회를 실행했다. 18회 모두 당시 실제 생존 앱과 출력 없는 공통 detector의 식별이 일치했다. 이 검증은 정상 guest의 동시 조회와 빈 출력 경로를 확인한다. 프로브 실패 시 전체 재발행 보류·뒤이은 실제 종료·provider 전환은 별도 결정적 회귀 테스트가 검증하며, 이 부하 결과를 제보 당시 장애 주입 재현으로 해석하지 않는다.

```powershell
Copy-Item target/debug/laymux-wsl-codex-probe target/debug/deps/laymux-wsl-codex-probe
$env:LAYMUX_TEST_WSL_DISTRO = 'Ubuntu-22.04'
$env:LAYMUX_TEST_LOAD_PANES = '<이미 실행 중인 terminal marker를 쉼표로 연결>'
$env:LAYMUX_TEST_LOAD_SECONDS = '65'
cd src-tauri
cargo test --lib replay_frontend_wsl_polling_load -- --ignored --nocapture
```

## dev 인스턴스의 실제 파이프라인 검증

같은 워크트리에서 StrictMode를 끄고 `cargo tauri dev`로 실행했다. health에서 dev(19281), 실행 경로, 브랜치·기준 커밋을 대조했다. Windows·WSL 각각 Codex·Claude 이름의 프로세스와 실제 PTY를 만들고, 관리 OSC 제목·Codex rollout·WSL 진단 DB를 생성하는 격리 fixture를 사용했다. provider API와 사용자 자격 증명은 호출하지 않는다.

- 32 KiB 출력으로 초기 제목을 최근 출력 창에서 밀어냈다. 검증용 WSL pane 두 개의 배포판 정보만 기존 local IPC로 없는 배포판으로 바꾸어 실제 생존·귀속 프로브 실패를 만들었다. 80초·40회 관측 동안 네 pane의 frontend 앱 식별이 유지됐고 60초 전체 재전파에서도 shell로 내려가지 않았다. 이때 backend의 출력 fallback은 실제로 shell을 반환해, 장애가 주입됐음을 별도로 확인했다.
- 배포판 정보를 복구한 뒤 새 OSC 제목 없이 Codex 대화 식별자와 완료 상태가 복구됐다. 무출력 `task_started` 기록으로 두 환경 모두 running으로 전환됐다.
- 실제 Remote 페이지를 Edge의 430×900 viewport에서 열어 네 pane 행의 provider 표시를 확인하고 screenshot을 저장했다. 취득한 lease와 변경한 dev runtime access만 원복했다.
- `kill-dev.sh`로 GUI만 종료하고 재기동한 두 번의 검증에서 같은 child PID·daemon session ID가 유지되고 attach epoch가 증가했다. 추가 검증에서는 재부착 뒤 입력 없이 65초 동안 앱 식별과 Codex running 상태가 유지됐다. 이후 완료 기록과 fixture 실제 종료가 각각 완료·shell로 반영됐다.
- 검증 workspace를 닫고 이전 workspace로 복귀한 뒤 dev GUI를 `kill-dev.sh`로 종료했다. release(19280)는 이 검증에 사용하지 않았다.

재현 하네스는 `scripts/tests/agent-activity-recovery.e2e.mjs`다. `setup` → `fault` → `remote` → GUI 종료·동일 환경 재기동 → `reattach` → `cleanup` 순서로 실행한다. 장애 없이 재부착만 재검증하려면 `setup` → `prepare` → 재기동 → `reattach` → `cleanup`을 쓴다. CDP는 9342, dev URL은 1420이며 Windows에서 실행한다. 프로필이 기본 배포판과 다른 WSL을 지정하면 `LAYMUX_TEST_WSL_DISTRO`를 맞춘다. `fault`는 실패하더라도 배포판 정보를 finally에서 원복한다.

dev 원본 자료는 `.screenshots/agent-state-20261027/dev-e2e/`의 `fault-and-reattach-result.json`, `quiet-reattach-result.json`, 두 timeline과 screenshot에 남겼다. 제보 당시 release에서 관측 실패가 처음 발생한 정확한 원인은 여전히 미확정이다. 이 검증은 실패의 재전파와 복구 증거 소실을 막는 변경을 확인하며, CLI 자체의 모든 기록 형식이나 장기 guest 장애까지 검증했다는 뜻은 아니다.

## 독립 리뷰와 최종 확인

PR #1262의 독립 리뷰는 P1 없이 P2 한 건을 지적했다. 두 패스 사이 같은 terminal ID의 PTY가 교체되는 경우를 기존 한 패스 시작·끝 검사만으로는 잡지 못했다. 발행 기준과 generation을 함께 보관하고 보류 판정 전에 불일치 기준을 폐기하도록 수정했다. 수정 전 해당 회귀 테스트의 실패를 확인했고 같은 세대의 보존과 새 세대의 별도 발행을 함께 검증했다.

수정 후 Rust library 전체 2704개 통과·명시적 live 테스트 12개 제외, clippy `--lib --tests -- -D warnings` 통과를 확인했다. 같은 dev에서 80초·40회 관측 실패, 새 제목 없는 Codex 복구, Remote 네 provider 표시와 확인된 실제 종료를 다시 검증했다. 최종 dev 원본은 `review-fix-dev-result.json`과 `fault-after-review.log`, `rust-all-after-review.log`에 보존했다. 프론트 구독·복구·동기화 이벤트 테스트는 Windows에서 133개 통과했다.
