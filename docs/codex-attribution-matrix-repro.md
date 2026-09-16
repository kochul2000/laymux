# 세션 업데이트 귀속 조합 검증

2026-09-15~16, Windows·Linux dev 19281, PR #1050 (`fix/codex-threadless-attribution`).
기존 오류의 원본 증거와 수정 전후 비교는 [최초 재현 보고서](codex-threadless-log-retention-repro.md)에 있다.

이전 결과를 재사용하지 않고 `bed8da30`에서 다시 실행한 [독립 dev 재검증](attribution-dev-recheck-2026-09-16.md)에서 레이아웃 생성·workspace 복제 12개 조합의 저장 거부와 native DB 잠금이 WSL 귀속에 미치는 영향을 추가로 확인했다. 아래 기본 30개 통과를 모든 추가 조건의 통과로 확대해서 해석하지 않는다.

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
- 위 표의 Claude/Grok 전환은 실제 dev의 프로세스·파일 fixture다. 이후 실제 CLI로 추가한 기본 30개 조합은 아래 별도 결과와 구분한다.
- 기존 미방문 재현 fixture에는 ADR-0238 이전의 가정이 남아 있었다. DB/incarnation이 없는 fixture는 조회 실패(`unknown`)가 맞으므로, 격리된 초기 진단 행을 만들되 대화 전환·rollout은 만들지 않도록 수정하고 실제 dev에서 재검증했다.
- Linux GUI 빌드에서 현재 Rust 컴파일러의 경고 렌더러가 내부 오류를 냈다. 실기용 Linux 바이너리는 `RUSTFLAGS=-A dead_code`로 빌드했다. Windows strict clippy 결과와 구분한다.
- Linux 실기의 `health`는 dev 종류·실행 파일·PR worktree 경로를 확인했다. Windows에서 생성한 worktree의 git 경로를 Linux 빌드가 해석하지 못해 `gitCommit`/`gitBranch`는 null이었다. Linux 별도 UI 복사본과 npm 설치를 사용했으며 Windows용 `ui/node_modules`를 WSL에서 변경하지 않았다.

## 후속 확인: 종료 시 동작과 저장 요청의 경합

사용자가 지적한 실사용 `exit` 설정은 `interruptTerminals=true`, `interruptRounds=3`, `settleMs=2000`이었다. 앞선 실기에서는 이 설정이 꺼져 있었으므로 해당 교차 조건은 검증하지 못했다.

- 업데이트 경로는 `request_frontend_checkpoint("update", true)` 뒤 installer의 자식 정리를 수행하며, 일반 창 닫기의 `saveBeforeClose`/Ctrl+C를 호출하지 않는다. 실제 Windows·WSL Codex 두 pane에서 설정 OFF/ON 각각 5회 critical checkpoint를 실행했고, IPC 호출을 기록해 Ctrl+C 0회와 정확한 ID 유지를 확인했다. 설치 프로그램 자체는 실행하지 않았다.
- 일반 종료의 기본 순서는 metadata 저장 → Ctrl+C 3회 → 2초 대기 → 출력 캐시 → 창 닫기다. 저장 요청이 추가로 들어오지 않으면 두 ID가 유지됐다.
- 그러나 Ctrl+C 첫 호출 800ms 뒤 native watchdog과 같은 `session-checkpoint-requested` 이벤트를 주입하면, `persistSession`의 종료 플래그를 우회한 `flushSessionCheckpoint`가 다시 조회했다. Windows는 `noAgent`, WSL은 `activeButUnidentified`로 관측됐고, 두 pane의 저장 ID가 모두 지워졌다. 종료 이벤트, Ctrl+C, provider 조회, 설정 쓰기는 실제 dev 경로이며 주입한 것은 watchdog 요청의 도착 시점이다. 합성 request ID에 대한 Rust ACK는 pending 요청이 없어 거절되므로 이 ACK를 실제 watchdog 왕복 성공으로 세지 않는다.
- 시작 직후에는 15초 startup grace가 이 삭제를 가렸다. 유예 만료 후 같은 경합을 실행해 삭제를 확인했다. 따라서 초기 실행 직후의 성공만으로 정상 종료를 판정할 수 없다.
- 수정은 공통 `flushSessionCheckpoint`에서 종료 중의 비-close 요청을 거부한다. 마지막 close checkpoint는 Ctrl+C 전에 완료하며, native 요청은 오류 ACK 경로로 끝난다. 세 provider에 대해 watchdog·eviction·update 요청을 검증하는 새 테스트 3개가 수정 전 실패하고 수정 후 통과했다. 관련 4개 파일의 120개 테스트도 통과했다.
- 수정 후 같은 실제 종료 경합을 5회 반복하여 Windows·WSL 두 ID 보존을 확인했다. 유예 만료 뒤 설정 ON/OFF의 일반 종료도 각각 확인했고, Ctrl+C 호출은 ON에서 6회(두 pane × 3회), OFF에서 0회였다. 체크인한 `ui/scripts/repro-exit-checkpoint.mjs`로도 한 번 더 경합을 실행해 두 ID 보존을 확인했다.

