# 0085. PTY geometry cutover는 provenance barrier와 three-phase transaction이 소유한다

- Status: Proposed
- Date: 2026-07-29
- Source: 사용자 요구 · issue [#628](https://github.com/kochul2000/laymux/issues/628) · 구현 이관 issue [#632](https://github.com/kochul2000/laymux/issues/632) · PR #633 독립 리뷰 · [architecture/data-flow.md §8.4·§8.8](../architecture/data-flow.md) · [architecture/api-contracts.md §14.3](../architecture/api-contracts.md) · [ADR-0001](0001-osc-rust-single-pass.md) · [ADR-0008](0008-shell-cursor-shadow-cursor.md) · [ADR-0072](0072-terminal-output-gap-sequence-exact-repair.md) · [ADR-0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md) · [ADR-0084](0084-desktop-terminal-output-parsed-credit.md)
- Extends: [ADR-0072](0072-terminal-output-gap-sequence-exact-repair.md)의 geometry 교차 승격 조건을 physical producer/read/resize 경계에서 예방한다.
- Extends: [ADR-0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md)의 old-grid write-before-fit 원칙을 frontend/backend three-phase cutover로 확장한다.
- Preserves: [ADR-0001](0001-osc-rust-single-pass.md)의 Rust callback 단일 패스와 [ADR-0084](0084-desktop-terminal-output-parsed-credit.md)의 parsed-credit 상한을 유지한다.

## Context

현재 PTY output reader는 `portable-pty`가 반환한 `Box<dyn Read + Send>`에서 blocking
`read()`를 수행한 뒤 Rust output callback을 호출한다. resize는 별도 terminal control worker가
`MasterPty::resize()`를 호출하고, logical output geometry는 physical resize보다 먼저 갱신된다.
callback 시작점에 mutex를 추가해도 다음 경합을 닫을 수 없다.

1. reader가 구 geometry에서 반환된 bytes를 이미 소유한다.
2. 아직 output callback에 진입하지 않았다.
3. resize가 callback gate를 먼저 획득해 physical resize와 새 revision을 끝낸다.
4. 대기하던 bytes가 새 revision으로 기록된다.

reader와 resize를 한 thread에 두고 blocking read를 interrupt하는 것만으로도 exact boundary가 되지
않는다. read를 깨운 순간 이전 geometry에서 생성된 bytes가 kernel/ConPTY pipe에 이미 queued-but-unread
상태일 수 있고, child와 console host가 freeze acknowledgement 없이 계속 쓰면 pipe empty 관측 직후에도
old-geometry bytes가 들어올 수 있다. 이 bytes를 physical resize 뒤 읽으면 새 revision으로 잘못
귀속한다. **interruptible read는 control liveness이지 byte provenance 증명이 아니다.**

단순 reader FIFO에는 별도 liveness 결함도 있다. 출력이 없는 terminal의 reader는 blocking `read()`
안에 있으므로 control job을 관측하지 못한다. 유한 시간 안에 read를 깨울 readiness/wake/cancel seam이
없으면 idle terminal의 resize가 영구히 굶는다. exact 구현에는 wake와 provenance가 둘 다 필요하다.

frontend와 backend의 grid 변경도 한 번의 request/response로는 원자화되지 않는다. frontend가 xterm을
먼저 바꾸면 backend safe boundary 전 old bytes를 새 grid에서 파싱할 수 있다. backend가 physical
resize와 revision을 적용한 뒤 reader를 즉시 재개하면 frontend가 아직 old grid인 동안 new bytes가
도착할 수 있다. frontend adoption을 physical apply보다 먼저 하면 apply가 실패하거나 결과가 유실될
때 frontend만 new grid가 된다. 따라서 old prefix를 닫는 prepare, physical/logical apply, frontend
adoption acknowledgement, reader release를 서로 구분해야 한다.

`portable-pty 0.8.1`의 `MasterPty`는 `try_clone_reader() -> Box<dyn Read + Send>`를 제공하지만
공통 reader readiness, wake, read generation, producer freeze, authoritative pipe drain 또는 byte epoch를
노출하지 않는다. Windows 구현의 erased reader는 synchronous `ReadFile`을 사용하고 `get_size()`는
portable-pty가 성공한 resize 뒤 갱신하는 process-local cache다. 이 cache는 오류를 반환한 OS resize의
실제 적용 여부를 증명하지 않는다. Linux의 kernel `TIOCGWINSZ`와 같은 query도 구현별 권위를 명시하고
검증한 adapter를 통해서만 reconciliation 증거가 된다.

boundary는 byte chunk 사이면 아무 곳이나 될 수도 없다. split ESC/CSI/OSC/DCS/APC/PM/SOS와 열린
DECSET 2026 frame을 old/new grid 사이에서 자르면 같은 control sequence가 두 parser geometry에 걸린다.
반대로 bytes를 새 revision까지 application memory에 무제한 staging하면 ADR-0084의 bounded producer
계약을 무너뜨린다.

이 ADR의 범위는 byte provenance barrier, interruptible reader adapter, three-phase transaction,
결과·failure·lock·quarantine 계약을 결정하는 것이다. 실제 portable-pty/upstream seam과 Windows/Linux
adapter, IPC, race/screen test 및 laymux-dev 측정은 issue #632로 이관한다. terminal output 일반
attach·ACK watchdog(#629), output fatal 자동 teardown(#630), 전역 mutex poison 정책(#631)은 비목표다.

## Decision

**PTY geometry는 OS가 증명하는 producer-freeze+pipe-drain 또는 동등한 kernel byte-epoch provenance
barrier가 있을 때만 prepare→apply→frontend-adopt의 three-phase transaction으로 바꾸며, adoption ACK
뒤에만 producer와 reader를 풀어 new-revision read를 허용한다. 그런 primitive가 없으면 exact cutover
구현을 금지한다.**

### 필수 platform provenance capability

- generation별 `PtyGeometrySequencer`가 physical output provenance, read admission, resize transaction의
  유일한 선형화 소유자다. 다만 sequencer mutex 자체는 provenance가 아니다. adapter는 아래 둘 중
  하나를 **platform integration test로 증명**해야 한다.
  1. old geometry를 사용할 수 있는 모든 producer(child process, PTY slave, ConPTY/OpenConsole host와
     resize repaint writer 포함)를 OS acknowledgement로 freeze하고, freeze 전에 pipe에 들어간 bytes를
     authoritative empty까지 drain하는 capability
  2. physical resize와 atomic하게 연결된 kernel epoch가 각 read bytes의 old/new provenance를 직접
     제공하는 capability
- freeze acknowledgement 뒤에는 어떤 old-geometry writer도 새 bytes를 enqueue할 수 없어야 한다.
  drain 완료는 그 freeze와 결합된 authoritative primitive여야 한다. quiet timer, callback 완료,
  `poll()` non-readable 한 번, `PeekNamedPipe()==0` 단독 관측은 concurrent writer를 배제하지 못하므로
  증거가 아니다.
- adapter가 이 capability를 제공하지 못하거나 bundled ConPTY/Linux PTY 실기에서 sabotage 대조군과
  구별하지 못하면 `exactGeometryCutover`를 광고하거나 새 transaction 경로를 활성화하지 않는다.
  기존 guarded-fit 경로를 exact라고 이름만 바꾸는 fallback은 금지한다.
- 별도로 reader adapter는 data readiness와 control wake를 같은 terminal event source에서 기다린다.
  control wake는 이미 시작한 read만 깨우며 다음 read를 잘못 취소하지 않는 generation identity를
  가진다. data, EOF, control wake, platform failure를 구별한다. 이 seam은 idle liveness를 위한 것이며
  위 provenance capability를 대체하지 않는다.

### transaction 상태와 owner 순서

- 상태는 `Idle → Preparing → Prepared → Applying → AppliedAwaitingAdoption → Idle`이다. physical call
  전 확정 실패는 `NotApplied`, 결과 불명확은 `Indeterminate`, terminal close는 `Retired`로 간다.
- input write와 resize의 기존 human-control FIFO 순서를 유지한다. resize operation은 prepare부터
  adoption ACK, NotApplied rollback, Indeterminate teardown 중 하나의 **worker completion acknowledgement**
  까지 owner publication barrier에 등록된다. 새 worker를 추가해 input을 추월시키거나 owner epoch를
  일찍 완료 처리하지 않는다.
- caller의 request waiter와 owner publication barrier 수명은 다르다. absolute deadline은 caller
  waiter를 bounded하게 끝낼 수 있지만, 이미 queued/running인 worker의 barrier는 실제 completion 또는
  강제 teardown completion primitive가 확인될 때까지 persistent quarantine에 남는다. 그런 teardown
  acknowledgement가 없으면 Local/다음 owner 공개가 bounded하다고 주장하지 않는다.

### prepare phase: old provenance를 닫는다

- frontend는 `FitAddon.proposeDimensions()`로 새 `cols/rows`를 계산하되 visible/checkpoint xterm grid는
  old geometry에 둔 채 prepare를 요청한다. 요청은 terminal generation, owner epoch, absolute deadline을
  가진다.
- sequencer는 모든 output producer를 platform capability로 freeze한 뒤 pipe에 이미 queued된 bytes를
  authoritative empty까지 읽고 각각 old geometry callback으로 완전히 처리한다. callback 완료에는
  ring 기록, v2/legacy event, activity, Rust OSC action과 desktop credit wait가 포함된다.
- drain 결과가 ESC/CSI/OSC/DCS/APC/PM/SOS 중간 또는 열린 DECSET 2026 frame이면 physical resize를
  하지 않는다. producer를 old geometry로 안전하게 unfreeze하고 다음 freeze+drain을 재시도하거나,
  deadline에 NotApplied로 끝낸다. incomplete sequence를 새 grid까지 application memory에 staging하지
  않는다.
- freeze acknowledgement, authoritative empty, callback completion, lexical neutral을 모두 만족한
  지점에서 read gate와 producer freeze를 유지하며 `{transactionToken, generation, boundarySeq,
  oldGeometry, proposedGeometry}`를 반환한다. `boundarySeq` 뒤의 physical read는 없다.
- prepare request/response가 유실되거나 apply가 오지 않으면 physical call 전이므로 watchdog recovery가
  freeze를 해제하고 old revision을 재개할 수 있다. 단, unfreeze와 worker completion이 실제 확인된
  뒤에만 barrier를 완료한다.

### apply phase: physical과 logical new geometry를 commit한다

- frontend는 visible xterm과 rendererless checkpoint가 `boundarySeq`까지 old geometry에서 실제로
  파싱했음을 ADR-0084 contiguous ACK로 확인한 뒤 같은 token으로 apply를 요청한다. 이 시점에도
  frontend grid는 old geometry이고 producer/read gate는 닫혀 있다.
- apply는 token·generation·owner transaction을 검증하고 physical `MasterPty::resize()`를 호출한다.
  성공 또는 권위 query로 new size가 증명되면 output session geometry revision과 terminal config를
  new geometry로 commit하되 producer와 reader는 계속 막는다. 상태는 `AppliedAwaitingAdoption`이다.
- logical commit이 끝나야 `Applied {newGeometry,newRevision}`를 반환한다. physical call 도중 owner epoch나
  caller deadline이 바뀌어도 이미 적용된 OS resize를 NotApplied로 되돌려 보고하지 않는다.
- physical call이 시작된 뒤 apply response가 유실돼도 reader를 임의 재개하지 않는다. idempotent status
  recovery 또는 reattach가 stored Applied outcome과 authoritative new geometry를 얻어 frontend adoption을
  완료해야 한다. recovery가 정착하지 않으면 generation fail-stop과 teardown으로 간다.

### frontend adoption ACK와 release

- frontend는 `Applied`를 받은 뒤에만 visible xterm과 rendererless checkpoint를 `newGeometry`로 바꾸고
  token·revision을 포함한 adoption ACK를 보낸다. old prefix가 남았거나 apply가 NotApplied/Indeterminate면
  new grid를 채택하지 않는다.
- backend는 adoption ACK가 current transaction의 token·generation·revision과 일치할 때만 producer를
  unfreeze하고 reader gate를 연다. physical resize 이후 pipe에 생긴 resize output과 첫 application
  output은 모두 new revision callback으로 처리된다.
- Applied response 또는 adoption ACK가 유실되면 자동 timeout으로 gate를 열지 않는다. frontend가 이미
  new grid인지 backend가 추측할 수 없으므로 transaction-aware reattach로 authoritative new geometry를
  채택하고 ACK하거나 terminal을 teardown한다. 그 전에는 fail-stop이 정확한 상태다.
- adoption ACK 재전송은 idempotent다. release 완료 뒤 같은 token ACK는 성공한 과거 결과를 돌려주되
  producer/read를 두 번 조작하지 않는다.

### Applied / NotApplied / Indeterminate

- `Applied`: physical resize와 authoritative logical revision commit이 완료됐다. frontend adoption 전에도
  physical outcome은 Applied지만 stream은 `AppliedAwaitingAdoption`에서 멈춘다.
- `NotApplied`: physical call 전에 취소·deadline·lexical/provenance 준비 실패가 확정됐고 producer/read가
  old geometry로 안전하게 복구됐거나, physical call 오류 뒤 **권위 OS query**가 old size임을 증명했다.
- `Indeterminate`: physical call이 시작된 뒤 old/new 어느 geometry인지 권위 있게 확인할 수 없거나,
  physical 적용 뒤 logical revision commit이 실패했다. 추측한 geometry로 producer/read를 재개하지 않고
  generation을 fail-stop한 뒤 reattach/teardown recovery로 보낸다.
- `MasterPty::resize()`가 `Ok`를 반환하면 physical Applied로 본다. 오류·취소·timeout이면 adapter가
  검증한 authoritative OS size query로만 new→Applied, old→NotApplied를 분류한다. Windows
  portable-pty `get_size()` cache는 이 query가 아니므로 Windows에서 별도 권위 primitive가 없으면
  physical-call 이후 오류·취소·timeout은 항상 Indeterminate다.

### 락, 메모리, lifecycle 불변식

- provenance freeze/drain wait, control wake, frontend acknowledgement 대기, physical resize에는 어떤
  `AppState`나 terminal-output lock도 걸지 않는다. drain된 각 callback이 기존 락을 독립 획득하고
  모두 놓은 뒤 다음 단계로 간다. logical commit의 짧은 구간만 `state.rs` 순서로 락을 독립 획득하며,
  일부 commit 뒤 다음 lock이 실패하면 rollback을 가장하지 않고 Indeterminate다.
- Rust OSC parsing/action은 ADR-0001대로 callback에서 한 번만 실행한다. boundary tracker는 framing과
  DECSET 2026 open/close만 추적하고 OSC 의미를 중복 dispatch하지 않는다.
- application-memory output staging을 추가하지 않는다. freeze 전에 생성된 bytes는 prepare drain에서
  old revision으로 즉시 ring/callback을 통과한다. ADR-0084의 512 KiB desktop credit, 4 KiB read chunk,
  1 MiB ring 관계를 유지한다.
- close/retirement는 caller waiter를 bounded error로 끝낼 수 있지만 queued/running platform worker의
  owner barrier는 completion/teardown acknowledgement까지 quarantine한다. poison 또는 thread hang을
  정상 geometry로 복구하거나 barrier 완료로 위장하지 않는다.

### 구현 검증 게이트

- deterministic fake에서 `read 완료→callback 진입 전`, callback 실행 중 prepare, idle read wake,
  resize 직후 첫 read뿐 아니라 **queued-but-unread old bytes와 freeze 직전 concurrent writer**를 재현한다.
- provenance 없는 interruptible reader adapter와 quiet/empty heuristic sabotage가 exact mode 활성화를
  거절하는 양성 대조군을 둔다.
- split ESC/CSI/OSC/DCS/APC/PM/SOS와 DECSET 2026 frame에서 freeze+drain 결과가 neutral일 때만
  Prepared가 되고, 아니면 old geometry 재시도 또는 NotApplied가 됨을 검증한다.
- prepare→apply→AppliedAwaitingAdoption→ACK release 순서, apply response loss, adoption ACK loss,
  idempotent recovery를 검증한다. Applied 뒤 ACK 없이 reader가 재개되는 경로는 없어야 한다.
- owner/deadline이 physical call 전·중·후에 바뀌는 경우, 권위 size query 세 결과, Windows cache가
  reconciliation에 쓰이지 않는 경우를 독립 테스트한다.
- request waiter 종료와 owner publication barrier를 별도로 단언한다. worker가 끝나지 않으면 barrier가
  quarantine에 남고, 강제 teardown completion primitive가 있을 때만 최종 owner 공개를 검증한다.
- Windows bundled ConPTY와 Linux PTY의 실제 producer-freeze/drain 또는 kernel-epoch adapter 통합 테스트를
  둔다. fake adapter만으로 cross-platform provenance를 완료했다고 주장하지 않는다.
- 실제 xterm screen suite에서 boundary prefix는 old grid에서 완결되고, apply 뒤 adoption한 new grid에서
  suffix가 시작해 control sequence/DECSET 2026 frame이 두 grid를 가로지르지 않음을 셀 단위로 비교한다.

## Alternatives Considered

- **output callback entry에 mutex를 건다.** read가 반환된 뒤 callback mutex를 기다리는 bytes를 resize가
  추월할 수 있어 문제의 첫 경합을 그대로 남긴다. 기각했다.
- **interruptible reader와 resize를 한 FIFO에 둔다.** idle liveness는 해결할 수 있지만 pipe에 이미
  queued된 old bytes와 concurrent producer provenance를 증명하지 못한다. 필수 barrier가 아니라 보조
  liveness seam으로만 채택했다.
- **quiet window, poll non-readable, PeekNamedPipe empty로 drain을 추정한다.** producer가 동시에 쓰는
  순간을 배제하지 못해 empty 다음 old byte가 physical resize를 건널 수 있다. freeze/epoch와 결합되지
  않은 heuristic은 기각했다.
- **resize 중 bytes를 backend에 staging한다.** physical resize 전후 provenance를 판별하지 못하고
  sustained output에서 메모리가 무한히 자랄 수 있다. 기각했다.
- **frontend가 new grid를 채택한 뒤 physical resize한다.** apply 실패·response loss 때 frontend만 new
  grid가 된다. physical/logical apply를 먼저 하고 reader는 막은 채 adoption ACK를 받는 3단계를 택했다.
- **physical resize 뒤 즉시 reader를 재개한다.** frontend adoption 전 new bytes가 old grid에 도착한다.
  AppliedAwaitingAdoption gate를 선택했다.
- **portable-pty concrete reader/private handle을 추측한다.** 현재 trait은 producer freeze/drain과
  authoritative query를 제공하지 않는다. upstream seam, 검토된 최소 fork 또는 명시적 platform adapter
  중 하나를 issue #632에서 선택한다.
- **timeout이면 old/new geometry를 추정하거나 cached get_size를 믿는다.** 적용된 resize를 실패로 또는
  미적용 resize를 성공으로 보고한다. 권위 query가 없으면 Indeterminate로 남긴다.

## Consequences

- exact cutover의 전제는 interruptible read보다 강하다. 모든 old producer를 freeze+drain하거나 kernel
  epoch를 얻지 못하면 #632는 exact 구현을 완료할 수 없고, capability를 거짓 광고해서도 안 된다.
- resize는 fire-and-forget IPC가 아니라 prepare, physical/logical apply, frontend adoption ACK, release의
  transaction이 된다. latency와 상태 수가 늘지만 old/new byte provenance와 양쪽 grid adoption을
  각각 증명할 수 있다.
- incomplete lexical sequence는 freeze를 풀고 old geometry에서 재시도하므로 resize가 deadline에
  NotApplied가 될 수 있다. 정확성 gate를 타이머로 뚫지 않는다.
- Applied 뒤 frontend 응답/ACK가 유실되면 terminal output이 fail-stop한다. 화면 가용성보다 잘못된 grid
  parsing 방지를 우선하며 transaction-aware reattach 또는 teardown이 필요하다.
- caller request는 deadline에 끝나도 owner publication은 worker completion/teardown ACK 전까지 막힐 수
  있다. platform 강제 종료가 실제 completion을 보장하지 않으면 이 barrier의 유한 종료를 주장하지
  않는 것이 fail-closed 비용이다.
- Windows portable-pty cached size를 reconciliation에서 제외하므로 post-call 오류는 더 자주
  Indeterminate가 된다. 정확한 분류를 원하면 #632가 별도 권위 OS query seam을 제공해야 한다.
- current `portable-pty 0.8.1`에는 필수 provenance capability가 없으므로 이 ADR만으로 runtime 동작은
  바뀌지 않는다. 실제 adapter·IPC·race/screen test·laymux-dev 검증은 issue #632가 완료한다.
- ADR-0072의 geometry-crossing repair escalation은 구현 전까지 남는다. 구현 뒤에도 과거 generation과
  Indeterminate recovery에는 최후 승격이 필요하다.
- 재검토 조건은 upstream portable-pty 또는 OS가 atomic read/resize byte epoch를 직접 제공하는 경우다.
  그때 producer freeze와 three-phase 계약을 더 단순한 primitive로 대체할 수 있는지 새 ADR에서 평가한다.
