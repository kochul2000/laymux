# 미진입 pane의 업데이트 attribution 거부 재현

2026-09-05, base `167ecb8a` (v0.12.12).

## 관측과 구분

사용자가 보고한 `terminal-pane-f271a8cf`는 MCP에서 ai-inference workspace의 WSL Codex로 표시됐다. 출력 cache만으로 실행 여부를 단정하지 않고 WSL `/proc`을 읽었다. 현재 Codex PID 64981이 존재했고 `codex --yolo`로 실행 중이었다. 해당 PID에는 rollout FD가 없고 thread-writer lock FD만 있었다. lock의 UUID와 일치하는 sessions 파일도 조회되지 않았다. 이는 기록 파일 부재의 관측이지 메모리에 대화가 없다는 증명은 아니다. 사용자 pane에는 입력·종료·설정 변경을 수행하지 않았다.

미진입은 UI 포커스 상태이고 미기동은 PTY 수명 상태다. 둘을 같게 취급해 live terminal을 checkpoint coverage에서 빼면 실제 데이터 손실을 숨길 수 있다.

## 실행 가능한 테스트

- `persist-session.test.ts`: 기존 미기동 pane은 저장된 resume ID를 보존하고 critical update 통과. unfocused live Codex는 frontend instance 없이 backend의 `activeButUnidentified`만으로 3회 연속 같은 오류를 재현하며 saveSettings를 호출하지 않는다. 입력 전 명시적 복원의 `restorePending`은 기존 ID 보존·critical 성공, 두 관측 사이 generation/ID/state 변화는 거부한다. 파일 전체 78개 통과.
- `wsl_agent_session/tests.rs`: rollout 행 없는 Codex process probe 결과는 provider 부재가 아닌 live Codex로 선택된다.
- `ui/scripts/repro-unvisited-attribution.mjs`: 격리 dev(19281, PID 30924, 기대 worktree/commit 대조)에서 미방문 workspace를 만들고 PTY 없는 critical checkpoint 통과를 확인했다. 이어 rendererless WSL PTY를 만들고 comm 이름만 Codex인 모사 프로세스를 실행했다. provider 네트워크 호출·대화 제출 없이 실제 WSL probe → Rust attribution → frontend critical checkpoint를 통과시켜 같은 오류를 유발했다. neverFocused=true, noPtyCovered=false, attribution=activeButUnidentified/codex였다. 설치 프로그램은 호출하지 않았다. 테스트 PTY와 dev는 종료했다.

## 현재 수정 경계

현행 ADR-0222는 live agent의 복원 ID를 확정하지 못하면 업데이트를 중단한다. 파일이 없다는 이유만으로 `NoAgent`나 성공을 반환하면 이 안전 계약을 깨뜨린다. 저장 가능한 세션을 추가 증거로 정확히 찾는 adapter 수정은 가능하지만, 이번 live 관측에는 검증할 rollout 파일 자체가 없었다.

이번 수정은 backend가 검증한 명시적 resume 요청을 PTY handle에 보관한다. 첫 비프로토콜 입력 또는 정확한 귀속/다른 provider/충돌 관측으로 소비하기 전에는 이전 요청을 `restorePending`으로 보존한다. 일반 저장과 critical 이중 안정 관측이 같은 판정을 사용한다. 방문 여부·시간·파일 부재만으로 임의 CLI를 성공 처리하지 않는다.

실행 중 미식별 상태의 예외는 정확한 WSL Codex process가 선택됐고 rollout FD가 없는 경우에만 적용한다. 다른 provider/native 및 materialized 후보 검증 실패는 기존 차단을 유지한다. 다른 pane의 pending/identified ID와 충돌하는 pending 요청도 거부한다.

ADR: [0232](adr/0232-unconsumed-resume-checkpoint.md). 기존 startup 대기의 제한 시간 의존을 명시적 복원 요청·입력 증거로 보완한다.

## 수정 후 dev 검증

격리 APPDATA `.tmp/unconsumed-resume-dev`, dev 19281/PID 84528, worktree `D:\PycharmProjects\laymux`, base `167ecb8a` + 이 브랜치 working diff로 검증했다. fixture는 `ui/scripts/fixtures/idle-codex.py`이며 configured Codex command로 등록한 뒤 실제 create IPC에 `resume saved-unvisited-session`을 전달했다. provider/API는 호출하지 않으며 실제 Codex 버전의 파일 생성 시점을 재현했다고 주장하지 않는다.

- frontend 미등록·미방문 pane의 PTY가 실제 WSL에서 fixture를 실행하고 READY 출력 발생.
- 17초(기존 startup grace 초과) 뒤 backend `restorePending`과 이전 ID 확인.
- 실제 critical checkpoint 성공, settings 파일을 재로드해 이전 ID 저장 확인.
- protocol reply 후에도 `restorePending` 유지.
- 실제 입력 IPC 후 `activeButUnidentified` 전환, critical checkpoint는 원래 오류로 거부.
- 테스트 PTY는 finally에서 종료, dev는 공식 kill-dev 스크립트로 종료. release와 installer는 조작하지 않았다.

최종 검증: 전체 UI 232파일 4,866 tests, Rust command 450 tests, strict clippy(all-targets, warnings deny), UI build/tsc 및 변경 UI/script eslint 통과. 중복/모호성 보호 보강 후 dev PID 50376에서 같은 시나리오를 재실행해 모두 통과했다. 사용자 원본 PID는 `codex --yolo`였으므로 이 변경의 명시적 resume 조건을 충족했다는 증거는 없다. 그 pane의 실제 과거 복원 실패/입력 타임라인과 이번에 고친 경로를 동일 원인으로 확정하지 않는다. 신규 CLI가 파일 없이 남는 상황은 계속 보호 차단 대상이다.

재실행: 임시 APPDATA·WEBVIEW2_USER_DATA_FOLDER를 지정하고 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9229로 dev를 실행한다. Windows `ui/`에서 LAYMUX_REPRO_ISOLATED=1을 지정하고 `node scripts/repro-unvisited-attribution.mjs`. dev 종료는 같은 APPDATA로 `bash scripts/kill-dev.sh`를 쓴다. 테스트는 workspace와 Codex command 설정을 변경하므로 사용자 일상 dev 프로필에서 실행하지 않는다.