이 문제는 종료 중 복원점 손실의 실측 원인이다. 업데이트 체크포인트 단독 실행의 `activeButUnidentified`를 이 설정 하나로 설명하지 않는다. ADR-0222의 "정상 close에서 인터럽트 전 복원점 확정" 규칙과 ADR-0048의 인터럽트 설정을 직접 적용하므로 새 ADR은 필요하지 않다. 실기 증거는 `.tmp/attribution-matrix/exit/`의 `update-events.json`, `normal-result.json`, `race-early-result.json`, `race-before-fix-{events,result}.json`, `close-{red,green}.json`에 있다.

```powershell
# 격리한 dev에 실제 resumable agent가 있는 matrix-* workspace를 준비한 뒤 ui/에서 실행
$env:LAYMUX_REPRO_ISOLATED = '1'
node scripts/repro-exit-checkpoint.mjs <workspace-id> <isolated-settings.json> race
```

## 추가 실기: 세 provider의 기본 30개 조합

2026-09-16, 같은 PR의 Windows dev 19281에서 실제 CLI를 실행했다. Windows는 PowerShell, WSL은 `wsl.exe -d Ubuntu-22.04`다. 버전은 Codex 양쪽 0.154.0, Claude Windows 2.1.272 / WSL 2.1.273, Grok Windows 1.0.13 / WSL 1.0.30이다. provider 홈·인증 복사본·작업 디렉터리·settings·WebView 데이터를 격리했다. 아래 재기동은 **Laymux 앱의 실제 정상 종료와 새 프로세스 시작**이며 OS 재부팅이 아니다. 최초 기본 30개 조합과 표시 상태 검사는 `39718f55`에서 실행했으며, native 표시 캐시 수정 후의 재검증 범위는 뒤에 명시한다.

사용자가 지정한 3 provider × 2 host × 5 상태를 그대로 실행했다. 먼저 실제 `addWorkspace`로 여섯 workspace를 만들고, 각각 `splitPane`으로 두 번째 pane을 생성했다. 새 pane의 초기 view는 `EmptyView`이고 기존 세션 필드가 없음을 확인했다. 같은 host의 여섯 CLI는 같은 CWD를 사용하며, 열두 세션 ID가 서로 다름을 검증했다.

**다음 표는 첫 입력이 영속된 대화 기준이다. 입력 전 빈 CLI의 실패·제약은 뒤 표에 별도로 기록한다.**

| provider / host | 재기동 후 최초 진입 | 재기동 후 미진입 | 미진입→종료·재기동→미진입 | 새 workspace | 기존 workspace에 pane 생성 |
| --- | --- | --- | --- | --- | --- |
| Codex / Windows | 통과 | 통과 | 통과 | 통과 | 통과 |
| Codex / WSL | 통과 | 통과 | 통과 | 통과 | 통과 |
| Claude / Windows | 통과 | 통과 | 통과 | 통과 | 통과 |
| Claude / WSL | 통과 | 통과 | 통과 | 통과 | 통과 |
| Grok / Windows | 통과 | 통과 | 통과 | 통과 | 통과 |
| Grok / WSL | 통과 | 통과 | 통과 | 통과 | 통과 |

