# Codex 업데이트 귀속 조합 검증

2026-09-15~16, Windows·Linux dev 19281, PR #1050 (`fix/codex-threadless-attribution`).
기존 오류의 원본 증거와 수정 전후 비교는 [최초 재현 보고서](codex-threadless-log-retention-repro.md)에 있다.

## 검증 기준

실제 Codex 검증은 0.154.0·0.153.4를 별도 프로세스로 실행했다. Windows native, 기본 WSL, `wsl.exe -d Ubuntu-22.04`, Linux native를 각각 사용했다. 두 WSL 지정 방식은 같은 Ubuntu-22.04를 대상으로 한다. Linux native는 WSLg에서 실행한 Linux Tauri/WebKit dev이며 Windows host의 WSL 귀속 adapter와 구분한다. `APPDATA`/Linux `HOME`, WebView 데이터, Codex 로그·대화 저장소를 격리했다. release 19280은 조작하지 않았다.

한 관측은 실제 `getTerminalSessionAttributions` → `flushSessionCheckpoint({reason:"update", requireConclusive:true})` → `loadSettings`다. 반환 상태·provider·세션 ID·PTY generation·commit coverage·저장된 fresh/resume 필드를 대조한다. 상태 전환은 실제 Codex 입력과 rollout의 `task_started`·`task_complete`·`turn_aborted`, 오류 출력으로 확인했다. `/resume A`는 목표 A까지 기다리며, `/clear`의 B와 재시작한 fresh의 C는 이전 ID와 달라야 한다.

이는 설치 직전 귀속·저장 경로의 검증이다. release 설치 프로그램 실행은 포함하지 않는다. 테스트 수와 내부 반복 관측 수를 구분한다.

## 조합과 실행 결과

| 계층 | 교차한 조건 | 결과 |
| --- | --- | --- |
| 실제 Windows dev + Codex | native/기본 WSL/명시 WSL × 두 버전 × fresh/입력 완료/clear/clear 후 실행 중/중단/A→B→A 재개/실패 × 보존 5종 × 5회 | 1,050건 통과 |
| 실제 Linux dev + Codex | native Bash × 두 버전 × 위 7개 상태 × 보존 5종 × 5회 | 350건 통과. 실제 WebKit 창·PTY·Rust IPC·critical 저장 경로, 두 버전의 HTTP 400 실패 출력까지 확인 |
| 실제 dev, 다중 pane | WSL 16개, 그중 12개가 같은 CWD·860,082,176바이트 DB 복제본 공유, 두 버전 혼합, renderer 없이 생성한 미방문 pane 포함 × 20회 | 추가 성능 수정 후 320건 통과 |
| 실제 dev, 큰 DB의 보존 조합 | 위 16개 pane에서 12개 process UUID의 로그를 각각 보존 5종으로 변경 × 5회 | 400건 통과 |
| 실제 dev, 장애 | WSL 한 저장소 손상/native 공유 저장소 손상/도구 누락/종료 코드 오류/불완전 JSON/시간 초과 × 5회, 정상화 후 재시도 | 추가 성능 수정 후에도 거부·복구 통과. 다른 저장소의 정상 ID 유지 |
| 실제 dev, provider 파일 fixture | Codex→shell→Claude→Grok, 두 pane의 중복 ID, 중복 해소, shell 복귀 × 5회 | 현재 provider 필드만 저장, 중복은 거부, 해소 후 복구 |
| 실제 dev, 재시작 | 저장된 resumable 6개를 재시작하여 목표 ID와 비교 × 5회 | 정확한 ID 복원·저장 통과 |
| 실제 dev, fresh/resume 혼합 재시작 | fresh 4개 + identified 2개 저장 → dev 재시작 → 각 workspace 방문 → 5회 checkpoint | fresh는 새 ID, identified는 원래 ID. 미방문 workspace는 PTY를 만들지 않고 저장 값 보존 |
| 실제 dev, 미방문 복원 fixture | renderer 없이 복원 요청 → 17초 대기 → 프로토콜 응답 → 실제 입력 | restorePending 보존, 실제 입력 후 activeButUnidentified 및 critical 저장 거부 |
| 실제 dev, hidden eviction | IPC 귀속 실패 3회 주입, 실제 backend eviction·PTY writer와 입력 경로 사용 | 종료 보류, 미방문 pane 미기동, raw 입력 116회·붙여넣기 116회 성공 |
| Rust, Windows/Linux | journal DELETE/WAL × 보존 5종 × lifecycle 9종 × rollout 7종 × native/guest 선택 × 5회 | 각 OS 6,300건 통과; 1,260개 조합을 5회 반복 |
| 동봉 WSL 도구 | journal 2종 × 보존 5종 × 5회, PID incarnation·pane marker·인용 span·손상·잠금·복구 | 각 OS 50개 조합 및 오류 단언 통과 |
| 프론트 checkpoint | surface 6종 × verdict 5종 × 5회 | 150건 통과 |
| 프론트 관측 사이 전환 | ID/provider/generation/종료/미확정/조회 실패 × 20회 | 120건에서 거부와 안정화 후 재시도 통과 |
| 프론트 저장 요청 중첩 | mutation/completion/workspaceEntry/watchdog/eviction/update × 두 중첩 순서 × 20회 | 240건 통과 |
| Rust barrier·귀속 반복 | checkpoint 14개와 attribution 14개를 각각 20회 | 각각 280개 테스트 실행 통과 |
| WSL 프로세스 probe fixture | 실제 POSIX 셸, process 160개·표시된 process 32개·pane 16개 × 20회 | 부모 관계, 첫 환경 값, 공백·등호·리터럴 `$()` 값, Codex FD 범위와 시간 제한 통과 |

