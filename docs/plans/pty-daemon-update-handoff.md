# PTY 데몬 업데이트 인계 구현·검증 계획

- 상태: 설계 제안, 제품 코드 미구현
- 결정 정본: [ADR-0300](../adr/0300-detached-pty-daemon-update-handoff.md)
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
