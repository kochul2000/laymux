# Windows·WSL 에이전트 종료 조합 검증 (2026-09-29)

## 원인과 수정

사용자가 보고한 WSL 셸 pane에는 TUI 대신 `codex app-server`가 남아 있었다. 서버가 상속한 pane marker와 실행 파일 이름 때문에 서버를 현재 대화로 오인했다. dev에서 같은 오류를 재현했으며 Windows PowerShell의 자식 서버에서도 동일하게 재현했다.

native snapshot과 WSL 세션 귀속·liveness는 명시적인 `argv[1] == app-server`를 대화 후보에서 제외한다. PID·PPID 연결과 실제 TUI의 후보 자격은 유지한다. cmdline을 확인할 수 없거나 인자가 유사할 뿐인 경우에는 제외하지 않는다. WSL 서버의 rollout FD도 대화 증거로 수집하지 않는다.

ADR: [0280 — Codex app-server 프로세스 역할](adr/0280-codex-app-server-process-role.md). 상태 소유권과 역할 검사 경계의 결정은 ADR에, 현재 흐름은 [data-flow §13](architecture/data-flow.md)에 기록했다.

혼합 pane 실측에서는 좁은 Codex 메뉴의 `show current session configuration` 설명이 여러 줄로 나뉘어 Status 선택 검사가 시간 초과되는 추가 결함을 찾았다. 같은 선택 항목의 설명 열에 정렬된 후속 줄만 이어 읽도록 고쳤다. 다음 명령·composer·선택되지 않은 항목은 합치지 않는다. 이 지역적인 파서 수정은 [ADR-0278](adr/0278-codex-status-current-screen.md)의 현재 화면·builtin 선택 검증을 그대로 적용하며 새 계약을 만들지 않는다.

## 실행 방법과 판정

- Windows, Ubuntu-22.04 WSL에서 실제 Codex 0.157.1과 Claude Code 2.1.283을 실행했다. 초기 원인 재현에는 Codex 0.158.0도 사용했다.
- dev Automation 19281의 PID·worktreeRoot를 매 실행 확인했다. Vite는 현재 작업 트리의 1423을 사용하고 사용자 release 19280에는 접근하지 않았다.
- 각 테스트는 고유 pane marker, 별도 APPDATA·WebView 프로필, 별도 Codex 홈·작업 디렉터리를 사용한다. 기존 사용자 설정과 대화를 수정하지 않는다.
- 실제 Tauri 창의 close 이벤트를 발생시키고 lifecycle 상태, xterm 셀, 저장된 view, 종료 후 TUI 프로세스를 확인했다. API 연결이 끊긴 사실만으로 성공 처리하지 않는다.
- `completed`는 모델이 `MATRIX_OK`를 실제 출력한 뒤 checkpoint의 UUID를 확보한다. `resume`는 그 CLI를 종료하고 같은 UUID로 재개한 뒤, 종료 시 저장한 ID와 비교한다. 앱 재시작의 자동 복원을 실측했다는 의미는 아니다.
- `working`은 실제 `esc to interrupt` 화면을 확인한다. Codex는 확인 불가 상태에서 종료를 막고, 취소로 입력을 복구한 뒤 테스트 작업을 끝내면 재시도로 종료한다. Claude는 기존 세션 ID를 저장하고 종료한다.
- 일반 종료 후 실제 TUI가 없어지는지 최대 15초 동안 확인한다. TUI와 수명이 다른 app-server의 생존을 TUI 생존으로 계산하지 않는다.
- 테스트 인스턴스 정리는 `bash scripts/kill-dev.sh`만 사용했다. 별도 Codex 홈으로 만든 테스트 서버 정리는 홈·marker 또는 PID·생성 시각을 대조했다.

실행 스크립트는 `.tmp/codex-shell-repro/matrix.mjs`, 판정기는 `audit.mjs`, 각 결과는 `.tmp/close-matrix/<host>-<provider>-<state>-<cleanup>/result.json`에 남겼다. 임시 실행 증거는 버전 관리하지 않으며 재현 가능한 프로덕션 probe 회귀 검사는 `scripts/tests/wsl-agent-role.test.mjs`에 있다.

## 기본 56개 조합

Windows·WSL × Codex·Claude × 아래 7개 상태 × `exit.interruptTerminals` on/off의 56개를 모두 통과했다. 실패 차단이 기대값인 경우에는 차단 자체와 취소·재시도 종료를 함께 확인했다.