- workspace 생성 후 6개, pane 추가 후 12개를 대상으로 각각 critical checkpoint 5회에서 provider·정확한 ID·commit coverage·배타적인 `last*Session` 필드를 대조했다. 초기 Windows Claude의 인증 만료 응답도 실제 대화로 남았고, 격리 인증을 정상화한 뒤 실제 응답을 추가로 확인했다.
- `종료 시 동작` ON/OFF 각각 앱을 세 번 재기동했다. 매 기동에서 workspace에 진입하지 않은 상태로 5회 critical checkpoint를 실행했다. **terminal instances 0개, attribution/coverage 빈 집합**, 디스크에 저장된 12개 ID는 그대로였다. 첫 두 기동은 실제 창 닫기로 다시 종료하고 저장 결과도 대조했다.
- 세 번째 기동의 미진입 검사 후 여섯 workspace를 모두 방문했다. 열두 실제 CLI가 원래 ID로 복원됐으며 critical checkpoint 5회와 실제 정상 종료 후에도 동일한 ID를 유지했다. ON/OFF 양쪽에서 반복했다. 별개 앱 PID는 ON `35200 → 21048 → 13896`, OFF `27500 → 11156 → 50676`이었다.
- OFF 첫 실행의 마지막 방문 도중 재현 스크립트 수정으로 Vite 새로고침이 발생했다. 그 실행은 통과로 세지 않고, 검증된 settings에서 실제 앱 재기동 세 번을 다시 수행했다. 위 OFF PID와 결과는 재실행분이다.

### 실제 표시 상태와 CLI 종료·재개

- 6개 provider/host workspace마다 첫 pane 포커스, 둘째 pane 포커스, 첫 pane 숨김, 두 pane 모두 숨김을 각각 5회 검사했다. **24개 조건, critical checkpoint 120회, coverage 1,440개**에서 12개 ID와 provider가 일치하고 PTY generation도 바뀌지 않았다. 각 저장의 다른 provider 필드가 비어 있음도 확인했다.
- 각 workspace의 두 번째 CLI를 실제로 종료했다. 6개가 `noAgent`가 된 뒤 5회 저장에서 해당 pane의 세 provider ID와 fresh 필드가 삭제됐고, 계속 실행 중인 나머지 6개 ID는 유지됐다. 종료한 CLI를 실제 resume 명령으로 다시 시작하고 12개 원래 ID의 귀속·저장을 5회 검증했다.
- Grok 종료 단축키는 Ctrl+Q 두 번이다. 첫 자동화에서는 세 번 보내 PowerShell에 남은 세 번째 제어 문자가 다음 명령 앞에 붙었다. 이 명령 실행 실패를 복원 결함으로 집계하지 않았으며, 실제 프롬프트와 오류 출력을 확인한 뒤 정상 명령으로 재개해 다시 검증했다.

### 추가로 재현·수정한 native provider 교체 누락

Windows의 같은 pane에서 Codex를 종료하고 실제 Claude 대화를 resume하자, Claude 프로세스와 해당 PID의 정확한 세션 파일이 있는데도 `activeButUnidentified`가 발생했다. 화면 activity는 `shell`이었으며 `get_terminal_session_attributions`의 fresh process 조회는 `claude`를 확인했다. 이 상태의 critical checkpoint 거부를 5회 기록했다(`native-cache-before-fix.json`).

세 adapter가 표시용 `known_*_terminals`를 조회 대상 목록과 빈 claim의 근거로 사용한 것이 원인이었다. 캐시에 없는 live pane은 provider 저장소를 조회하지 않았고, 오래된 cache는 이미 종료한 provider의 `None` claim을 만들 수 있었다. `57f7f744`에서 다음을 수정했다.

