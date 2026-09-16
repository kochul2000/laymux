# 세션 귀속 dev 독립 재검증 — 2026-09-16

사용자가 전달한 이전 보고서는 실행 증거로 재사용하지 않았다. PR #1050의 `bed8da30590016f46bfcb7a928a4c3b8cfd72b06`을 다시 빌드하고, 별도 설정·CLI 홈·작업 폴더·WebView 프로필에서 실제 CLI로 검사했다.

**기본 30개는 첫 입력이 저장된 대화 기준으로 통과했다. 추가 조건에서는 실패가 재현됐다.** 특히 레이아웃으로 workspace 생성·workspace 복제는 세 provider와 두 OS 모두에서 `activeButUnidentified`로 업데이트용 저장이 거부됐다.

이하 §1~4는 수정 전 `bed8da30`의 관측 기록이다. 이후 사용자 요청에 따라 §3의 새 결함 두 건을 `36716d5f`에서 수정했다. 후속 검증과 기존 한계는 §5에, 리뷰 지적과 추가 dev 검증은 §6에 구분한다.

## 환경과 판정 기준

- Windows dev Automation API **19281**, WebView CDP 9229. release 19280은 사용하지 않았다.
- 매 실행의 health에서 `buildKind=dev`, PR worktree, 위 커밋을 확인했다.
- Codex: Windows·WSL 0.154.0. Claude: Windows 2.1.272, WSL 2.1.273. Grok: Windows 1.0.13, WSL 1.0.30.
- Windows PowerShell 및 `wsl.exe -d Ubuntu-22.04`. 아래 재기동은 **Laymux 프로세스의 종료·새 프로세스 시작**이다.
- 6개 provider/host workspace를 실제 `addWorkspace`로 만들고 각각 `splitPane`으로 두 번째 pane을 만들었다. 같은 host의 CLI는 같은 CWD를 사용했다. 대화 ID 12개가 서로 다른지 검사했다.
- `flushSessionCheckpoint({reason: "update", requireConclusive: true})`의 실제 귀속 IPC·두 번의 관측·디스크 저장을 사용했다. provider, 정확한 ID, 다른 provider 필드 제거, coverage를 대조했다.
- 미진입 검사는 EmptyView만 있는 sentinel workspace로 시작하고 **PTY 0개, attribution 빈 값, coverage 빈 값, 저장된 ID 유지**를 함께 확인했다.
- 장애 검사의 통과는 **의도한 저장 거부·복원점 보호·장애 해제 후 정상 복구**를 뜻한다. `activeButUnidentified`를 정상으로 간주해 성공 처리하지 않았다.

원본은 로컬 `.tmp/attribution-matrix/recheck/`에 보관한다. 인증 복사본·CLI 대화 원본은 커밋하지 않는다.

## 1. 요청한 기본 30개

**첫 입력과 응답이 실제 저장된 대화 기준**이다. `RECHECK_OK` 응답을 xterm 또는 provider 대화 저장소에서 확인했다. Grok WSL 한 요청은 upstream 429가 나와 별도로 기록하고, 재시도 응답까지 확인한 후 이 표를 실행했다.

| provider / host  | 재기동 후 최초 진입 | 재기동 후 미진입 | 미진입 → 종료·재기동 → 미진입 | 새 workspace 생성 | 기존 workspace에 pane 생성 |
| ---------------- | ------------------- | ---------------- | ----------------------------- | ----------------- | -------------------------- |
| Codex / Windows  | 통과                | 통과             | 통과                          | 통과              | 통과                       |
| Codex / WSL      | 통과                | 통과             | 통과                          | 통과              | 통과                       |
| Claude / Windows | 통과                | 통과             | 통과                          | 통과              | 통과                       |
| Claude / WSL     | 통과                | 통과             | 통과                          | 통과              | 통과                       |
| Grok / Windows   | 통과                | 통과             | 통과                          | 통과              | 통과                       |
| Grok / WSL       | 통과                | 통과             | 통과                          | 통과              | 통과                       |

종료 시 Ctrl+C 옵션 ON/OFF 각각 3회 재기동했다. 미진입 저장은 매 기동 1회, 마지막 기동에서는 전체 workspace에 진입해 12개 원래 ID를 다시 확인하고 실제 창을 닫았다. 이번 실행의 ON PID는 `28788 → 44840 → 55700`, OFF PID는 `20664 → 44848 → 48684`였다. 이전 보고서의 30회 저장·5회 경합 횟수를 이번 결과에 합산하지 않았다.

증거: `resumable-created-checks.json`, `{on,off}-unvisited-{1,2,3}-checks.json`, `{on,off}-restored-visited-checks.json`, 대응하는 `*-close-result.json`, `first-input-grok-verified.json`.

