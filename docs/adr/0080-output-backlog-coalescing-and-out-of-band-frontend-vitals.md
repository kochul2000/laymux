# 0080. 스트림 의미는 원래 경계에서 처리하고 xterm 물리 쓰기만 제한적으로 묶는다

- Status: Accepted
- Date: 2026-07-28
- Source: 사용자 보고(출력 폭주와 레이아웃 변경이 겹칠 때 프론트 42~87초 무응답) · issue #606 · [architecture/data-flow.md §8.4·§8.8](../architecture/data-flow.md) · [architecture/api-contracts.md §12](../architecture/api-contracts.md) · [ADR-0008](0008-shell-cursor-shadow-cursor.md) · [ADR-0026](0026-conpty-width-resize-repaint-filter.md) · [ADR-0069](0069-remote-render-checkpoint-attach.md) · [ADR-0072](0072-terminal-output-gap-sequence-exact-repair.md) · [ADR-0074](0074-xterm-cell-grid-screen-test-tier.md) · [ADR-0078](0078-wsl-in-frame-cursor-park-metadata.md) · [ADR-0079](0079-dec2026-cursor-gate-lifecycle-bypass.md)
- Relation: ADR-0008·0078·0079의 커서 안정화 경계와 ADR-0072의 sequence 복구 순서를 유지한다. ADR-0026의 공통 fit 스케줄러에는 출력 도착 시각과 물리 write drain 불변식을 명시한다. ADR-0069 checkpoint는 별도 renderer로서 같은 바이트 순서를 유지한다. ADR-0002의 IP allowlist 아래에 backend-served 진단 endpoint를 추가한다.

## Context

출력이 폭주하는 pane에서 레이아웃을 바꾸면 Automation API의 backend-only `/health`는 즉시 답하지만 WebView를 거치는 endpoint는 수십 초 동안 `Frontend response timeout`을 냈다. 폭주 단독과 레이아웃 변경 단독은 재현되지 않았고, ADR-0072 복구 카운터와 backend 폐기 카운터도 증가하지 않았다. 이는 먼저 화면 손실보다 WebView 메인 스레드의 비용 백로그를 의심해야 하는 신호다.

issue #606은 워크스페이스 전환이 `TerminalView`를 remount하고 1 MiB snapshot을 반복 replay한다고 추정했다. 실제 소유권은 다르다. `WorkspaceArea`와 `PaneGrid`는 활성화된 surface를 마운트한 채 `display:none`으로 숨기고, pane resize도 id를 유지한다. 전환과 resize에는 attach snapshot replay가 없고, hide→show atlas 복구와 공통 fit만 있다.

sequenced delta 하나에는 크기와 무관한 고정 비용이 있다. visible xterm write/parse, rendererless checkpoint apply, native Windows stabilizer와 WSL recognizer, cursor·alternate-buffer·activity 감지기가 작은 delta마다 호출된다. 수천 개 delta가 쌓이면 이 고정 비용과 xterm parse가 WebView event loop를 점유하고 Automation 이벤트도 같은 큐 뒤에서 굶는다.

그러나 세그먼트를 stabilizer와 감지기보다 위에서 합치는 것은 단순한 성능 최적화가 아니다. native stabilizer는 원래 chunk 경계와 50 ms deadline에 의존하고, alternate-buffer 등 감지기는 `enter`와 `leave`를 순서대로 보아야 한다. 상위 apply queue가 `D/A/B` 또는 `?1049h`/`?1049l`을 한 덩어리로 만들면 원래 상태 전이가 사라질 수 있다. 또한 이전 grid용 byte가 남은 상태에서 fit을 먼저 실행하면 정확성을 잃고, 반대로 queue 전체를 한 task에서 비우면 수십 초의 메인 스레드 블록을 다시 만든다.

관측 경로도 부족했다. Rust는 요청 emit 후 5초를 기다리지만 프론트는 deadline을 몰랐고, 늦게 도착한 응답은 pending receiver 유무와 무관하게 조용히 사라졌다. 프론트가 멈추면 그 프론트를 왕복하는 진단 endpoint도 함께 멈추므로, stall 중에 읽을 수 있는 out-of-band 상태가 필요하다.

범위는 데스크톱의 sequenced output 적용·visible xterm write FIFO·공통 fit gate·Automation bridge 관측이다. backend PTY ring, sequence/gap 복구 계약, 커서 안정화 알고리즘 자체, Remote attach wire contract는 바꾸지 않는다.

## Decision

**coordinator 이후의 의미 처리에는 원래 세그먼트 경계를 보존하고, explicit-safe인 ordinary live byte만 visible xterm write FIFO에서 유한하게 묶는다. 프론트 상태는 항상 켜진 reporter가 Rust로 밀어 backend-only endpoint에서 읽는다.**

### 스트림 의미와 checkpoint