| 상태 | Codex (Windows·WSL, on/off) | Claude (Windows·WSL, on/off) |
| --- | --- | --- |
| 새 대화 대기 | 정상 종료, Fresh 저장 | 정상 종료, 세션 ID 저장 |
| 한글 미전송 초안 | 정상 종료 | 정상 종료 |
| 한글·이모지·여러 줄 초안 | 정상 종료 | 정상 종료 |
| 실제 응답 완료 | 정상 종료, 확인한 UUID 저장 | 정상 종료, 확인한 UUID 저장 |
| 동일 대화 resume | 원래 UUID로 재개·저장 | 원래 UUID로 재개·저장 |
| TUI 종료 후 셸 | stale 복원 상태 없이 종료 | stale 복원 상태 없이 종료 |
| 응답 중 | 차단 → 취소 → 작업 종료 → 재시도 성공 | ID 저장·종료 |

추가로 양쪽 환경의 셸 단독·app-server만 남은 셸을 정리 on/off로 확인했고, `/model`·`/permissions` 메뉴의 정상 종료, 반대 환경 셸과 함께 연 Codex pane, Windows Codex+WSL Claude 및 WSL Codex+Windows Claude의 동시 저장·종료를 확인했다. 혼합 에이전트에서는 두 번째 pane의 Claude UUID 저장과 두 환경의 실제 TUI 종료도 검사했다.

초안 입력이 화면에 반영되기 전 종료한 초기 시도는 초안 삭제 시간 초과로 중단됐다. 안정된 초안 상태를 화면으로 확인하는 절차를 추가해 다시 통과했으며, 그 과도기 실패를 정상 종료로 세지 않았다. 실제 작업 중 실패 화면에서는 손실 경고와 취소·강행 선택을 캡처하고 강행 후 창과 TUI 종료를 확인했다.

## 자동 회귀 검사

| 검사 | 결과 |
| --- | --- |
| 프로덕션 WSL shell probe | 20개 통과 |
| Rust workspace·통합·문서 | 2,362개 통과, 17개 기존 ignored |
| UI 단위 | 5,201개 통과 |
| 실제 xterm 화면 셀 | 94개 통과 |
| Playwright E2E | 초기 전체 507개 통과; 최종 UI 변경 후 502개 + 분리 재실행 5개 통과 |
| TypeScript·Vite production build | 통과 |
| `cargo check --release -j 2` | 통과 |
| `cargo clippy --workspace --all-targets -j 2 -- -D warnings` | 통과 |
| 변경 Rust 파일 rustfmt·diff 공백 검사 | 통과 |
| 릴리즈 채널·버전 검사 | 통과 |

서버 배제, 실제 TUI 공존, helper를 경유하는 조상 연결, 두 TUI의 모호성, 읽을 수 없는 cmdline, 옵션 값·부분 문자열·개행 경계를 회귀 검사한다. 신규 서버 배제와 FD 검사, native helper 테스트는 수정 전 실패를 확인한 뒤 구현했다.

초기 전체 실행의 실패도 원인을 확인했다. UI 설치본의 xterm 패치를 재적용하고 병렬 부하로 App 테스트의 1초 대기가 초과되는 경우는 worker 수를 제한해 전체를 재검증했다. Rust는 과도한 병렬 컴파일의 페이징 파일 부족과 다른 워크트리의 빌드 메타데이터 재사용을 해소하고 `-j 2 -- --test-threads=4`로 전체 통과했다. 프로세스 환경 조회 테스트의 초기화 경합은 단독 실행과 최종 전체 실행에서 통과했다. 테스트 도구는 과거 출력 캐시·pane marker 재사용·Claude의 연속 Ctrl+C 간격을 수정하고 해당 케이스를 재실행했다.

마지막 E2E 병렬 실행에서는 Remote 파일 뷰어 4개가 연결·context 정리 제한 시간을 넘겼고 touch focus 1개가 실패했다. 전체 실행 시간이 비정상적으로 7.8시간으로 기록된 실행이며, 코드 변경 없이 실패한 5개만 worker 1개로 분리해 6.8초에 전부 통과했다. 이 재시도를 숨기고 한 번의 최종 전체 실행이 모두 통과했다고 기록하지 않는다.

## 범위

실제 업데이트 설치기를 실행하거나 사용자 release를 종료하지 않았다. 업데이트와 공유하는 Codex 확인·critical checkpoint 경로는 실제 dev 종료에서 실행했다. 알 수 없는 Codex 서브명령, 사용자별 키맵, native Linux는 전수 실측 범위가 아니다. 확인할 수 없는 상태를 정상 저장으로 간주하도록 보호를 완화하지 않았다.