## 2. 첫 입력 전 빈 CLI

새 workspace와 분할 pane의 12개 빈 CLI를 저장하고, 미진입 상태에서 다시 종료·재기동한 뒤 진입했다.

| provider / host      | 새 workspace·새 pane에서 관측       | 재기동 후 실제 결과                                                       |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| Codex / Windows·WSL  | `fresh`, `lastAgentFresh=codex`     | 새 빈 대화로 실행. 4개 pane 통과                                          |
| Claude / Windows·WSL | PID 파일의 ID를 `identified`로 저장 | **4개 pane 모두 `No conversation found`**. 빈 대화 복원 실패 재현         |
| Grok / Windows       | ID 없음, `activeButUnidentified`    | **critical 저장 거부**. 재진입 시 자동 복원할 ID 없음. 2개 pane 모두 동일 |
| Grok / WSL           | 입력 전에도 실제 ID·summary 존재    | 원래 빈 대화 ID로 복원. 2개 pane 통과                                     |

이 표의 빈 Claude 실패와 Windows Grok 제약은 기본 30개 통과에 포함하지 않는다. 이번 빈 CLI 재기동은 종료 옵션 ON으로 실행했다. 빈 CLI의 ON/OFF 전체 교차를 새로 모두 실행했다고 주장하지 않는다.

증거: `empty-initial.json`, `empty-unvisited-{1,2}.json`, `empty-restored.json`, `empty-restored-outcomes.json`.

### `/clear` 이후에는 결과가 달랐다

실제 여섯 CLI에서 `/clear`를 실행하고 **새 질문을 하지 않은 상태**로 종료 옵션 OFF에서 창을 닫고 재기동했다. Codex 두 개는 `fresh`로 저장되고 새 빈 ID로 시작했다. Claude·Grok 네 개는 `/clear`가 만든 새 ID로 정상 복원됐다. 이전 대화 ID를 계속 저장하지 않았고, 비교군인 나머지 여섯 대화도 유지됐다.

Windows Grok도 이 경로에서는 새 ID를 만들었다. `/clear` 직후 첫 조회는 잠시 `activeButUnidentified`였지만 critical 저장의 두 관측에서는 새 ID가 식별됐다. 따라서 **프로그램 첫 실행의 무입력 상태와 `/clear` 이후 상태를 같은 “빈 대화”로 합치면 안 된다.** 두 실험은 입력·저장 이력이 다르므로, 이 차이를 종료 옵션 ON/OFF의 효과로 해석하지 않는다.

증거: `after-clear-empty.json`, `clear-empty-off-close-result.json`, `clear-empty-restored.json`, `clear-empty-restored-screens.json`, `clear-result-summary.json`, `after-clear-baseline-restored-checks.json`.

## 3. 추가로 재현한 실패

### 3.1 레이아웃 생성·workspace 복제: 12개 조합 모두 저장 거부

실제 `exportAsNewLayout → addWorkspace`와 `duplicateWorkspace`를 각 provider/host에 실행했다. 새 workspace에 진입하기 전에는 저장이 성공했다. 진입 후 startup grace가 끝나도록 18초 이상 기다린 다음 동일 저장이 `activeButUnidentified`로 거부됐다.

| provider / host  | 저장된 레이아웃으로 새 workspace | 기존 workspace 복제 |
| ---------------- | -------------------------------- | ------------------- |
| Codex / Windows  | 재현                             | 재현                |
| Codex / WSL      | 재현                             | 재현                |
| Claude / Windows | 재현                             | 재현                |
| Claude / WSL     | 재현                             | 재현                |
| Grok / Windows   | 재현                             | 재현                |
| Grok / WSL       | 재현                             | 재현                |

`workspace-store.ts`의 `toLayoutPane`, `toWorkspacePane`, `duplicateWorkspace`가 `view` 전체를 복사하여 `last*Session`도 복사한다. 실행 증거에서도 새 pane이 원본 ID를 그대로 받아 같은 대화를 다시 열려고 했다. Claude는 중복 ID 귀속이 거부됐고, Codex는 실제 화면에 `This conversation is open in another app` 잠금 안내가 떴다. Grok은 원본 pane의 ID 귀속이 사라졌다. critical 저장을 거부하는 방어는 동작했지만, 사용자가 복제 기능을 사용하면 업데이트 저장이 막히는 경로가 남아 있다.

Codex·Claude는 복제 workspace 제거 후 원래 ID로 귀속이 회복됐다. **Grok은 두 host 모두 복제본 제거만으로 회복되지 않았으며, 원본 CLI를 종료하고 원래 ID로 다시 실행해야 했다.**