- `TerminalOutputAttachCoordinator`가 확정한 세그먼트는 도착 순서 그대로 즉시 native Windows stabilizer/WSL recognizer와 cursor·OSC·alternate-buffer·activity 감지 경로에 전달한다. 이 계층 앞에는 지연·병합 queue를 두지 않는다.
- rendererless checkpoint는 visible 상태 감지와 무관한 별도 parser다. 같은 generation·geometry revision의 sequence-contiguous segment만 최대 256 KiB까지 합쳐 apply할 수 있다. generation, geometry, sequence hole은 필수 경계다.
- 복구 범위와 그 뒤 buffered delta는 coordinator가 정한 전순서를 유지한다. attach/replay와 exact repair의 callback·readiness 의미를 물리 write 배치가 바꾸지 않는다.

### visible xterm write FIFO

- FIFO는 single-flight다. xterm parse callback이 돌아오기 전에는 다음 physical write를 제출하지 않는다.
- 병합은 producer가 명시적으로 허용한 `Uint8Array`, `source:"live"`, 같은 attach epoch·geometry revision인 ordinary request만 가능하다. batch key가 없으면 병합하지 않는다.
- replay, string write, stabilized emission, cursor park deadline, authoritative frame end, composition-active write, `onParsed`/`onDiscard` callback을 가진 request는 각각 barrier다. 이 목록은 안전 추론이 아니라 allowlist다.
- IME composition 상태는 enqueue 때 기록할 뿐 아니라 dequeue 때 다시 확인한다. 기다리는 동안 composition이 시작되면 새 batch를 만들지 않는다. 이미 materialize되어 backpressure로 복원된 multi-part batch는 byte identity를 유지하기 위해 composition 종료까지 기다린다.
- 한 physical write는 최대 128 logical part·256 KiB다. write callback 뒤 다음 batch는 `setTimeout(0)`의 새 macrotask에서 제출해 Automation·input·paint가 끼어들 기회를 둔다. 대화형 idle path의 첫 request는 즉시 제출한다.
- xterm이 동기 backpressure를 반환하면 materialize된 같은 batch 객체와 같은 buffer를 FIFO head에 복원하고 16 ms 뒤 재시도한다. 성공적으로 받아들인 `terminal.write`만 physical write·byte metric에 센다.
- 전체 reattach/unmount는 아직 제출하지 않은 old-epoch request를 discard하고 parsed waiter는 `onDiscard`로 정확히 한 번 종결한다. 이미 xterm이 받아들인 in-flight write는 취소할 수 없으므로 parse callback까지 기다린 뒤 replacement attach의 `reset()`을 실행하고, attach epoch로 stale parse context도 격리한다. 비동기 checkpoint await를 통과한 뒤 visible enqueue 직전에 epoch를 다시 검사하며, replay snapshot도 queue에서 폐기될 때 waiter를 종결한다. snapshot에 포함된 old byte가 reset 뒤 다시 쓰이거나 폐기된 waiter가 attach chain을 영구히 막는 것을 모두 금지한다.

### fit 정확성 우선순위

- Windows quiet window의 기준은 xterm write 시각이 아니라 sequenced delta가 적용 경로에 도착한 시각이다. backpressure 때문에 늦게 쓰인 byte를 가짜 침묵으로 해석하지 않는다.
- grid를 바꾸는 fit은 attach parser, exact repair, native stabilizer transaction과 open lexical sequence, in-flight write, queued write가 모두 끝날 때까지 실행하지 않는다. standalone split ESC/CSI는 완결 byte가 오거나 lifecycle reset이 일어날 때까지 prefix를 stabilizer에 보류하며 유한 timeout으로 old-grid와 new-grid 사이에 쪼개지 않는다. xterm에 이미 fail-open된 partial sequence도 실제 final/terminator가 올 때까지 fit barrier로 남는다. 이전 grid용 byte가 visible FIFO에 남은 채 새 grid로 넘어가는 것보다 fit 지연을 선택한다.
- 이 선택은 sustained flood에서 fit이 오래 굶을 수 있음을 인정한다. 출력 손실 없이 fit도 유한 시간 안에 보장하려면 backend가 old-geometry stream을 원자적으로 닫고 new-geometry stream을 여는 two-phase cutover가 필요하며, 이는 issue #623의 별도 결정 범위다. 이 PR에서 타이머로 정확성 gate를 우회하지 않는다.

### Automation deadline과 out-of-band 진단

