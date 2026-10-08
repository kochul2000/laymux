# PTY 데몬 업데이트 인계 구현·검증 계획

- 상태: 구현 진행 중. 기본 GUI·업데이트 경로는 기존 동작이며 daemon 인계 미활성화.
- dev 검증 경로: `LAYMUX_PTY_DAEMON=1`에서 생성·입력·headless 화면 adapter를 연결했다. source 단일 writer·offline CWD/귀속 저장·renderer detach·업무 이벤트 journal·native receipt를 연결했다. 업데이트 인계·source critical probe·hook/CLI는 계속 구현 중이며 실제 앱 기동·인계 검증이 완료될 때까지 기본 경로로 활성화하지 않는다.
- 결정 정본: [ADR-0300](../adr/0300-detached-pty-daemon-update-handoff.md), [ADR-0301](../adr/0301-pty-daemon-private-ipc-and-parser-runtime.md)
- GUI 계약: [ADR-0302](../adr/0302-pty-daemon-gui-projection-and-control-barriers.md). daemon 도메인 테스트 25개, bootstrap 설정 roundtrip 1개, source 완료 확인 FIFO 테스트 3개, parser 화면 비교 21개, daemon metadata admission 및 기존 attach coordinator 39개가 통과했다. TerminalView/checkpoint model 393개는 이후 resync 변경 전 결과이며, 추가 resync 회귀 테스트 1개와 최신 TypeScript 검사는 통과했다. 전체 스위트 완료를 뜻하지 않는다.
- 기준: PR #1142가 포함된 main. Windows·Linux, dev(19281)만 실행 검증.

## 구현 전 확인할 경계

현재 `AppState`는 PTY·출력·귀속·입력 fence와 GUI 서비스 상태를 함께 가진다. `app_update_install.rs`는 conclusive checkpoint 뒤 `update_install_guard.rs`를 통해 사용자 PTY까지 종료한다. `useSessionCheckpointLifecycle`와 `persist-session.ts`가 UI 구조와 provider snapshot을 수집하며, protocol reply는 PC WebView xterm이 만든다. 다음 표는 아직 구현되지 않은 목표 배치다.

| 경계                | 현재 진입점                                                       | 목표 책임                                                |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| PTY와 제어 FIFO     | `pty.rs`, `pty_control.rs`, `pty_reader.rs`, terminal commands    | Tauri 비의존 Rust terminal core와 daemon                 |
| OSC와 훅·귀속       | PTY output callback, `osc*`, `agent_hooks`, `commands/*_session*` | daemon에서 live 처리·일반 저장, GUI에는 구조화 상태 전달 |
| 출력·protocol reply | `terminal_output`, PC xterm, Remote mirror                        | daemon의 headless parser/ledger와 화면 구독 adapter      |
| UI 구조·설정        | workspace/dock/settings store, `persist-session.ts`               | GUI 구조 revision 제출, 설정 projection 유지             |
| DB commit           | `local_state`, session checkpoint commands                        | daemon의 session writer, GUI의 구성 writer               |
| 수명주기            | `AppState::Drop`, session checkpoint, updater/installer guard     | detach·shutdown 분리와 인계 transaction                  |
| 런타임 배치         | ConPTY staging/build.rs/NSIS                                      | live daemon bundle pin, 새 bundle staging, idle GC       |

## 단계와 완료 조건

### 2026-10-08 완료된 수정의 독립 PR 분리