- live PTY 전체를 native/WSL로 분리하고 native process tree에서 현재 최상위 provider PID를 선정한다. 세 provider 모두 관측한 프로세스의 terminal ID만 귀속 결과에 포함한다.
- Claude도 최상위 PID 하나만 사용한다. 다른 provider 아래의 Claude와 Claude의 하위 agent는 현재 pane의 대화로 선택하지 않는다.
- 캐시 누락, 오래된 cache의 부재 claim, 중첩된 Claude 선택의 세 테스트는 수정 전 실패하고 수정 후 통과했다. 관련 Rust command 테스트는 Windows **486 통과, 1 ignored**, Linux **472 통과**였고 Windows workspace/all-targets strict clippy도 통과했다. Linux에서는 앞서 통과한 긴 retention matrix를 제외하고 `RUSTFLAGS=-A dead_code`로 실행했다. Claude 테스트를 별도 파일로 옮겨 구현 파일은 500줄 아래로 유지했다.
- 새 바이너리에서 Windows·WSL 각각 Codex→Claude, Claude→Grok, Grok→Codex로 실제 CLI를 교체했다. 12개 ID와 provider 필드를 critical checkpoint 5회 대조했고, 원래 provider 배치로 되돌린 뒤에도 5회 통과했다(`provider-{rotated,rotation-restored}-checks.json`).

ADR-0222의 "activity는 저장 판정의 권위가 아니다"와 기존 PID 귀속 원칙을 직접 적용한다. 새 API·설정 필드·복원 명령·소유권을 추가하지 않으므로 새 ADR은 필요하지 않다.

### 최신 수정에서 혼합 workspace와 종료 경합 재검증

`57f7f744`의 실제 dev에서 각 provider/host의 두 번째 pane을 새 workspace로 옮겼다. 한 workspace 안에 Codex·Claude·Grok × Windows·WSL의 6개 CLI를 혼합하고, 기존 workspace의 6개 CLI도 유지했다. critical checkpoint 5회에서 열두 ID·provider·배타적인 저장 필드·coverage가 모두 일치했다. 귀속 조회부터 이중 관측·저장까지 표본 중앙값은 1,880ms, 최댓값은 3,188ms였다.

이 혼합 배치에서 실제 정상 종료 경합을 **5회** 반복했다. 매회 모든 workspace에 진입해 열두 CLI가 원래 ID로 복원됨을 확인하고, startup grace가 끝난 뒤 창을 닫았다. 실제 Ctrl+C **36회(12개 × 3회)** 중 첫 호출 800ms 뒤 watchdog 요청을 주입해도 이후 `save_settings` 호출은 0회였고, 종료 후 디스크의 열두 ID가 모두 유지됐다. 별개 앱 PID는 `12864 → 48784 → 53600 → 9312 → 8320`이며 각 health의 commit도 `57f7f744`였다. 위와 같이 watchdog 요청의 도착만 합성했으며 Rust pending ACK 왕복 성공을 주장하지 않는다.

같은 최신 바이너리와 혼합 배치에서 종료 옵션 ON/OFF의 연속 재기동도 다시 실행했다. 각각 세 기동의 미진입 상태에서 5회씩 저장해 **30회 모두 PTY 0개·빈 attribution/coverage·저장 ID 12개 보존**을 확인했다. 각 옵션의 마지막 기동에서 모든 workspace를 방문한 뒤 5회씩 저장하고 실제 창을 닫아 열두 원래 ID를 대조했다. 앱 PID는 ON `54648 → 14572 → 30652`, OFF `41828 → 56080 → 50608`이었다.

자료는 `mixed-workspace-checks.json`, `mixed-race-{1,2,3,4,5}.json`, `{on,off}-{unvisited-*,restored-*}.json`이다. 앞선 바이너리의 ON/OFF 자료는 `before-native-cache/`에 보존했다. 재현 스크립트의 첫 인자를 `all`로 지정하면 격리된 `matrix-*` workspace 전체를 방문하여 같은 종료 검사를 실행한다.