- Rust는 `automation-request`에 `emittedAtMs`와 `deadlineMs`를 싣는다. deadline을 넘긴 query는 계산하지 않고 expired 응답을 시도하며, action은 호출자가 요청한 부수효과를 잃지 않도록 실행한다.
- frontend response IPC가 resolve된 뒤에만 `responsesSent`를 센다. IPC 거절은 `responsesFailed`다. Rust는 pending sender를 찾은 것만으로 matched라 하지 않고 oneshot send가 성공한 뒤 `responsesMatched`를 센다. receiver가 없거나 send가 실패하면 `responsesOrphaned`와 누적 로그를 남긴다.
- App-level bridge hook은 250 ms self-rescheduling probe와 1초 health report를 항상 소유한다. probe 지연, stall 수, bridge counter, terminal별 pipeline counter를 `report_frontend_health`로 Rust 상태에 push한다. report 실패는 다음 tick에서 재시도하고 probe 자체를 중단하지 않는다.
- `GET /api/v1/diagnostics/frontend`는 WebView bridge를 거치지 않고 Rust의 마지막 report와 Rust bridge counter를 반환한다. mutex poison은 “아직 report 없음”으로 위장하지 않고 command error 또는 JSON HTTP 500으로 드러낸다.
- 진단 payload는 byte stream·경로·설정을 담지 않고 수치와 terminal id만 담으며 ADR-0002의 기존 IP allowlist를 그대로 적용한다. 어떤 control path도 이 metric으로 동작을 바꾸지 않는다.

## Alternatives Considered

- **coordinator 뒤에 상위 `TerminalOutputApplyQueue`를 두고 세그먼트 전체를 병합한다**: checkpoint와 xterm 호출 수를 크게 줄이지만 stabilizer chunk/deadline, ordered detector transition, repair callback 시점을 바꾼다. 리뷰 회귀 테스트에서 native `?25h` deadline과 alternate-buffer enter→leave 상태를 깨뜨려 기각했다.
- **write가 밀린 동안 queue 전체를 한 번에 합친다**: physical write 수는 최소지만 batch materialization과 parse의 상한이 없어 event loop를 다시 장시간 독점한다. 128 part·256 KiB와 macrotask yield를 선택했다.
- **보류 fit을 queued output보다 먼저 실행한다**: 지속 폭주에서 fit starvation을 피하지만 old-grid byte를 new grid에 파싱한다. terminal cell 정확성을 우선하고 atomic geometry cutover를 후속으로 분리했다.
- **시간 창(microtask/rAF/고정 timer)으로 delta를 묶는다**: Tauri event마다 별도 task라 microtask는 event 사이를 묶지 못하고, 고정 timer는 idle 대화형 출력에도 지연을 더한다. 실제 xterm backpressure FIFO에서만 묶는다.
- **backend가 더 큰 PTY chunk를 emit한다**: frontend 전달 비용은 줄지만 ring/sequence timing과 subscriber 계약을 함께 바꾼다. 이 PR의 관측치가 backend emit을 병목으로 지목하기 전에는 범위를 넓히지 않는다.
- **Automation timeout만 늘린다**: 수십 초 stall을 감추고 죽은 query 재시도를 더 쌓을 뿐 원인을 줄이거나 stall 중 관측을 제공하지 않는다.
- **진단도 기존 Automation bridge로 요청한다**: 가장 필요한 WebView stall 동안 함께 timeout되므로 목적을 달성하지 못한다.

## Consequences

- 커서 stabilizer·DEC 2026 lifecycle gate·alternate-buffer/activity detector는 최적화 전과 같은 logical 경계와 순서를 받는다. 성능 최적화가 cursor state machine의 입력 계약을 바꾸지 않는다.
- visible xterm의 ordinary flood는 bounded batch로 physical write 수와 parse callback 수를 줄이면서 batch마다 event loop에 양보한다. checkpoint도 안전한 contiguous prefix만 별도로 묶는다. stabilizer와 감지기의 per-segment 비용은 남으므로 전체 pipeline이 O(bytes)라고 주장하지 않는다.
- 256 KiB·128 part는 메인 스레드 점유와 병합률의 운영 상수다. `writeQueueMaxDepth/Bytes`, `writeBatchMaxParts`, `writeSubmitMaxMs`, `xtermParseMaxMs`가 재검토 근거다.
- fit은 stream/grid 정확성을 위해 queue drain을 기다린다. sustained flood에서 유한 fit latency까지 보장하지 않으며, 그 요구는 issue #623의 atomic cutover 설계와 함께 재검토한다.
- `/api/v1/diagnostics/frontend`와 `report_frontend_health`가 외부·IPC 계약을 늘리고 상시 소량의 timer/IPC 비용을 만든다. 대신 stall이 진행 중일 때 `lastReportAgeMs`를 읽고 handler 지연과 event-queue starvation을 구분할 수 있다.
- 테스트는 queue allowlist/barrier/상한/backpressure identity, 원래 stabilizer transaction deadline·standalone pending-sequence barrier와 detector 순서, IME composition 중 물리 경계, old-grid write-before-fit, reattach의 queued discard+in-flight drain·checkpoint epoch cutover·replay waiter 종결, exact repair byte stream, 실제 xterm checkpoint 셀 격자와 split-CSI/resize 순서 차이, bridge absolute deadline·send 실패·orphan 분류, reporter stall/recovery를 고정한다.
- 실제 stress A/B 수치는 최종 구현으로 다시 측정해야 한다. 리뷰 전 상위 apply queue 구현의 수치를 이 결정의 성능 증거로 재사용하지 않는다.