핵심 실기 상태·보존 교차 검증은 합계 1,400건이며, 별도 16-pane 부하 검증은 720건이다. 보존 5종은 무삭제, 첫 threadless 행 삭제, 일부 삭제, 전부 삭제, 후속 threadless 행만 남김이다. Rust lifecycle 9종은 fresh/running/completed/failed/interrupted/clear/clear 후 입력/resume/A 재선택이다. rollout 7종은 없음/유효/불완전 header/후속 행 기록 중/중복/만료/다른 ID다. 이 교차 검증에서도 오래된 A·지연 도착한 요청·temporary 제목 생성 기록을 함께 넣었다.

Rust의 별도 오류 검증은 SQLite exclusive lock, 더 최신 번호의 손상 DB, rollout 접근 거부(Windows 공유 거부, Linux 권한 제거), 모든 프로세스 로그 소실과 정상화를 각각 5회 반복한다. 이전 PID incarnation·잘못된 marker·인용된 span을 증거로 채택하지 않는다. 프로세스 조회·distro 오류, 하위 agent/exec, ID 충돌, generation 변경, 입력 barrier 등 기존 회귀 테스트도 관련 스위트에 포함된다.

## 추가로 발견하여 수정한 원인

1. **로그 보존 경계 오류:** threadless 부분 인덱스로 process incarnation과 첫 행을 찾으면, 남아 있는 thread-bound 대화 시작 기록을 제외할 수 있다. native와 동봉 도구가 전체 잔존 행에서 경계를 찾도록 수정했다.
2. **WSL 프로세스 조회 비용:** 환경 변수마다 `sed`·`head` 등을 반복 실행했다. 실제 POSIX 셸 내장 읽기로 바꾸고 중간 부모 프로세스는 보존했다. 단독 `/proc` probe 20회에서 중앙값은 279.25→143.7 ms였다. 이는 종료된 dev에서 측정한 probe 자체의 값이다.
3. **pane별 순차 도구 실행:** 16개 pane·대용량 DB에서 공통 3초 예산을 소진했다. 수정 전 5회 비교에서 첫 critical checkpoint가 `unknown`으로 거부됐고, 2회 첫 조회에 `unknown`이 있었다. 이후 warm 상태의 성공도 기록했다. 도구를 최대 4개씩 동시에 실행하며 기존 deadline의 남은 시간만 전달하도록 수정했다. 결과는 terminal ID로 다시 결합한다. 수정 후 20회는 오류 없이 통과했고, 귀속 조회·이중 관측·저장을 합친 표본 중앙값은 5,962.5 ms, 최댓값은 6,463 ms였다.