**원본 복원점 손실도 있었다.** Claude·Grok × 두 host × 두 생성 경로의 **8개 조합**에서 실패 당시 디스크 설정의 원본 pane 두 개 모두 `last*Session`이 사라졌다. 중복 실행으로 원본이 `activeButUnidentified`가 되고 일반 저장이 그 필드를 제거한 결과다. CLI 대화 원본의 삭제를 뜻하지는 않지만, Laymux의 다음 재기동 복원에 필요한 연결이 사라진다. 이후 회복 검사에는 별도로 보관한 기준 ID를 사용했으며, 이를 실패 중 ID 보존 성공으로 집계하지 않았다.

증거: `structure.json`의 첫 9개 조합, `structure-rest.json`의 다음 2개, `structure-rest-11.json`의 마지막 조합. 중간에 멈춘 정리 단계와 수동 CLI 재시작은 복구 절차로 기록했다.

재현 순서는 다음과 같다.

1. 격리 dev에서 해당 CLI의 첫 대화를 저장하고 실행 상태를 유지한다.
2. workspace를 새 레이아웃으로 내보내 그 레이아웃으로 workspace를 만들거나, workspace를 복제한다.
3. 새 workspace에 진입하고 18초 이상 기다린다.
4. 업데이트용 critical checkpoint를 실행한다. 새 pane의 복원 ID 복사, CLI 잠금/중복 귀속, 저장 거부를 함께 확인한다.

### 3.2 Windows Codex DB 잠금이 정상 WSL Codex에도 영향

Windows의 실제 Codex DB를 `VACUUM INTO`로 별도 최신 번호 DB에 복제했다. 잠그기 전에 이 복사본으로 12개 ID가 정상 식별됨을 확인하고, Windows 파일 공유 거부 잠금을 걸었다.

- 잠긴 Windows Codex 2개가 `unknown`이 되는 것은 기대한 방어 동작이다.
- **정상 WSL Codex 2개도 `unknown`이 됐다. 3회 모두 재현했다.** 다른 provider의 ID는 유지됐다.
- 잠금을 풀면 같은 복사본에서 다시 정상 식별됐다. 복사본 제거 후 원본 DB에서도 복구됐다.
- 로그에 native DB 열기 실패 뒤 `Codex WSL deadline expired`가 기록됐다. `codex_session.rs`는 native DB 조회 전에 WSL deadline을 만들고 native 순차 조회 뒤에 WSL 도우미를 실행한다. native I/O 지연이 WSL의 남은 시간을 소진하는 경로다.

기존 복원 ID는 보존됐지만, 정상인 다른 host까지 귀속 불명으로 만드는 장애 격리 한계가 있다.

증거: `faults-locks.json`, `native-lock-deadline.log`. 실행 중인 원본 DB는 이미 열려 있어 직접 공유 거부 잠금을 잡지 못했다. 그 최초 주입 실패는 성공 횟수에서 제외하고, 읽기 가능한 실제 DB 복사본의 잠금 전·중·후를 다시 검사했다.

## 4. 추가 검증 결과

