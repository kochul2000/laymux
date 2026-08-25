# 0202. I/O 하는 Tauri 커맨드는 메인 스레드에서 돌지 않는다

- Status: Proposed
- Date: 2026-08-25
- Source: 사용자 요구("cd 나 워크스페이스 전환할 때 github view 나 explorer view 가 blocking 으로 동작하니? thread 처리해서 여유있을 때 동작하게 해야지"), [ADR-0188](0188-path-link-ambient-detection-triggers.md), [architecture/api-contracts.md §14.6](../architecture/api-contracts.md)
- Extends: ADR-0188

## Context

`tauri-macros` 에서 `#[tauri::command]` 를 sync 함수에 붙이면 `ExecutionContext::Blocking` 이 된다 — 커맨드 본문이 IPC 를 처리하는 스레드, 즉 앱의 main/event-loop 스레드에서 인라인 실행된다. 같은 매크로에 `(async)` 를 주면 sync 함수는 `sync_threadpool` kind 로 바뀌어 async 런타임에서 돈다. 프런트엔드 계약(`invoke` 가 Promise 를 반환)은 어느 쪽이든 같으므로, 이 선택은 **호출자에게 보이지 않고 런타임에도 실패로 드러나지 않는다.** 잘못 고르면 "창이 가끔 버벅인다"로만 나타난다.

ADR-0188 이 이 함정을 `stat_paths` 한 개에 대해 발견하고 `(async)` 로 고쳤지만, 결정의 범위를 그 커맨드로 한정했다. 그 결과 같은 파일의 형제 커맨드부터 시작해 파일시스템·프로세스·시스템 열거를 하는 커맨드 다수가 여전히 메인 스레드에서 돈다. 실측한 대표 경로:

- **cd(OSC cwd 변경) 1회**가 `resolve_git_remote`(`.git/config` 읽기), `list_directory`(`read_dir` + 엔트리당 `symlink_metadata`+`metadata`), 그리고 debounce 된 세션 영속(`get_claude_session_ids`·`get_codex_session_ids`·`get_grok_session_ids` = 세션 디렉터리 전수 `read_dir` + 파일마다 `read_to_string` + JSON 파싱, 이어서 `save_settings` 의 settings.json 전체 쓰기)을 전부 메인 스레드에서 돌린다.
- **워크스페이스 첫 전환**은 그 워크스페이스의 pane 을 lazy mount 하면서 explorer pane 수만큼 `list_directory` 를 직렬로 실행한다.
- **주기 폴링**으로 `get_listening_ports` 가 10초마다 `netstat -ano -p TCP`(비 Windows 는 `ss -tlnp`) 프로세스를 메인 스레드에서 spawn 하고 종료까지 기다린다.
- 설정 화면을 열면 `list_system_monospace_fonts` 가 시스템 폰트를 전수 열거한다.

비용이 큰 경로일수록 느린 대상(UNC·네트워크 드라이브, 차가운 `wsl.exe`, 연결이 많은 머신의 `netstat`, 폰트가 많은 프로파일)에서 그대로 창 정지 시간이 된다. 반대로 GitHub view 는 이미 `#[tauri::command] async` + `spawn_blocking` + stale-while-revalidate 캐시([ADR-0110](0110-github-snapshot-stale-while-revalidate.md))로 이 문제가 없다 — 즉 규칙이 없어서 커맨드마다 결과가 갈린다.

범위는 **Tauri 커맨드의 실행 컨텍스트 선택 규칙**과 그 선택이 깨뜨리는 암묵적 직렬화의 대체다. 커맨드의 시그니처·반환 타입·권한 경계, Automation/Remote 경로, 프런트엔드 호출 방식은 비목표이며 그대로 둔다.

## Decision

**커맨드 본문이 파일시스템·프로세스 spawn·시스템 자원 열거에 닿으면 `#[tauri::command(async)]` 로 선언해 sync threadpool 에서 돌린다. 인메모리 상태만 만지는 커맨드와 순서 보장이 필요한 커맨드는 plain `#[tauri::command]` 로 남는다.**

### 판정 기준

- **threadpool 로 보낸다** — `fs::*`, `std::process::Command`, 시스템 열거(폰트·포트·네트워크 인터페이스)에 직접 또는 헬퍼를 거쳐 닿는 커맨드. 호출 빈도는 기준이 아니다. 한 번만 불리는 커맨드도 그 한 번이 느린 대상이면 창을 세운다.
- **메인 스레드에 남긴다** — `AppState` 잠금과 인메모리 조회/갱신만 하는 커맨드. threadpool 로 보내면 얻는 것 없이 IPC 마다 스레드 hop 만 생긴다.
- **순서 보장이 필요하면 남긴다** — 터미널 입력/프로토콜 응답 쓰기(`write_to_terminal`, `write_terminal_input`, `write_terminal_protocol_reply`, `interrupt_terminal_on_exit` 등)는 메인 스레드 인라인 실행이 사실상의 직렬화다. threadpool 은 IPC 도착 순서와 실행 순서를 분리하므로 이 경로는 옮기지 않는다.
- **클립보드(`smart_paste`, `clipboard_write_text`)는 이번 결정에서 제외한다.** Windows 클립보드의 스레드 친화성(소유 창·메시지 펌프)을 실측하지 않았고, 잘못 옮기면 조용히 실패하는 종류의 회귀다. 옮기려면 별도 ADR 로 근거를 남긴다.

