# 0085. PTY geometry cutover는 interruptible reader와 two-phase transaction이 소유한다

- Status: Proposed
- Date: 2026-07-29
- Source: 사용자 요구 · issue [#628](https://github.com/kochul2000/laymux/issues/628) · 구현 이관 issue [#632](https://github.com/kochul2000/laymux/issues/632) · [architecture/data-flow.md §8.4·§8.8](../architecture/data-flow.md) · [architecture/api-contracts.md §14.3](../architecture/api-contracts.md) · [ADR-0001](0001-osc-rust-single-pass.md) · [ADR-0008](0008-shell-cursor-shadow-cursor.md) · [ADR-0072](0072-terminal-output-gap-sequence-exact-repair.md) · [ADR-0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md) · [ADR-0084](0084-desktop-terminal-output-parsed-credit.md)
- Extends: [ADR-0072](0072-terminal-output-gap-sequence-exact-repair.md)의 geometry 교차 승격 조건을 physical read/resize 경계에서 예방한다.
- Extends: [ADR-0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md)의 old-grid write-before-fit 원칙을 frontend/backend two-phase cutover로 확장한다.
- Preserves: [ADR-0001](0001-osc-rust-single-pass.md)의 Rust callback 단일 패스와 [ADR-0084](0084-desktop-terminal-output-parsed-credit.md)의 parsed-credit 상한을 유지한다.

## Context

현재 PTY output reader는 `portable-pty`가 반환한 `Box<dyn Read + Send>`에서 blocking
`read()`를 수행한 뒤 Rust output callback을 호출한다. resize는 별도 terminal control worker가
`MasterPty::resize()`를 호출한다. logical output geometry는 physical resize보다 먼저 갱신된다.
이 구조에서 callback 시작점에 mutex를 추가해도 다음 경합을 닫을 수 없다.

1. reader가 구 geometry에서 반환된 bytes를 이미 소유한다.
2. 아직 output callback에 진입하지 않았다.
3. resize가 callback gate를 먼저 획득해 physical resize와 새 revision을 끝낸다.
4. 대기하던 bytes가 새 revision으로 기록된다.

reader와 resize job을 한 thread의 FIFO로 옮기는 것만으로도 충분하지 않다. 출력이 없는 terminal의
reader는 blocking `read()` 안에 있으므로 control job을 관측하지 못한다. 유한 시간 안에 read를
깨울 readiness/wake/cancel seam이 없으면 idle terminal의 resize가 영구히 굶는다.

frontend가 먼저 xterm grid를 바꾸고 단일 resize IPC를 보내는 계약도 exact cutover가 아니다.
backend가 safe boundary를 찾는 동안 이미 callback을 마친 old-revision bytes가 frontend queue에
남아 있으면 그 bytes가 새 grid에 도착할 수 있다. 반대로 backend가 physical resize를 먼저 하고
reader를 즉시 재개하면 frontend가 아직 old grid인 동안 new-revision bytes가 도착할 수 있다.
양쪽 grid 전환 사이에 acknowledgement phase가 필요하다.

`portable-pty 0.8.1`의 `MasterPty`는 `try_clone_reader() -> Box<dyn Read + Send>`를
제공하지만 공통 reader readiness, wake, read generation 또는 cancel outcome을 노출하지 않는다.
Windows 구현의 erased reader는 synchronous `ReadFile`을 사용하고 Linux 구현은 cloned blocking fd를
사용한다. laymux가 concrete private type을 추측해 깨우는 코드는 portable abstraction도 아니고 두
플랫폼에서 같은 취소 의미를 증명하지도 못한다. 따라서 현재 추상화 위에 callback gate를 억지로
추가하지 않고 필요한 adapter 계약부터 고정한다.

한편 boundary는 byte chunk 사이면 아무 곳이나 될 수 없다. split ESC/CSI/OSC/DCS/APC/PM/SOS와
열린 DECSET 2026 frame을 old/new grid 사이에서 자르면 같은 control sequence가 두 parser geometry에
걸린다. bytes를 새 revision까지 application memory에 무제한 staging하는 방식도 ADR-0084의 bounded
producer 계약을 무너뜨린다.

이 ADR의 범위는 선형화 지점, cross-platform reader adapter, frontend/backend transaction,
결과·failure·lock·bounded cancellation 계약을 결정하는 것이다. 실제 portable-pty seam과
Windows/Linux adapter, IPC, race/screen test 및 laymux-dev 측정은 issue #632로 이관한다.
terminal output 일반 attach·ACK watchdog(#629), output fatal 자동 teardown(#630), 전역 mutex poison
정책(#631)은 비목표다.

## Decision

**PTY geometry는 interruptible reader가 callback-complete lexical-safe boundary에서 read를 멈추는
per-terminal two-phase transaction으로만 바꾸며, frontend가 old prefix를 모두 파싱하고 새 grid를
채택한 뒤 physical resize와 새 revision을 commit하고 reader를 재개한다.**

### 선형화 소유권과 상태

- generation별 `PtyGeometrySequencer`가 physical read admission과 resize transaction의 유일한
  선형화 소유자다. resize의 상태는 `Idle → Preparing → Prepared → Finalizing → Idle`이며 terminal
  close는 어느 상태에서든 `Retired`, 결과 불명확은 `Indeterminate`로 전이한다.
- input write와 resize의 기존 human-control FIFO 순서는 유지한다. resize permit은 prepare부터
  finalize 또는 recovery 종료까지 owner transition barrier에 등록된다. 새 worker를 추가해 input을
  추월시키거나 owner epoch를 일찍 완료 처리하지 않는다.
- reader adapter는 data readiness와 control wake를 같은 terminal event source에서 기다린다. control
  wake는 이미 시작한 read만 깨우며 다음 read를 잘못 취소하지 않는 generation identity를 가진다.
  data, EOF, control wake, platform failure를 구별한다.
- Windows adapter는 bundled ConPTY의 실제 synchronous reader를 cancel-safe generation 또는
  overlapped event로 깨울 수 있어야 한다. Linux adapter는 PTY readiness와 eventfd/self-pipe 같은
  control wake를 한 poll set에서 기다린다. 플랫폼 구현이 달라도 아래 transaction 결과는 같다.

### prepare phase: old geometry를 닫는다

- frontend는 `FitAddon.proposeDimensions()`로 새 `cols/rows`를 계산하지만 xterm grid를 아직 바꾸지
  않고 prepare를 요청한다. 요청은 terminal generation, owner epoch, absolute deadline을 가진다.
- sequencer는 reader를 깨우고 safe cut을 기다린다. safe cut은 (1) 진행 중인 physical read가 없고,
  (2) 마지막 read의 callback이 ring 기록·v2/legacy event·activity·Rust OSC action을 모두 끝냈으며,
  (3) streaming lexical boundary tracker가 ESC/CSI/OSC/DCS/APC/PM/SOS 중간이나 열린 DECSET 2026
  frame 안이 아닌 지점이다.
- lexical state가 열려 있으면 bytes를 staging하지 않는다. reader는 4 KiB chunk를 계속 읽어 현재
  old geometry revision으로 callback을 끝내고 safe cut을 찾는다. absolute deadline까지 닫히지 않으면
  physical resize를 호출하지 않은 `NotApplied`로 끝낸다.
- safe cut에서 sequencer는 read를 멈춘 채 `{ transactionToken, generation, boundarySeq,
  oldGeometry, proposedGeometry }`를 반환한다. `boundarySeq` 뒤의 physical read는 finalize 또는 abort가
  끝날 때까지 시작하지 않는다.
- callback, safe-cut 대기, reader wake 중에는 `AppState`, terminal protocol/runtime/ring/desktop-flow
  mutex를 보유하지 않는다. callback 자체가 필요한 락을 기존 순서로 독립 획득하고 모두 놓은 뒤
  sequencer에 완료를 알린다.

### frontend adoption과 finalize phase: new geometry를 연다

- frontend는 visible xterm과 rendererless checkpoint가 `boundarySeq`까지 old geometry에서 실제로
  파싱한 것을 확인한다. ADR-0084의 contiguous parsed ACK가 이 완료 prefix다.
- 그 뒤에만 visible/checkpoint grid를 `proposedGeometry`로 바꾸고 같은 token으로 finalize를
  요청한다. prepare 전이나 old prefix drain 전에 xterm grid를 바꾸지 않는다.
- finalize는 token·generation·owner transaction을 검증한 뒤 physical `MasterPty::resize()`를
  호출한다. 성공하면 output session geometry revision과 terminal config를 새 크기로 commit하고,
  그 commit 이후에만 reader gate를 열어 첫 new-revision read를 허용한다.
- frontend가 physical call 전에 adoption/finalize를 포기하면 old grid로 되돌린 뒤 abort한다.
  backend는 physical resize가 시작되지 않았음을 확인하고 gate를 old revision으로 재개한다.
- prepare/finalize/abort는 token별 idempotent 결과를 보존한다. IPC 응답이 유실돼도 재시도가 같은
  physical resize를 두 번 실행하지 않는다. prepare 뒤 physical call 전 watchdog 만료는 old geometry로
  abort할 수 있다. physical call 이후 watchdog은 결과를 실패로 재분류하지 않고 recovery가 저장된
  outcome을 소비하게 한다.

### Applied / NotApplied / Indeterminate

- `Applied`: physical resize가 적용됐고 authoritative output geometry revision commit까지 끝났다.
  physical call 도중 owner epoch 또는 deadline이 바뀌어도 이미 적용된 결과를 취소 실패로 되돌리지
  않는다. owner transition은 transaction completion을 기다린 뒤 진행한다.
- `NotApplied`: physical call 전에 owner/deadline/close/lexical-safe-cut 실패가 확정됐거나, platform
  call 실패 뒤 `get_size()`가 old physical geometry임을 증명했다. frontend는 old grid를 복원하고
  reader는 old revision으로 재개할 수 있다.
- `Indeterminate`: physical call이 시작된 뒤 old/new 어느 geometry인지 확인할 수 없거나, physical
  적용 뒤 authoritative revision commit이 실패했다. 추측한 geometry로 bytes를 읽거나 이벤트를
  발행하지 않는다. generation을 fail-stop하고 모든 waiter를 깨운 뒤 explicit reattach/teardown
  recovery로 보낸다.
- platform call이 오류를 반환하면 reader를 멈춘 상태에서 physical size를 재조회한다. new size면
  logical commit 후 `Applied`, old size면 `NotApplied`, 다른 size 또는 조회 실패면 `Indeterminate`다.
  cancellation API가 platform call을 끊었더라도 같은 reconciliation 없이 `NotApplied`라 하지 않는다.

### 락, 메모리, lifecycle 불변식

- reader wait, control wake, frontend acknowledgement 대기, physical resize에는 어떤 `AppState`나
  terminal-output lock도 걸지 않는다. logical commit이 필요한 짧은 구간만 `state.rs` 순서로 락을
  독립 획득하고 I/O 전후로 유지하지 않는다. 일부 commit이 끝난 뒤 다음 lock이 실패하면 rollback을
  가장하지 않고 `Indeterminate`다.
- output callback의 Rust OSC parsing/action은 ADR-0001대로 한 번만 실행한다. boundary tracker는
  framing과 DECSET 2026 open/close만 추적하며 OSC 의미를 중복 dispatch하지 않는다.
- application-memory output staging을 추가하지 않는다. old bytes는 old revision으로 즉시 sequenced
  ring/callback을 통과한다. ADR-0084의 512 KiB desktop credit, 4 KiB read chunk, 1 MiB ring 관계를
  유지한다.
- close/retirement는 pending prepare를 `NotApplied`, prepared transaction을 abort, finalizing 중
  결과가 불명확한 transaction을 `Indeterminate`로 종결하고 reader/control/owner waiter를 모두
  bounded하게 깨운다. poisoned state를 정상 geometry로 복구하는 것은 금지한다.

### 구현 검증 게이트

- fake adapter의 deterministic barrier로 `read 완료 → callback 진입 전`, callback 실행 중 prepare,
  idle blocking read wake, resize 직후 첫 read를 각각 재현한다.
- split ESC/CSI/OSC/DCS/APC/PM/SOS와 DECSET 2026 frame에서 prepare가 safe cut까지 old revision으로
  진행하거나 deadline에 `NotApplied`가 됨을 검증한다.
- owner/deadline이 physical call 전·중·후에 바뀌는 경우와 size reconciliation 세 결과를 모두
  독립 테스트한다. 모든 cancellation/close path는 bounded waiter 종료를 단언한다.
- Windows bundled ConPTY와 Linux PTY의 실제 adapter 통합 테스트를 둔다. fake adapter만으로
  cross-platform interruptibility를 완료했다고 주장하지 않는다.
- 실제 xterm screen suite에서 boundary prefix는 old grid에서 완결되고 suffix는 new grid에서 시작해
  control sequence 또는 DECSET 2026 frame이 두 grid를 가로지르지 않음을 셀 단위로 비교한다.

## Alternatives Considered

- **output callback entry에 mutex를 건다.** `read()`가 반환된 뒤 callback mutex를 기다리는 bytes를
  resize가 추월할 수 있어 문제의 경합을 그대로 남긴다. 기각했다.
- **blocking reader thread의 queue에 resize job을 넣는다.** idle `read()`를 깨울 seam이 없어 resize가
  영구히 굶는다. Windows/Linux 양쪽의 bounded liveness를 증명하지 못해 기각했다.
- **resize 중 들어온 bytes를 backend에 staging한다.** bytes가 physical resize 전후 어느 쪽에서
  생성됐는지 판별하지 못하고, open sequence나 sustained output에서 메모리도 무한히 자랄 수 있다.
  기각했다.
- **frontend fit을 먼저 하고 단일 backend resize IPC를 유지한다.** backend safe cut 전의 old bytes가
  이미 frontend queue에 있거나 IPC 중 새 bytes가 도착할 수 있어 두 grid 사이에 acknowledged boundary가
  없다. two-phase prepare/finalize를 선택했다.
- **physical resize를 prepare에서 먼저 적용한다.** frontend가 old prefix를 아직 파싱하는 동안 backend
  physical geometry가 바뀌고, prepare 응답 유실 시 reader를 어느 grid로 재개할지도 모호하다. physical
  call은 frontend adoption 뒤 finalize에 둔다.
- **`portable-pty` concrete reader를 downcast하거나 private handle layout을 추측한다.** 현재 0.8.1
  trait은 그 계약을 제공하지 않으며 버전·플랫폼별 구현 세부에 의존한다. upstream seam, 검토된 최소
  fork 또는 명시적 laymux platform adapter 중 하나를 issue #632에서 선택한다.
- **timeout이면 old 또는 new geometry를 추정한다.** 이미 적용된 OS resize를 실패로 보고하거나
  반대로 적용되지 않은 resize를 성공으로 보고해 exact stream을 다시 깨뜨린다. 세 결과 계약과
  fail-stop을 선택했다.

## Consequences

- resize는 한 번의 fire-and-forget IPC가 아니라 prepare, old-prefix drain, frontend adoption,
  finalize의 transaction이 된다. 일반 resize latency와 상태 수가 늘지만 old/new grid 사이의 byte
  attribution을 증명할 수 있다.
- lexical sequence나 DECSET 2026 frame이 닫히지 않으면 resize가 deadline에 `NotApplied`가 될 수 있다.
  정확성 gate를 타이머로 뚫지 않으며 UI는 old grid를 유지하고 최신 proposed geometry를 다시 시도한다.
- prepared transaction 동안 reader와 뒤의 terminal control job이 잠시 멈춘다. absolute deadline,
  owner barrier, close wake가 이를 유한하게 제한한다.
- `Indeterminate`는 화면 편의보다 stream 정확성을 우선해 generation을 fail-stop한다. 드물지만
  reattach 또는 PTY teardown이 필요할 수 있고, 그 사건은 독립 metric과 로그로 관측해야 한다.
- current `portable-pty 0.8.1`에는 필요한 공통 seam이 없으므로 이 ADR만으로 runtime 동작은 바뀌지
  않는다. 실제 adapter·IPC·race/screen test·laymux-dev 검증은 issue #632가 완료한다.
- ADR-0072의 geometry-crossing repair escalation은 구현 전까지 남는다. 구현 뒤에도 ring의 과거
  generation이나 indeterminate recovery에는 최후 승격이 필요하다.
- 재검토 조건은 upstream portable-pty가 read/resize ordering을 자체 보장하거나, Windows/Linux PTY가
  physical resize 전후 bytes에 신뢰할 수 있는 epoch를 직접 제공하는 경우다. 그때 two-phase 계약을
  더 단순한 primitive로 대체할 수 있는지 새 ADR에서 평가한다.