| 조건                              | 실제 dev 실행 범위                                                                        | 결과                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 포커스·비포커스·숨김              | 6개 workspace × 4개 상태, 24개 조건                                                       | ID·provider·coverage 유지                                                      |
| 저장 요청 중첩                    | mutation/completion/workspaceEntry/watchdog/eviction/update × update 선행·후행, 12개 조건 | 최종 commit 일치, 12개 ID 유지                                                 |
| 숨김 자동 종료                    | provider/host별 두 번째 pane 6개                                                          | 실제 backend checkpoint·ACK 뒤 PTY 종료, 재진입 후 같은 ID·새 generation       |
| 귀속 IPC 실패 중 숨김 자동 종료   | 같은 6개                                                                                  | 종료 보류, 실패 해제 후 종료·정확한 복원                                       |
| CLI 정상 종료·재실행              | 6개, 나머지 6개는 비교군                                                                  | NoAgent일 때 이전 필드 제거, 재실행 후 원래 ID                                 |
| CLI 프로세스 강제 종료            | 소유 PID를 확인한 Windows 3개·WSL 3개                                                     | NoAgent·오래된 필드 제거, 원래 ID로 재실행 성공                                |
| provider 교체                     | 두 host의 Codex→Claude, Claude→Grok, Grok→Codex 및 원복                                   | 정확한 provider 필드와 ID                                                      |
| 대화 A→B→A                        | provider/host별 두 pane의 ID를 서로 바꾸고 원복, 12개 pane                                | 이전 ID로 잘못 저장하지 않음                                                   |
| 실제 작업 처리·중단               | 6개 CLI에 90초 타이머 명령 요청, 처리 중 저장, 중단 입력                                  | 해당 대화 ID 유지. 화면의 처리 상태·중단 표시와 함께 확인                      |
| 명령 승인 대기                    | Claude·Grok × 두 host                                                                     | 승인 대기 중 ID 유지. 허용한 명령만 1회 승인                                   |
| 다른 CWD에서 재개                 | 6개 CLI, 나머지 6개는 원래 CWD 유지                                                       | trust·디렉터리 선택 완료 후 정확한 ID로 저장                                   |
| 시작 안내·디렉터리 선택 대기      | Codex Windows·WSL 및 Claude WSL의 실제 안내 화면                                          | `activeButUnidentified`로 거부, 선택 완료 후 정상 저장                         |
| workspace·pane 삭제 후 재생성     | 6개 provider/host 배치에서 workspace 2회씩 생성, 각 생성에서 pane 삭제·재분할             | 새 ID·EmptyView, 기존 세션 필드 미복사, 원본 12개 ID 유지                      |
| 두 관측 사이 상태 변화            | 종료·provider·ID·generation·두 번째 IPC 실패, 대상 6개 또는 12개                          | 불안정한 critical 저장 거부, 안정화 후 정확한 저장                             |
| 로그 보관                         | Windows·WSL Codex 각각 2개 × intact/initial/partial/all/late_only                         | threadless 로그 보관 범위 5종 모두 원래 대화 유지                              |
| 파일·DB·도우미 장애               | 아래 22개 주입 조건과 각 복구                                                             | 의도한 거부·복원점 보호·복구 통과                                              |
| 읽기 접근 거부                    | Windows 공유 거부·WSL chmod 000, 세 provider                                              | 의도한 거부·ID 보호·복구. Windows Codex의 host 간 영향은 §3.2 실패로 별도 집계 |
| 설정 파일 쓰기 실패               | Windows 쓰기·교체 거부 후 해제                                                            | critical 실패, 기존 파일 바이트 보존, 해제 후 저장 성공                        |
| 한 workspace에 provider·host 혼합 | 6개를 실제 이동, 기존 workspace의 6개 유지                                                | 12개 ID·provider·coverage 유지                                                 |
| 앱 강제 종료·재기동               | 혼합 배치에서 critical 저장 후 공식 kill-dev 실행                                         | 종료 전후 설정 파일 바이트 일치, 미진입 PTY 0개, 진입 후 12개 ID 복원          |
| 종료 중 저장 재진입               | 혼합 12개 CLI, 실제 창 종료·Ctrl+C 36회, 첫 interrupt 800ms 후 watchdog 요청 주입         | interrupt 이후 추가 저장 0회, 12개 ID 유지                                     |

22개 파일·DB·도우미 장애는 각 host의 Claude 파일 누락/불완전 JSON/잘못된 JSON/다른 PID, Grok active_sessions 누락/불완전 JSON/잘못된 JSON/빈 배열, Codex 최신 DB 손상, WSL Codex 도우미 누락/exit 42/잘린 JSON/timeout이다. 정상 부재(`activeButUnidentified`)와 조회 실패(`unknown`)를 구분하여 일반 저장에서 전자는 오래된 ID를 제거하고 후자는 유지하는지도 확인했다.

증거: `visibility-checks.json`, `overlap.json`, `eviction.json`, `eviction-failure.json`, `shell-checks.json`, `shell-resumed-checks.json`, `crash-pids.json`, `crash-resumed-checks.json`, `provider-{rotated,rotation-restored}-checks.json`, `session-{swapped,swap-restored}-checks.json`, `turns-*.json`, `different-cwd-confirmed-checks.json`, `cwd-prompt-checkpoint.json`, `creation.json`, `transitions.json`, `transitions-rest-3.json`, `retention-*-checks.json`, `faults.json`, `faults-locks.json`, `mixed-confirmed-checks.json`, `app-crash-{durable-result,unvisited-checks,restored-checks}.json`, `mixed-race.json`.

앱 강제 종료·복원은 `18176 → 25772`의 서로 다른 PID에서 실행했다. 종료 경합의 watchdog는 **요청 도착 시점만 합성**했다. 귀속·Ctrl+C·저장은 실제 경로지만 합성 request ID의 Rust ACK는 pending 요청이 없으므로 정상 ACK 성공으로 집계하지 않는다.