### 실행 컨텍스트는 소스로 고정한다

이 선택은 런타임에 관측되지 않으므로 **어트리뷰트 자체가 계약**이다. `commands::main_thread_io` 가 대상 커맨드 표를 들고 각 소스에 `#[tauri::command(async)]\npub fn <name>(` 가 있는지 검사한다. 커맨드를 추가하거나 시그니처를 바꾸면 표도 함께 갱신한다. ADR-0188 이 `stat_paths` 하나에 대해 두었던 소스 어서션은 이 표로 흡수한다.

### 사라지는 암묵적 직렬화는 명시적으로 대체한다

메인 스레드 실행은 "동시에 두 커맨드가 같은 파일을 쓰지 않는다"를 공짜로 보장해 왔다. threadpool 로 옮기면 그 보장이 사라진다. 이미 cloud pairing/tunnel 태스크가 자기 런타임 스레드에서 `settings::save_settings` 를 호출하고 있으므로 이 경합은 이번 변경이 처음 만드는 것도 아니다.

- **settings.json 쓰기는 `SETTINGS_WRITE_LOCK` 으로 직렬화하고, 임시 파일에 쓴 뒤 `fs::rename` 으로 교체한다.** rename 은 Windows(`MoveFileEx` + `MOVEFILE_REPLACE_EXISTING`)와 POSIX 모두에서 기존 대상을 대체하므로, 읽는 쪽은 옛 파일 아니면 새 파일을 보고 잘린 앞부분을 보지 않는다.
- 파일당 쓰는 주체가 하나인 경로(pane 별 출력 캐시, 창 지오메트리)와 이미 게이트가 있는 경로(memo 의 `MEMO_LOCK`)는 추가 게이트를 두지 않는다.

## Alternatives Considered

- **커맨드는 그대로 두고 프런트엔드에서 호출 빈도를 줄인다**(debounce 확대, 폴링 간격 상향). 증상은 완화되지만 원인이 남는다 — 호출 1회가 느린 대상이면 여전히 창이 선다. 게다가 조절해야 할 지점이 view·hook 마다 흩어져 규칙이 되지 못한다.
- **커맨드 본문마다 `spawn_blocking` 을 직접 쓴다**(`get_remote_host_candidates` 방식). 동작은 같지만 커맨드가 `async fn` + `.await` + join 에러 문자열화로 부풀고, 실수로 빠뜨려도 티가 안 난다. `(async)` 어트리뷰트는 같은 효과를 한 줄로 내고 소스 검사로 고정하기 쉽다. 이미 `spawn_blocking` 을 쓰는 커맨드는 그대로 둔다.
- **모든 커맨드를 threadpool 로 보낸다.** 판정이 필요 없어 단순하지만, 인메모리 조회에 스레드 hop 을 붙이고 터미널 입력 쓰기의 순서 보장을 깨뜨린다.
- **settings.json 쓰기를 단일 writer 태스크(채널)로 모은다.** 직렬화가 더 강하게 보장되지만 저장 실패를 호출자에게 돌려주는 경로가 사라지고, 종료 시 flush 를 따로 설계해야 한다. mutex + 원자적 교체로 같은 불변식을 훨씬 작게 얻는다.

## Consequences

- cd·워크스페이스 전환·주기 폴링이 더 이상 창을 세우지 않는다. 느린 대상(UNC·네트워크 경로, 차가운 `wsl.exe`, 큰 세션 디렉터리, 연결 많은 머신의 `netstat`)에서 차이가 가장 크다.
- 사용자 눈에 보이는 동작은 "멈춤"에서 "조금 늦게 채워짐"으로 바뀐다. 이미 각 view 가 loading 상태를 갖고 있으므로 추가 UI 는 없다.
- 두 게이트(`SETTINGS_WRITE_LOCK`, 기존 `MEMO_LOCK`)는 leaf 락이다 — 보유 중에 다른 락을 잡지 않고 파일 하나를 쓴 뒤 놓으므로 §14.3 의 `AppState` 락 순서에 편입될 필요가 없다. 이 성질이 데드락 자유의 근거이므로, 게이트를 잡은 채 `AppState` 락을 잡는 역방향은 금지한다.
- 같은 커맨드의 동시 실행이 가능해진다. 읽기 전용 커맨드는 무해하고, 쓰기 경로는 위 게이트로 덮었다. 앞으로 커맨드를 threadpool 로 옮길 때는 **그 커맨드가 메인 스레드 직렬화에 기대고 있었는지**를 함께 판정한다.
- 스레드 hop 만큼 커맨드 1회 지연이 소폭 늘어난다(수백 µs 규모). 인메모리 커맨드를 옮기지 않는 이유이기도 하다.
- 클립보드 커맨드는 여전히 메인 스레드에서 돈다 — 의도된 미해결이며, `smart_paste` 의 이미지 파일 쓰기는 남아 있는 stall 경로다.
- 회귀 테스트는 ① 대상 커맨드가 `#[tauri::command(async)]` 를 유지하는지(`main_thread_io` 표), ② settings.json 저장이 임시 파일을 남기지 않고 내용을 온전히 교체하는지를 고정한다.
- 새 커맨드를 추가할 때 실행 컨텍스트 판정이 리뷰 항목이 된다. 판정 근거는 §14.6 에 있고, 결정을 바꾸려면(예: 클립보드 편입, 터미널 쓰기 경로 이동) 새 ADR 을 쓴다.