세 번째 수정은 순차 실행에서 실패하는 회귀 테스트를 먼저 실행했다. 수정 후 16개 요청의 실제 중첩, 동시 실행 상한, 한 요청의 실패 격리, 이미 만료된 deadline에서 실행하지 않음을 검증했다. 이후 실제 dev의 16개 pane와 보존·장애 조합을 다시 실행했다.

## 전제와 실패 기록

- 최초 phase의 실행 중·중단 일부 표본은 UI 빌드/HMR로 PTY generation이 바뀌어 폐기했다. 위 1,050건에는 고정한 phase2에서 다시 실행한 결과만 포함한다.
- 격리된 Windows Codex 최초 실행은 샌드박스 안내/설정에서 입력이 막혔다. 통과로 세지 않았다. 테스트 프로필에서 최초 안내 조건을 정리하고 실제 입력 완료·작업 실행·중단·실패를 다시 확인했다.
- 빈 공유 state DB에 두 Codex 버전을 동시에 처음 실행했을 때 한 CLI가 `duplicate column name: process_uuid`로 종료했다. Linux native에서도 `table thread_dynamic_tools already exists`로 같은 초기화 경쟁을 관측했다. 이 upstream 초기 마이그레이션 실패와 Laymux의 조회 timeout을 구분했다. DB 초기화가 끝난 뒤 해당 테스트 CLI를 재실행하고 모든 대상이 준비된 상태에서 반복했다.
- Linux Bash profile은 기존 `ShellType::Other` 경로에서 startup command를 실행하지 않는다(`other_shell_startup_command_ignored` 테스트로도 명시). 따라서 Linux 350건은 실제 Bash PTY에서 Codex를 직접 실행해 검증했다. Linux Bash의 자동 재실행·복원은 통과로 세지 않는다. 자동 복원 실기는 Windows PowerShell·WSL에서 수행했다.
- Claude/Grok 전환은 실제 dev의 프로세스·파일 fixture다. 두 제품의 실제 대화 API 호출을 검증한 결과로 해석하지 않는다.
- 기존 미방문 재현 fixture에는 ADR-0238 이전의 가정이 남아 있었다. DB/incarnation이 없는 fixture는 조회 실패(`unknown`)가 맞으므로, 격리된 초기 진단 행을 만들되 대화 전환·rollout은 만들지 않도록 수정하고 실제 dev에서 재검증했다.
- Linux GUI 빌드에서 현재 Rust 컴파일러의 경고 렌더러가 내부 오류를 냈다. 실기용 Linux 바이너리는 `RUSTFLAGS=-A dead_code`로 빌드했다. Windows strict clippy 결과와 구분한다.
- Linux 실기의 `health`는 dev 종류·실행 파일·PR worktree 경로를 확인했다. Windows에서 생성한 worktree의 git 경로를 Linux 빌드가 해석하지 못해 `gitCommit`/`gitBranch`는 null이었다. Linux 별도 UI 복사본과 npm 설치를 사용했으며 Windows용 `ui/node_modules`를 WSL에서 변경하지 않았다.

## 전체 회귀 검사