관측 경합의 최초 WebView 재로딩 시도는 pane 하나의 제어가 완료되지 않아 제외했다. 별도 dev 재기동과 테스트 설정의 명시적 복구 후 다시 준비했으며, 그 준비 과정은 재기동 보존 성공에 포함하지 않는다. 최종 실행에서 종료·provider·ID 변화가 실제 완료된 경우와 generation 변화가 실제 관측된 경우만 집계했다. generation의 첫 하네스는 재시작 후 반드시 NoAgent일 것으로 가정해 대기 만료됐고, 실제 새 generation에서 같은 대화가 재개된 것을 기준으로 재검증했다. `transitions.json`의 해당 중단 항목은 통과가 아니며, 최종 두 조건은 `transitions-rest-3.json`에 있다.

## 5. 새 결함 수정과 후속 검증

수정 커밋은 `36716d5f39d17fc1f72c19e48a4fd5f3767fe859`다. 제품 코드는 두 원인에 한정했다.

- workspace 복제·레이아웃 내보내기/복제/생성의 공통 view 복사에서 세 provider의 `last*Session`과 `lastAgentFresh`를 제외한다. 프로필·CWD·동기화 설정과 원본 pane은 보존한다. 이미 저장된 레이아웃도 새 workspace 생성 시 복원점을 전달하지 않는다. 기존 pane의 이동은 복원점을 유지한다.
- Codex WSL의 deadline을 native 조회 이후, WSL process 탐색 직전에 만든다. WSL process 탐색과 SQLite 도우미의 공통 3초 제한·최대 4개 병렬 조회는 유지한다.

### 복제·레이아웃의 30개 조건

같은 커밋의 dev PID 44904에서 원본 CLI 12개를 유지한 채 provider/host별 대표 workspace를 복사했다. 대표 workspace에는 terminal pane이 하나씩 있고, 나머지 여섯 원본은 혼합 workspace에 있다. 각 복사본을 미진입 상태에서 저장하고, 실제 진입 후 18초 이상 기다려 critical 저장을 다시 실행했다.

| 원본 CLI / host | 새 레이아웃으로 생성 | workspace 복제 | 기존 레이아웃 덮어쓰기 후 생성 | 레이아웃 복제 후 생성 | 복원 ID가 들어 있는 과거 레이아웃으로 생성 |
|---|---|---|---|---|---|
| Claude / Windows | 통과 | 통과 | 통과 | 통과 | 통과 |
| Claude / WSL | 통과 | 통과 | 통과 | 통과 | 통과 |
| Codex / Windows | 통과 | 통과 | 통과 | 통과 | 통과 |
| Codex / WSL | 통과 | 통과 | 통과 | 통과 | 통과 |
| Grok / Windows | 통과 | 통과 | 통과 | 통과 | 통과 |
| Grok / WSL | 통과 | 통과 | 통과 | 통과 | 통과 |

모든 복사본은 프로필·CWD·동기화 설정을 보존하고 **대화 복원점 없는 새 셸(`NoAgent`)**로 시작했다. 원본 12개의 정확한 provider·ID·저장 필드는 생성 전·후·복사본 제거 후에도 유지됐다. 미진입 coverage는 12개, 진입 후에는 원본 12개와 새 pane 하나의 13개였다. 원본 CLI 수동 재시작이나 저장된 ID의 수동 복구는 사용하지 않았다. 이는 복사본의 무입력 Claude/Grok 복원 정책을 검사한 결과가 아니다.

원본 증거: `fix-structure.json`의 30개 결과. §3.1의 두 생성 경로 12개 실패를 포함해 5개 경로를 실제 store action→PTY→귀속 IPC→critical 저장으로 검사했다.

**혼합 배치 2건도 통과했다.** 세 provider × 두 host의 terminal pane 6개와 EmptyView 하나가 있는 workspace에서 레이아웃 생성과 workspace 복제를 각각 실행했다. 여섯 새 PTY가 준비된 뒤 18초를 더 기다려 검사했으며, 새 pane은 모두 `NoAgent`, 원본 12개는 원래 provider·ID를 유지했다. critical coverage는 18개였다. 증거는 `fix-structure-mixed.json`이다. 따라서 이 수정의 실제 생성·복제 검사는 **30개 조건 + 혼합 2건 = 32건**이다.

### Windows DB 잠금의 host 간 영향

커밋에 포함한 `ui/scripts/repro-codex-host-isolation.mjs`로 수정 전 `300d1874`(PID 684)와 수정 후 `36716d5f`(PID 44904)를 동일 조건에서 비교했다. 실제 DB를 `VACUUM INTO`로 복사해 정상 조회를 먼저 확인하고, 그 복사본에만 Windows 공유 거부 잠금을 걸었다.