- [PR #1145](https://github.com/kochul2000/laymux/pull/1145): 빈 레이아웃 템플릿의 세션 구조 복원과 폐기된 초기화 응답 차단을 기본 앱 수정으로 분리해 main에 머지했다. 최신 main 기반 Windows unit 5,450개·screen 106개·E2E 533개, TypeScript·production build·lint/format과 Linux 기본 앱의 격리 SQLite 복원을 검증했다. 늦은 실패가 현재 저장을 차단하는 회귀 테스트도 추가했다.
- [PR #1146](https://github.com/kochul2000/laymux/pull/1146): 연속 wider reflow의 마지막 유지 행 soft-wrap 보존을 데스크톱 ESM/CJS·Remote CJS 수정으로 분리해 main에 머지했다. Windows unit 5,452개·screen 112개·E2E 533개와 세 번들의 실제 셀 테스트를 통과했고, Linux dev에서 15→36→72열 변경 중 95자 문단·hard line을 보존하는 것을 API buffer dump·스크린샷으로 확인했다.

두 PR의 ADR 판정은 불필요(기존 복원·wrap 의미를 지키는 지역적 버그 수정), 버전 영향은 patch다. main을 이 브랜치에 반영해 동일 변경을 데몬 PR diff에서 제거했다. daemon 단일 session writer·정상 GUI detach/업데이트 인계와 Windows 실행 검증은 별도 완료 조건으로 남는다.

### 2026-10-08 목표 완주 진행: source 저장·renderer 수명·업무 이벤트

세션 저장을 protocol 2의 독립 인증 request로 전환했다. source가 GUI 구조 revision과 epoch을 검증하고 CWD·provider 귀속을 재관측한 뒤 SQLite에 반영한다. 늦은 저장 순서 역전, stale generation, owner detach, profile 전환, source 입력/identity 변경을 거절한다. 기존 verified ID의 Unknown 보존과 DB busy 시 이전 commit 유지, 미접속 background CWD 갱신을 IPC/SQLite 테스트로 확인했다.

renderer unmount는 현재 모든 workspace layer/dock content와 restart epoch를 기준으로 presentation release와 명시 source close를 구분한다. Linux dev(19281)의 workspace 이동에서 source child PID 76372·generation 1을 유지했고, 별도 cold fixture에서 view 삭제/교체는 PID 93794·generation 1을 종료하여 PID 112100·generation 3으로 교체하면서 옆 PID 93822를 유지했다. 실제 OSC CWD 변경이 GUI pane metadata와 격리 SQLite의 `lastCwd`에 모두 반영됐다. source 설정 projection은 재접속과 runtime 변경에 현재 SyncGroup/CWD flags를 반영한다.

업무 이벤트는 1 MiB/4,096개 journal로 전달하고 source generation을 현재 delivery generation으로 변환한다. 최초 접속/보관 gap은 catalog 상태를 다시 게시하며 transient 알림을 새 접속에 재생하지 않는다. receipt capture/commit도 source 조회로 라우팅했다. 실제 native PTY의 OSC 제목 → source 귀속 관측 → 동일 writer DB commit → receipt 발급·재사용 및 identity 변경 시 폐기를 IPC 테스트로 검증했다. critical probe·hook/CLI·updater 인계는 구현 중이다.

이번 범위의 Windows UI unit 430개·TypeScript·production build가 통과했다. Linux 전체 Rust 앱 2,297개·agent hook 20개·portable PTY 12개가 통과했으며 이후 추가한 same-generation 관측 테스트를 포함한 daemon 46개도 통과했다. 병렬 PTY 테스트가 test pipe writer를 상속하던 EOF fixture 결함은 `CLOEXEC`로 수정해 전체 스위트에서 재검증했다. 최종 전체 검증 및 Windows Rust/installer 수용 검증을 완료했다는 의미는 아니다.

ADR: [0303](../adr/0303-pty-daemon-session-writer-revisions.md)·[0304](../adr/0304-pty-daemon-business-event-journal.md), renderer/receipt source 책임은 ADR-0302 직접 적용. 버전 영향: minor — PR 전체의 호환되는 데몬 기능 추가.

### 2026-10-08 후속 검증: 초기 복원과 Tokio 호출 경계

레이아웃 템플릿이 비어 있을 때 `applyWorkspaceSnapshot`이 저장된 workspace까지 건너뛰는 오류를 회귀 테스트로 재현하고 수정했다. 폐기된 초기화 effect의 늦은 응답도 현재 workspace를 덮어쓰지 않는다. Linux dev(19281)에서 GUI 종료 뒤 파일 trigger를 만들었을 때 기존 셸이 작업을 완료했고, 새 GUI에서 같은 daemon incarnation·child PID·PTY generation·pane ID와 실행 결과 화면이 자동 복원됐다. 이 검증은 강제 GUI 종료/재접속이며 updater 인계나 정상 종료 barrier 검증을 대신하지 않는다.

CWD·provider 귀속 조회는 인증된 source 상태로 연결했다. 실제 IPC 테스트는 GUI-local PTY가 없는 경우의 성공과 attachment 폐기 뒤 오류를 검증한다. 최초 구현은 Tauri의 `#[command(async)]` 호출 문맥에서 중첩 runtime panic을 일으켰다. 같은 문맥에서 실패를 재현한 뒤 동기 bridge의 runtime 경계를 수정했으며, 일반 스레드·multi-thread/current-thread Tokio 호출과 Linux dev 화면에서 재검증했다. GUI external projection은 checkpoint receipt를 발급하지 않는다. source receipt·critical probe 이관은 여전히 남았다.

Linux 디버그 이미지의 SHA-256 전체 검증이 launcher의 5초 제한을 초과하는 것도 실측했다. dev 프로필에서 `sha2` 의존성만 최적화하여 검증이나 deadline을 생략하지 않고 자동 시작·실제 셸 입력을 통과시켰다. Linux private socket fixture도 실제 0700 디렉터리를 사용하도록 수정했다.

Windows UI 검증은 격리된 Windows 사본에서 실행했다: unit 5,463개, screen 127개, Playwright 533개, TypeScript·production build·전체 ESLint 통과. Linux Rust 전체 라이브러리 테스트 2,311개(앱 2,279개·agent hook 20개·portable PTY 12개), `cargo fmt --all -- --check`와 `git diff --check`도 통과했다. `cargo clippy --locked --workspace --all-targets`와 `cargo check --locked --release`는 경고가 남은 상태로 성공했다. Windows Rust 검증은 애플리케이션 제어 정책이 build script 실행을 거부하는 `os error 4551`로 차단됐다. 이 제한은 앞선 job breakaway 실패와 별개이며, 허용된 Windows 실행 환경에서 둘 다 확인해야 한다.

ADR: [0300](../adr/0300-detached-pty-daemon-update-handoff.md)·[0301](../adr/0301-pty-daemon-private-ipc-and-parser-runtime.md)·[0302](../adr/0302-pty-daemon-gui-projection-and-control-barriers.md)의 직접 적용이다. 이번 복원·runtime 경계·검증 최적화는 소유권이나 외부 계약을 추가로 변경하지 않는다. 버전 영향: minor — 전체 PR은 호환되는 PTY 데몬 기능을 추가한다. 현재 미완성 상태의 독립 릴리스는 진행하지 않는다.

### 2026-10-08 작업 인계: 미완성 구현을 draft PR에 게시

실제 dev(19281)의 worktree·PID를 검증한 뒤 daemon-owned PowerShell에 API로 입력하고 실행 결과가 실제 xterm buffer와 screenshot에 나타나는 것을 확인했다. GUI를 `scripts/kill-dev.sh`로 종료한 뒤 임시 파일 trigger를 생성했고, GUI가 없는 동안 같은 자식 프로세스가 명령을 완료해 확인 파일을 썼다. 새 GUI의 인증된 catalog에서 기존 daemon incarnation·child PID·PTY generation이 유지된 것도 확인했다.

**재시작 후 사용자 화면 복원은 실패했다.** 새 GUI가 저장된 terminal pane 대신 새로운 ID의 EmptyView pane으로 시작해서 실행 중인 기존 terminal에 자동 연결되지 않았다. SQLite의 세션 revision은 증가하고 있으나 구조 저장·로드·초기화 중 어느 단계에서 기존 pane을 대체하는지 아직 확정하지 않았다. 이 결과는 자동 복원·업데이트 인계 성공으로 기록하지 않는다.

Windows에서 `cargo tauri dev`의 자식으로 실행한 분리 launcher는 `CREATE_BREAKAWAY_FROM_JOB` spawn에서 Access denied를 반환했다. 별도 실행 모드로 먼저 시작한 동일 격리 daemon에는 dev GUI가 연결됐다. 시작 제한을 우회하는 제품 코드는 추가하지 않았으며 자동 시작 경로의 지원 조건과 dev 재현 절차는 후속 검증이 필요하다. 실측용 script·trigger·screenshot·private bootstrap은 `.tmp/`·`.screenshots/`에만 있고 커밋하지 않는다.

남은 작업:

- [x] 구조 저장·로드·초기화의 pane ID 소실을 재현 테스트로 고정하고 같은 terminal로 자동 재연결한다(Linux dev 실측).
- [x] 구조 revision 제출과 동시·늦은 저장의 source 검증을 연결한다(인증 IPC, epoch·generation·hint/입력 revision).
- [x] GUI 구조 revision 제출과 daemon의 단일 session SQLite writer를 연결한다. 미접속 background writer·Unknown 보존을 IPC/SQLite로 검증했고 Linux dev 실제 OSC CWD 저장을 확인했다. native/WSL agent의 실제 대화 전환 수용 검증은 남았다.
- [ ] provider 귀속·receipt·critical status probe를 daemon 상태로 라우팅한다. GUI mirror의 PID·generation을 검증 증거로 사용하지 않는다.
- [ ] business OSC/activity/hook 상태 전달, daemon 수명의 `lx`, WSL hook 수신 경로를 연결한다.
- [x] GUI unmount/재연결과 명시적 삭제·profile restart를 분리한다. Linux dev workspace 이동에서 PID·generation 유지, view 삭제/교체에서 정확한 source 종료와 새 generation을 실측했다. profile/restart 판단과 stale renderer cleanup은 회귀 테스트로 검증했다.
- [ ] 업데이트·앱 재시작의 구조 commit/drain/detach ACK와 설치 실패 후 재연결을 구현한다. 실제 종료·hidden eviction의 기존 critical barrier는 유지한다.
- [ ] source/worker 소실·shutdown·idle runtime GC·버전 호환을 완성하고 다른 process나 live bundle을 임의 종료/교체하지 않음을 검증한다.
- [ ] 큰 scrollback의 checkpoint 예산, DEC 2026/shadow cursor·누락 스타일 상태, theme 변경, Remote mirror 복원을 검증·보완한다.
- [ ] 입력마다 만들어지는 monitor thread·output 조회 연결/runtime 비용을 줄이고 다중 pane flood·느린 GUI·Remote owner 전환을 실측한다.
- [ ] daemon 도메인의 commands 역방향 의존·큰 파일·unused 경고를 정리하고 CLI/Node 라이선스·배포 리소스·깨끗한 checkout 빌드를 확인한다.
- [ ] `.tmp` 실측을 재현 가능한 테스트로 승격하고 Linux·native/WSL Codex·installer 교체·PC 재기동에 준한 cold restore를 검증한다.
- [ ] 최신 전체 unit/screen/e2e/build/fmt/clippy/lint와 독립 코드 리뷰를 완료한 뒤 기본 제품 경로 활성화 여부를 판단한다.

현재 기본 제품 경로는 daemon을 사용하지 않는다. `LAYMUX_PTY_DAEMON=1`은 dev 전용이며 이 상태로 merge/release하지 않는다.

2026-10-07 중간 검증: GUI 없이 실제 PTY를 실행하는 core, Windows logon 전용 pipe·상호 인증·epoch 폐기, content-addressed runtime과 detached 실행 모드를 구현했다. Windows 별도 process 실험에서 GUI 연결 없이 3초 동안 명령 출력이 진행되고 같은 child PID·generation으로 재연결됐으며 옛 GUI close는 거절됐다. 실제 patched ESM 화면 스위트 125개와 daemon 경계 테스트 17개가 통과했다. cloned Windows child killer의 성공/실패 반환 뒤집힘은 실제 process TDD로 수정했다. 이는 아래 21개 제품 시나리오의 전체 통과를 뜻하지 않는다. GUI mirror·업데이트 인계·offline DB/hook·Linux·dev 앱 검증은 계속 진행한다.

각 단계는 ADR-0300을 직접 적용하는지와 새 ADR이 필요한지를 계획·PR 직전에 판정한다. 새로운 IPC schema·buffer/retention 수치·배포 런타임 선택은 구현 PR에서 먼저 기록한다. 아래 구현 PR은 선행 설계 검토 뒤 진행하며, 단계별 검증을 통과할 때만 다음 단계로 옮긴다.

### 0. VT worker와 Windows 설치 실험

- frontend와 같은 xterm 버전/패치의 headless worker를 실행해 native PowerShell·WSL Codex의 실제 byte fixture를 넣는다. worker에 필요한 배포 런타임, public snapshot export/import, timers·Unicode width 옵션을 검증하고 확정한다.
- `DSR/DA/DECRQM/OSC 4·10·11·12`, normal/alternate buffer, cursor·scroll region, wide/grapheme, resize, DECSET 2026을 비교한다. 화면 주장은 mock 대신 실제 xterm cell suite로 검증한다. GUI/Remote에서 query reply가 추가로 나가지 않는 것도 확인한다.
- 동일 버전에도 snapshot 손실 보고가 있으므로 마지막 열 cursor/wrap pending과 OSC 8 링크 roundtrip을 회귀 fixture로 고정한다([cursor 보고 #6165](https://github.com/xtermjs/xterm.js/issues/6165), [OSC 8 보고 #6189](https://github.com/xtermjs/xterm.js/issues/6189)). 보고는 미검증 근거이며 실제 셀·링크 상태로 재현/판정한다. 필요한 상태가 serialize에 없으면 검증한 추가 metadata 계약을 먼저 기록한다.
- 임시 버전 디렉터리의 daemon·ConPTY를 사용해 GUI 설치 디렉터리의 파일 교체가 가능한지 측정한다. 실제 release 설치 경로를 건드리지 않는다.
- headless worker의 권위 있는 snapshot 복원이나 GUI 미접속 query 응답이 성립하지 않으면 기능 구현에 앞서 ADR을 정정한다. Windows 잠금 실험과 VT 결과를 docs에 남긴다.

### 1. Terminal core와 IPC contract 분리

- PTY/OSC/귀속/출력의 핵심 로직에서 Tauri `AppHandle` 의존을 event sink/clock/storage/process adapter로 분리한다. 먼저 기존 앱 내부 adapter로 같은 동작을 유지한다.
- 사용자 전용 named pipe/Unix socket, 인증 handshake, protocol/capability, incarnation·generation·attachment epoch, bounded message/queue와 timeout의 타입을 정한다.
- catalog·create·attach·detach·input·resize·close·shutdown·checkpoint·handoff 요청을 명시적으로 나눈다. input의 ACK 유실은 자동 재전송하지 않는다.
- 단위/IPC 통합에서 순서, 세대 교체, stale ACK/owner, 인증 실패, 동시 기동, frame truncation·부분 read/write, poison/error propagation을 TDD로 고정한다.

### 2. GUI 수명과 분리된 daemon·출력 attach

- Rust terminal core를 daemon에서 실행하고 GUI commands를 proxy로 바꾼다. daemon 시작은 `headless_command`와 플랫폼별 부모 종료/Job Object 정책을 사용한다. 일반 GUI disconnect가 사용자 PTY를 끝내지 않음을 실제 프로세스로 검증한다.
- headless worker가 GUI 미접속 중에도 parse·query 응답을 계속하고 화면 checkpoint를 만든다. daemon output ledger와 GUI 구독 credit를 구별한다. buffer 한도는 측정 뒤 contract로 고정한다.
- GUI 재접속은 동일 catalog를 적용하고 새 PTY를 생성하지 않는다. 화면 checkpoint와 delta의 경계를 검증하고 stale GUI와 Remote 입력을 거절한다.
- worker 오류·IPC 끊김·GUI crash를 daemon/PTY 오류와 구별한다. reconnect 실패 화면에서 작업을 지우지 않는다. orphan terminal은 자동 kill하지 않고 원래 content에 다시 결합하거나 명시적인 처리 대상으로 노출한다.

### 3. GUI 미접속 중 복원 저장과 훅

- 모든 세션 commit은 daemon에서 직렬화한다. UI 구조 revision과 terminal generation이 뒤바뀐 snapshot을 거절하며 hidden layer/dock도 동일하게 처리한다.
- live CWD·정확한 대화 ID·confidence와 부분 재시도는 GUI 없이도 저장한다. Unknown·Fresh·RestorePending·NoAgent의 기존 의미를 보존한다.
- GUI configuration writer와 같은 DB를 사용할 때도 session/machine transaction 책임을 구분하고 DB 잠금/손상/디스크 부족을 전파한다. DB 오류를 빈 catalog로 합성하지 않는다.
- daemon의 `lx`/hook 경로는 GUI PID·Automation 포트에 의존하지 않게 한다. 구 helper와 새 daemon의 호환 여부를 검증한다.

### 4. 업데이트·재시작 인계와 runtime bundle

- build별 immutable version bundle을 staging하고 내용 검증·live pin·idle GC를 구현한다. Windows x64/arm64와 Linux에서 bundle의 실행/재연결을 검증한다.
- 서명 검증/다운로드 → 버전·파일 교체 가능성 확인 → UI 구조 DB commit → daemon 인계 ACK → 제어권 반납 → GUI 종료/설치 → 새 GUI attach 순서를 구현한다.
- 정상 인계는 사용자 PTY에 Ctrl+C·`/status`·terminate를 보내지 않는다. Unknown 대화는 이전 검증 ID를 보존한 채 인계한다. daemon 자체 소실/재시작과 실제 종료의 conclusive barrier는 유지한다.
- GUI-owned probe/helper만 설치 전에 정리한다. 설치 실패·새 GUI 기동 실패·handoff ACK 유실·구 데몬/새 GUI 호환 불일치에서도 작업이 보존되는지 실제 프로세스로 검증한다.
- dev 진단 API는 daemon 신원·catalog·attachment·출력 sequence·commit revision·인계 phase를 제공한다. fixture 전용 연결 장애를 프로그래밍적으로 유발해 검증한다. 외부 Remote 권한 계약을 확대하지 않는다.

### 5. 완전 종료와 출하 검증

- 정상 close, 개별 삭제, hidden eviction은 저장/입력 fence/인터럽트/종료를 실제 대상으로 실행한다. partial ID로 파괴를 승인하지 않는다. 기존 명시적 손실 동의도 대상과 generation에 결부한다.
- daemon·PTY·worker·GUI 임시 probe의 종료 완료를 분리해서 확인한다. dev 종료 helper는 discovery의 port/build/worktree/fixture 신원으로 검증한 dev daemon까지 정리하도록 확장하고 release와 사용자 소유 daemon을 건드리지 않는다.
- full unit/integration/e2e/build, xterm screen, deterministic multi-pane flood bench, 격리 dev 업데이트 인계/restart matrix를 실행한다. 실제 signed installer 검증은 disposable install 디렉터리에서 수행하며 release 인스턴스는 조작하지 않는다.
- 기존 Accepted ADR의 부분 대체 표기, architecture의 소유권·락 순서·IPC·출력·설치·영속 흐름, roadmap과 수동 데이터 보존 절차를 같은 구현 PR에서 갱신한다. 기능이 미완성인 단계에서 기본 종료 경로를 제거하지 않는다.

## TDD·dev 시나리오

| 시나리오                                     | 수용 조건                                                                       | 검증 계층                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| 실행 중 Codex·셸을 두고 GUI 재시작           | daemon/guest process incarnation과 PTY generation 유지, 중복 create/resume 없음 | IPC 통합 + native/WSL dev                   |
| GUI 연결이 없는 상태의 연속 출력             | parser가 진척, 출력 폭주에도 memory/queue 한도 준수, 다른 pane 공정성 유지      | terminal core + 결정적 flood bench          |
| detached 상태의 VT query                     | 실제 terminal 상태로 단일 protocol reply, human input revision 증가 없음        | headless/실제 xterm screen + native/WSL dev |
| snapshot 생성·attach 중 추가 출력            | 경계 sequence 앞뒤 누락/중복 없음, 현재 화면·cursor·mode 일치                   | IPC 통합 + 실제 cell screen                 |
| detached 상태의 resize와 normal/alt 전환     | 순서·width·grapheme·DECSET 2026 계약 유지                                       | screen + dev                                |
| GUI crash·새 앱 실행 실패                    | 작업 계속 실행, 다음 GUI에서 같은 terminal에 재연결                             | 프로세스 통합 + dev                         |
| 화면 replay의 과거 query/OSC                 | PTY reply·훅·CWD·대화 이벤트 재실행 없음                                        | core + screen                               |
| client 교체 뒤 옛 입력/resize/ACK/close      | attachment epoch/generation 불일치 거절, 현재 작업 영향 없음                    | IPC TDD                                     |
| human input 완료 ACK 유실                    | 동일 입력 자동 재전송/중복 적용 없음, 실패 상태 명확                            | IPC TDD + 실제 echo process                 |
| IPC 인증·신원 불일치                         | 다른 사용자·로그인 세션·build·profile·dev worktree의 제어 불가                  | Windows/Linux 통합                          |
| daemon 동시 시작·stale discovery·PID 재사용  | 기존 instance handshake 검증, 살아 있는 daemon 강제 교체 없음                   | 임시 경로 프로세스 통합                     |
| 새 GUI와 구 daemon/runtime                   | 직전 출하 버전 조합 통과, incompatible 인계는 설치 전 거절                      | protocol/packaging 통합                     |
| daemon bundle 파일 갱신·GC                   | mtime 변경으로 작업 종료 없음, live 이미지 overwrite/delete 없음                | Windows/Linux filesystem 통합               |
| Windows 설치 파일 잠금                       | GUI 버전 교체 성공, daemon/ConPTY PID 유지, 공유 위반 없음                      | disposable install 실측                     |
| handoff ACK 유실·설치 취소·설치 실패         | 설치 전 실패 전파 또는 live 작업 보존, 새 daemon 중복 생성 없음                 | update TDD + disposable install             |
| GUI 없는 동안 `/new`·대화 전환·CWD 변경      | daemon DB 저장, GUI 재연결/PC 재기동 시 최신 검증 ID·CWD 사용                   | 저장/귀속 통합 + native/WSL dev             |
| provider 조회·WSL timeout                    | Unknown은 이전 ID 보존, detach 인계 가능, 실제 파괴의 barrier 유지              | 저장 TDD + dev 장애 주입                    |
| DB busy·손상·SQLITE_FULL                     | 이전 복원점 유지, handoff 성공으로 오인 없음                                    | 실제 SQLite 통합 + dev                      |
| daemon/VT worker 소실·로그인 세션 교체       | 예전 incarnation 입력/receipt 무효, typed 오류와 복원 경로, 자동 손실 은폐 없음 | 프로세스 통합 + dev                         |
| 완전 종료·개별 삭제·hidden eviction          | 저장 먼저, 정확한 대상만 종료, 명시적 손실 동의 외 우회 없음                    | lifecycle TDD + dev                         |
| PC 재기동에 준한 모든 process 교체·캐시 유실 | 기존 대화 ID로 새 process resume, 메모리 생존과 디스크 복원을 구분              | cold dev fixture                            |

실제 PC 전원 차단 내구성·다른 daemon으로 live handle 이관은 이 표로 검증했다고 주장하지 않는다. 구현 실측 결과와 실패/잔여 범위는 후속 구현 PR별 문서에 남긴다.