### 입력 전 빈 CLI: 추가 실패와 제약

| 실제 CLI 상태 | 관측과 재기동 결과 | 판정 |
| --- | --- | --- |
| Codex, Windows·WSL | `fresh`, `lastAgentFresh=codex` 저장. ON/OFF 종료 후 새 ID로 Codex 실행 | 통과 |
| Claude, Windows·WSL | PID 파일의 ID로 `identified`를 반환하지만 `projects/<project>/<id>.jsonl`은 아직 없음. 그 ID가 저장되고 다음 실행의 `--resume`이 `No conversation found`로 종료 | **추가 결함, 이 PR에서 미수정** |
| Grok Windows 1.0.13 | 빈 CLI의 `active_sessions.json`은 빈 배열. `activeButUnidentified`로 critical checkpoint를 5회 거부. 첫 입력 후 실제 ID 귀속·복원 성공 | 빈 CLI의 복원 증거가 없는 버전 제약. 성공으로 집계하지 않음 |
| Grok WSL 1.0.30 | 입력 전에도 실제 PID·ID와 summary가 있음. 같은 ID로 빈 세션 재개 | 통과 |

빈 Claude는 종료 옵션 ON/OFF 각각 실제 종료·재기동으로 동일하게 실패했다. 따라서 이 실패는 종료 Ctrl+C 설정으로 설명되지 않는다. 현재 이 PR은 Codex 조회 누락·WSL deadline 소진·종료 중 마지막 복원점 덮어쓰기·native 표시 캐시 의존을 수정하며, Claude의 빈 대화 복원 정책을 추가하지 않는다. 기본 30개 표를 입력 전 CLI까지 모두 성공했다는 뜻으로 해석하면 안 된다.

추가 실기 자료는 `.tmp/attribution-matrix/providers-real/`에 있다. `new-workspaces-checks.json`, `resumable-created-checks.json`, `{on,off}-unvisited-{1,2,3}-checks.json`, `{on,off}-restored-visited-checks.json`은 반복 저장 결과다. `*-close-result.json`은 실제 창 종료 후 디스크 대조이며, `empty-resume-claude-*.json`과 `empty-off-resume-claude-*.json`은 빈 Claude의 두 종료 설정에서 나온 실제 실패 출력이다. 인증·대화 원본은 커밋하지 않는다.

## 전체 회귀 검사

| 검사 | 결과 |
| --- | --- |
| Windows UI unit | 종료 경합 수정 후 4,961/4,961 통과 (`--maxWorkers=4`). 관련 종료·checkpoint 검사 120개도 별도 통과 |
| xterm cell-grid screen | 89/89 통과 |
| UI build / TypeScript | 종료 경합 수정 후 재검증 통과 |
| Windows workspace/all-targets strict clippy | native 표시 캐시 의존 제거 후 재검증 통과 |
| native 표시 캐시 수정 후 Rust command 회귀 | Windows 486 통과·1 ignored, Linux 472 통과. `cargo test -p laymux --lib commands:: -- --skip retention_matrix` |
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

ADR: [0238](adr/0238-codex-lifecycle-storage-checkpoint.md), [0118](adr/0118-codex-session-pid-attribution.md), [0120](adr/0120-wsl-agent-session-attribution.md), [0222](adr/0222-agent-session-checkpoint-coordinator.md), [0048](adr/0048-kill-terminals-on-exit.md)의 직접 적용. 새 ADR 불필요: PID·incarnation·대화 전환을 증거로 쓰는 기존 계약과 공통 3초 예산을 유지하며, 잘못된 조회 범위·순차 실행 비용·표시 캐시 의존·최종 close 저장 이후의 우회 요청을 수정한다. provider 상태·IPC·저장 스키마·복원 명령·도구 인자 계약은 변경하지 않는다. 계획 및 PR 갱신 직전 같은 기준으로 판정했다.