| 관측 | 수정 전 | 수정 후 |
|---|---|---|
| 잠금 전 원본·복사본 | 12개 ID 정상 | 12개 ID 정상 |
| 잠금 중 3회 | Windows Codex 2개와 **정상 WSL Codex 2개 모두 `unknown`** | 잠긴 Windows Codex 2개만 `unknown`, 나머지 10개는 정확한 ID 유지 |
| 잠금 중 critical/일반 저장 | critical 거부, 기존 12개 ID 보존 | critical 거부, 기존 12개 ID 보존 |
| 잠금 해제·복사본 제거 후 | 정상 복구 | 정상 복구 |

원본 증거: `fix-host-before.json`, `fix-host-after.json`, `fix-host-summary.json`. 최초 잠금 획득 시도는 background reader와 경합하여 측정 전에 중단됐다. 테스트 도구에 잠금 획득·정리의 짧은 재시도를 추가한 뒤 위 동일 검사를 실행했으며, 중단 시도는 성공 횟수에 포함하지 않았다.

재실행은 Windows에서 두 native·두 WSL Codex를 포함한 격리 dev와 baseline을 준비한 뒤 `ui/`에서 한다. baseline 형식은 스크립트 머리말에 있다. 테스트용 SQLite 홈은 현재 worktree의 `.tmp/` 아래로 제한한다.

```powershell
$env:LAYMUX_REPRO_ISOLATED='1'
node scripts/repro-codex-host-isolation.mjs ../.tmp/attribution-matrix/recheck/resumable-baseline.json ../.tmp/attribution-matrix/recheck/home/.codex ../.tmp/attribution-matrix/recheck/fix-host-after.json
```

### 수정 후 실제 재기동

종료 옵션 ON/OFF 각각 실제 앱을 3회 시작했다. 매 기동 미진입 상태의 critical 저장에서 PTY·attribution·coverage가 모두 비어 있고 원본 12개 저장 ID가 유지됨을 확인했다. 앞 두 기동은 미진입 상태에서 다시 종료했으며, 세 번째 기동은 모든 workspace에 진입해 원래 12개 provider·ID를 복원한 뒤 실제 창을 닫았다. 최종 디스크에서도 같은 ID를 확인했다.

| 종료 옵션 | 실제 dev PID | 미진입 저장 | 세 번째 기동의 첫 진입·종료 |
|---|---|---|---|
| ON | `13328 → 25980 → 29804` | 3회 통과 | 12개 원래 대화 복원·저장 통과 |
| OFF | `5004 → 5288 → 21272` | 3회 통과 | 12개 원래 대화 복원·저장 통과 |

증거: `fix-{on,off}-unvisited-{1,2,3}-checks.json`, `fix-{on,off}-restored-visited-checks.json`, 각 `*-close-result.json`. `fix-final-audit.json`은 32개 생성·복사 결과, DB 잠금 전후 결과, 서로 다른 6개 PID와 모든 저장 ID를 별도로 대조한 요약이다. 모든 결과의 실행 커밋이 `36716d5f`인지도 확인했다.

### 자동 회귀 검사

- 새 복제 회귀 검사는 수정 전 **10개 실패**, 수정 후 통과했다. Windows·WSL 프로필 × workspace 복제/새 레이아웃 내보내기/기존 레이아웃 덮어쓰기/저장된 레이아웃으로 생성/레이아웃 복제의 5개 경로다. 세 provider ID·fresh 필드 제거, 나머지 설정과 원본 객체 보존을 함께 검사한다.
- Windows UI: workspace store, WorkspaceSelectorView, store e2e, checkpoint 검사 **338/338 통과**. TypeScript·production build·변경 파일 ESLint/Prettier 통과.
- Windows Rust: Codex session 검사 **39/39**, session attribution 검사 **16/16 통과**. 기존 로그 보존 matrix와 병렬 조회의 실패 범위 검사도 포함한다. 변경 Rust 파일의 rustfmt 검사는 통과했다. 전체 `cargo fmt --all -- --check`는 변경 전부터 있던 `remote_server/font_assets.rs:360`의 줄바꿈 차이로 실패했으며, 무관한 파일은 수정하지 않았다.

§2의 **처음 실행한 무입력 Claude 복원 실패와 Windows Grok 1.0.13의 ID 부재는 이전부터 알려진 별도 한계로 남는다.** 이번 새 결함 두 건의 수정·통과에 포함하지 않는다.

## 6. 리뷰 수정과 추가 dev 검증

### 원인과 회귀 검사

리뷰 3건을 `fd0e14e3`에서 수정하고, dev에서 추가로 관측한 background 저장의 unhandled rejection을 `09ece112`에서 수정했다.