| 검사 | 결과 |
| --- | --- |
| Windows UI unit | 4,958/4,958 통과 (`--maxWorkers=4`). 최종 focus/eviction 테스트 상태 구성 보강 후 해당 파일 95/95 재검증 통과 |
| xterm cell-grid screen | 89/89 통과 |
| UI build / TypeScript | 통과 |
| Windows workspace/all-targets strict clippy | 추가 동시 조회 수정 후 통과 |
| Windows Rust 전체 최초 실행 | 2,078 통과, 11 실패, 1 ignored |
| Rust 재검증 | 기존 Remote HTML 검사와 이미 통과한 긴 matrix를 제외한 workspace 실행에서 2,221 통과, 8 ignored. 최초 Android timing 실패 3개도 재검증 통과 |
| Playwright E2E | 409/418 통과; 실패 9개는 재시도 및 수정 전 base `5a266eac`에서도 동일 |
| base Rust Remote 비교 | 수정 전 base에서도 같은 Remote HTML 검사 8개 실패 |

E2E의 동일 실패 위치는 `remote-input-composer.spec.ts` 1112/1158/1491/1564, `remote-page-layout.spec.ts` 2034, `remote-reconnect.spec.ts` 280/300, `remote-scrollback-history.spec.ts` 297, `workspace-selector.spec.ts` 129다. 이 PR의 변경으로 생긴 실패로 집계하지 않았으며, 전체 스위트를 모두 green이라고 표현하지 않는다.

## 재실행 자료

- `ui/scripts/attribution-matrix-dev.mjs`: 격리 표시·dev 포트·worktree를 검증하고 JSON action으로 실제 UI/Rust checkpoint를 반복한다. `expected`에 상태·provider·ID·generation을 지정한다. 불일치나 예상과 다른 성공/거부는 실패 종료한다.
- `ui/scripts/fixtures/codex-retention-matrix.{mjs,py}`: 격리 DB의 정확한 process UUID만 정리한다. 첫 threadless 행들을 백업하고 각 보존 조합 전에 복원한다. 공용 사용자 DB를 직접 대상으로 실행하지 않는다.
- Rust `store/tests/retention_matrix.rs`, WSL 도구 `retention_and_fault_matrix`, `wsl.rs`의 동시 조회 테스트, `wsl_agent_session/tests.rs`의 실제 셸 fixture, `persist-session.test.ts`의 교차 테스트가 체크인된 회귀 검사다.
- 로컬 실행 산출물은 `.tmp/attribution-matrix/`에 있다. `phase2/*-{intact,initial,partial,all,late_only}.json`, `16-before-parallel.json`, `16-wsl-panes.json`, `16-shared-*.json`, `helper-*.json`, `*-db-corrupt*.json`, `mixed-*.json`, 이벤트/오류 출력과 baseline 비교 로그를 함께 보관했다. `linux/`에는 동일 35개 표본 파일, 각 상태의 rollout 이벤트, 두 버전의 실패 출력, health와 실제 WebKit 스크린샷이 있다. 이 디렉터리는 사용자 인증·대화 데이터를 PR에 올리지 않기 위해 커밋하지 않는다.

```powershell
# PR worktree의 Windows ui/에서, 격리한 dev가 실행 중일 때
$env:LAYMUX_REPRO_ISOLATED = '1'
node scripts/attribution-matrix-dev.mjs ../.tmp/attribution-matrix/action.json
```

ADR: [0238](adr/0238-codex-lifecycle-storage-checkpoint.md), [0118](adr/0118-codex-session-pid-attribution.md), [0120](adr/0120-wsl-agent-session-attribution.md)의 직접 적용. 새 ADR 불필요: PID·incarnation·대화 전환을 증거로 쓰는 기존 계약과 공통 3초 예산을 유지하며, 잘못된 조회 범위와 같은 도구의 순차 실행 비용을 수정한다. provider 상태·IPC·저장 스키마·복원 명령·도구 인자 계약은 변경하지 않는다. 계획 및 PR 갱신 직전 같은 기준으로 판정했다.