| 항목 | 수정 전 재현 | 수정 및 검증 |
|---|---|---|
| native 동일 깊이의 여러 agent | 정확한 PID 선택이 `None`이면 liveness도 `NoneAlive`로 축약됐다. 새 테스트에서 Claude 두 개가 확정 부재로 판정됐다. | 공통 tree 탐색이 후보들을 보존한다. 모호하면 `Ambiguous` → provider 없는 `ActiveButUnidentified`로 파괴 전 저장을 거절한다. 3×3 provider 쌍 × wrapper 유무 × snapshot 순서 = 36개 조건 통과. |
| 조회 사이 native tree 변경 | 이전 provider 조회에 ID가 하나 있으면 새 liveness의 모호성을 `Identified`로 덮었다. 추가 실패 테스트로 확인했다. | 새 모호성이 이전 ID보다 우선한다. 세 provider × 이전 claim 유무 = 6개 조건에서 미소비 resume도 barrier를 우회하지 못함을 확인했다. |
| WSL 느린 pane 뒤 작업 | HashMap의 실제 첫 작업을 막으면 정상 7개 중 3개만 시작했다. 남은 4개는 첫 chunk의 종료를 기다리다가 공통 deadline이 끝났다. | 최대 4개 worker가 완료 즉시 다음 pane을 받는다. 정상 7개가 모두 끝나야 느린 작업이 풀리는 결정적 검사 통과. 별도 16개 작업에서 동시 상한·DB 실패·reader panic의 pane별 격리·만료 후 실행 금지도 통과. |
| retention 중복 반복 | 동일한 1,260개 관측을 5회 생성했다. | 중복 바깥 반복과 동일 fault/recovery 반복을 제거했다. DELETE/WAL × 보존 5종 × lifecycle 9종 × 파일 7종 × native/guest의 고유 1,260개 관측은 유지한다. |
| 자동 저장과 critical 실패의 경합 | dev의 실제 workspace 진입 저장이 critical 거절에 합류하면서 unhandled rejection을 냈다. 새 테스트에서도 같은 미처리 오류 1개를 재현했다. | `persistSession`이 반환 promise에 오류 handler를 연결한다. background 호출은 오류를 기록하고, 명시적으로 기다리는 호출자는 동일한 실패를 받는다. critical 거절·디스크 저장 미실행·기존 명시적 저장 실패 전달 검사 통과. |

Windows Rust 관련 검사 **239/239**(process tree 26, session attribution 17, Codex session 40, activity 156), UI checkpoint·lifecycle·hidden auto-close **122/122** 통과. 1,260개 matrix를 포함한 Codex 검사 40개 전체가 **51.11초**에 끝났다. 리뷰의 수정 전 단일 matrix 측정치는 약 268초였으며, 이를 같은 실행에서 잰 전후 benchmark로 취급하지 않는다. Rust all-targets Clippy `-D warnings`, 변경 Rust rustfmt, 변경 UI ESLint·Prettier, TypeScript와 production build를 통과했다.

### 실제 dev — native 모호성

`fd0e14e3`, dev PID `32992`에서 같은 provider 쌍 3개, 서로 다른 provider 쌍 3개, 세 provider 동시 실행 1개를 만들었다. `codex.exe`·`claude.exe`·`grok.exe`라는 이름의 실제 OS 자식 프로세스를 동일 parent 아래 유지하는 **process fixture**다. 이 7건 자체를 실제 CLI 대화 검사로 세지 않는다.

- 7개 모두 provider·session ID 없는 `ActiveButUnidentified`였다.
- 각 pane의 update·eviction critical 저장 **14/14 거절**을 확인했다.
- 숨김 자동 종료를 1초로 설정하고 6.5초 기다렸다. backend checkpoint 거절 로그와 7개 PTY generation 보존·eviction 없음이 확인됐다.
- fixture 제거 후 실제 Codex·Claude·Grok × Windows·WSL의 기존 12개 대화는 원래 ID로 복원·저장됐다.

증거: `review-native-fd0e14e3.json`, `review-live-checks.json`. 앞의 JSON은 각 조합·판정·거절 사유·generation을 기록한다.

### 실제 dev — WSL 8개 중 하나 지연

같은 dev에서 기존 WSL Codex 2개와 새 실제 WSL Codex 6개를 함께 실행했다. 동봉 probe를 임시 wrapper로 감싸 지정한 pane 하나만 5초 지연시키고, 나머지는 원래 Linux SQLite 도구를 실행했다. 공통 3초 deadline과 실제 WSL 프로세스·저장소를 그대로 사용했다.

- **3/3회** 지연 pane 하나만 `Unknown`, 나머지 WSL Codex 7개는 원래 상태·ID를 유지했다. 다른 provider/host의 10개 pane도 유지됐다.
- 전체 update는 지연 pane 때문에 거절됐다. 정상 WSL 7개만 대상으로 한 eviction checkpoint는 모두 성공했다.
- 통합 귀속 조회는 각각 **3,237 / 3,249 / 3,267 ms**였다. 이 수치는 WSL 이외의 조회 비용도 포함한다.
- wrapper 제거 후 **18개 pane 전체**의 정상 critical 저장·귀속 일치를 확인했다. 원래 도구 바이너리의 SHA-256 일치도 확인했다.
- 추가 pane을 제거한 뒤 기존 12개 ID가 유지됐고, 종료 옵션 ON의 실제 창 종료 후 디스크에도 보존됐다.

증거: `review-wsl.json`, `review-wsl-pool.json`, `review-wsl-pool-starts.log`, `review-wsl-recovery.json`, `review-recovered-checks.json`, `review-close-result.json`. 최초 하네스는 전체 coverage 18개를 대상 7개로 잘못 가정해 중단됐다. 대상 ID로 필터링하도록 고쳤으며, 중단 결과는 `review-wsl-pool-harness-aborted.json`으로 남기고 위 3회에 포함하지 않았다.

### 최종 UI 수정 후 재기동

`09ece112`, dev PID `51988`에서 native 7개 조합을 다시 만들었다. update·eviction 14건 각각의 진행 중에 실제 workspace를 전환하여 background 저장을 합류시켰다. **14/14 거절, 7개 PTY 보존, WebView page error 0건**이었다. 오류 기록은 남고 unhandled rejection은 없어졌다.

두 번째 dev 기동에서도 미진입 PTY 0개·저장 ID 12개 보존을 확인했다. fixture 제거 후 실제 12개 대화의 첫 진입·critical 저장과 종료 옵션 OFF의 실제 창 종료를 검사했고, 디스크 ID 변경은 0개였다. 첫 빌드의 ON 종료와 최종 빌드의 OFF 종료를 각각 1회 검사한 결과이며, §5의 6회 재기동을 여기에 합산하지 않는다.

증거는 `.tmp/attribution-matrix/recheck/`의 `review-native.json`(`pageErrors: []`), `review-final-unvisited-checks.json`, `review-final-live-checks.json`, `review-final-close-result.json`, `review-final-dev.err.log`에 남겼다. 테스트 workspace·PTY를 제거하고 격리 dev 창을 정상 종료했다.

## 실행 범위와 제외

- dev 빌드는 updater가 비활성이다. 여기서 검증한 update는 실제 UI/Rust 저장 경로이며, **설치 파일 다운로드·교체·설치 후 재기동 전체를 검증한 것은 아니다**. `app_update.rs`의 finalization 전체는 이 결과로 대체하지 않는다. 실제 backend pending 요청과 ACK는 숨김 자동 종료에서 별도로 검사했다.
- 모든 축의 무제한 데카르트 곱을 실행했다는 뜻이 아니다. 표에 적은 현재 버전·host·상태와 주입 조건이 실제 실행 범위다. 다른 CLI 버전, OS 자체 재부팅, 모든 장애와 모든 생명주기 상태의 전체 교차는 포함하지 않는다.
- Codex는 이번 기본 프로필에서 `--yolo`로 실행했다. Codex의 도구 승인 설정별 교차는 실행하지 않았으며, 실제 시작 안내·디렉터리 선택 대기는 별도로 검사했다. 요청 실패는 이번 실행에서 관측된 Grok WSL 429와 재시도만 확인했다. 세 provider 전체의 네트워크·인증 실패 조합을 실행했다는 뜻이 아니다.
- 기본 라이프사이클 실험에서는 UI HMR을 발생시키지 않았다. IPC 장애·관측 경합 주입은 별도 WebView 준비 단계 이후 측정했다. 중단된 하네스 시도는 통과 횟수에서 제외한다.
- §1~4는 제품 코드를 변경하지 않은 독립 검증이고, §5와 §6은 각 수정 후 별도 검증이다. 이전 검증의 반복 횟수를 새 커밋의 검사 횟수에 합산하지 않는다.

ADR 불필요: 기존 독립 Workspace/Layout 모델과 ADR-0120·0238의 WSL 조회 범위, ADR-0222의 모호한 활성 세션 차단·critical 실패 전달 계약을 직접 적용한다. 복원점 복사·deadline 시작·프로세스 모호성·작업 슬롯 대기·background 오류 처리를 바로잡으며, API·저장 스키마·복원 명령·동시 실행 상한을 바꾸지 않는다. 계획과 PR 갱신 직전에 판정하고 관련 living doc을 함께 갱신했다.
