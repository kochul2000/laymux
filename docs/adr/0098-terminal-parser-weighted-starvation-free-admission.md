# 0098. 데스크톱 terminal parser는 가시성 가중치로 starvation 없이 진입한다

- Status: Proposed
- Date: 2026-07-30
- Source: issue #661; [data-flow.md §8.8](../architecture/data-flow.md); [ADR-0092](0092-app-wide-terminal-write-round-robin.md); [ADR-0095](0095-terminal-output-bounded-envelope-and-frame-continuation.md); [ADR-0097](0097-transport-lossless-presentation-lossy-ownership.md)
- Amends: ADR-0092의 동일 우선순위 round-robin과 visible-only admission 범위를 가중·두-lane admission으로 확장하고, ADR-0080의 `setTimeout(0)` macrotask 구현을 브라우저 `MessageChannel`+주기적 timer yield와 timer fallback으로 구체화한다.
- Preserves: ADR-0095의 single receipt slot·두 parser 교집합 ACK와 ADR-0097의 lossless transport/backpressure 계약은 유지한다.

## Context

여러 terminal pane이 동시에 출력할 때 각 pane의 byte FIFO가 정확해도 모든 xterm parser와 UI·Automation·input은 같은 WebView main thread를 사용한다. ADR-0092는 visible xterm write를 앱 전역 한 개로 제한하고 turn 사이에 macrotask를 두어 무제한 parser 경쟁을 막았지만, 모든 visible pane을 같은 비율로 처리한다. 사용자가 조작하는 focused pane, 현재 workspace의 다른 visible pane, `display:none` 또는 0 px track로 유지되는 hidden pane이 같은 지분을 가져 foreground 응답성을 우선하지 못한다.

또한 Remote attach용 rendererless checkpoint xterm은 pane-local Promise chain만 사용해 ADR-0092 scheduler를 우회한다. visible 경로만 가중하면 같은 PTY bytes를 소비하는 checkpoint parser 여러 개가 여전히 main thread를 연속 점유하므로 앱 전체 parser 공정성을 주장할 수 없다.

정확성 제약은 우선순위보다 강하다. pane별 byte·callback FIFO, visible/checkpoint의 contiguous parsed 교집합, v3 immutable envelope·single receipt slot, DECSET 2026 continuation, retry identity를 바꿀 수 없다. background도 drop·pause하지 않고 유한하게 진전해야 하며 정상 적체는 parsed ACK 지연과 PTY backpressure로 전달되어야 한다. active xterm write callback을 선점하거나 timeout으로 lease를 조기 반환할 수도 없다.

범위는 desktop WebView 안에서 PTY stream을 소비하는 visible 및 rendererless checkpoint xterm parser admission이다. Remote browser의 별도 event loop, OS/PTY producer scheduling, fit/reflow, window minimize·lock 감지는 비목표다.

## Decision

**Desktop visible xterm과 rendererless checkpoint xterm은 pane당 하나의 owner로 앱 전역 단일 parser lease를 공유하고, owner는 최신 surface 상태에서 도출한 4:2:1 가중치와 bounded age promotion으로 선택한다.**

1. 앱 전역 `TerminalWriteFairScheduler`는 정상 mounted 생명주기에서 동시에 하나의 pane owner admission만 활성화한다. owner는 `TerminalView` xterm effect 생명주기마다 새 opaque `Symbol`이고, stale generation의 cancel/release는 replacement owner에 영향을 주지 않는다.
2. 한 pane의 visible과 checkpoint는 별도 전역 owner가 아니라 하나의 `TerminalParserAdmission` 아래 두 lane이다. lane별 future callback은 최대 하나이고 둘 다 계속 pending이면 번갈아 선택한다. 따라서 checkpoint가 전역 gate를 우회하지 않으면서도 한 pane의 가중 지분을 두 배로 만들지 않는다.
3. 선택 가중치는 focused visible `4`, visible unfocused `2`, hidden `1`이다. hidden은 `display:none`과 0 px track을 이미 관측하는 container visibility ref가 진실원이며 focus보다 먼저 판정한다. priority resolver는 request 때 값을 동결하지 않고 dequeue 때 committed visibility/focus ref를 읽는다. 사용자 설정이나 OS lock/minimize 상태는 입력이 아니다.
4. owner 선택은 smooth weighted round-robin balance를 사용한다. 동일 balance는 pending FIFO 순서로 결정한다. 다른 owner에게 `K=8` turn을 양보한 owner는 age-promoted되고 FIFO의 다른 overdue owner보다만 뒤에 선다. 선택 시점에 pending owner가 `P`개라면 continuously pending pane owner의 최대 대기 `B`는 `K + P - 1`개의 다른 completed turn이다. 두 lane이 모두 saturated이면 특정 lane은 첫 owner 대기 `B`, sibling 한 turn, 다시 owner 대기 `B`를 거칠 수 있으므로 lane의 보수적 최대 대기는 `2B + 1` turn이다. 새 arrival는 overdue owner를 앞지르지 않는다.
5. priority 변경은 다음 dequeue부터 balance와 weight에 반영한다. 이미 active인 write는 선점·취소하지 않으며 materialized batch, envelope identity, sequence, callback을 바꾸지 않는다. resolver 실패는 background로 fail-safe 분류하되 admission 자체를 멈추지 않는다.
6. active callback이 끝나기 전 이미 알려진 다음 local lane/turn을 예약하고, scheduler가 lease를 반환한 뒤 새 macrotask에서 다음 owner를 실행한다. 브라우저에서는 앱 전역 scheduler가 재사용 `MessageChannel`의 메시지 하나에 callback 하나만 FIFO로 넘겨 xterm parser timer와 scheduler timer의 중첩 clamp를 피하고, 채널을 지원하지 않거나 만들 수 없으면 `setTimeout(0)`으로 폴백한다. checkpoint Promise chain의 다음 operation이 callback 직후 microtask에서야 보이는 경우에는 pane-local admission이 global lease를 한 host-task edge 동안 유지한다. 남은 byte·callback quantum에 operation 전체가 들어갈 때만 같은 lease에서 즉시 실행하고, byte 수를 알 수 없거나 operation을 일부만 처리할 수 있거나 둘 중 하나를 소진했으면 same-owner future turn을 requeue한 뒤 lease를 반환한다. continuation이 lease를 재사용하면 보류한 해제 timer를 취소해 다음 xterm parser timer 앞에 no-op host task를 남기지 않는다. 따라서 작은 PTY segment마다 admission macrotask를 하나씩 소비하지 않으면서 operation 분할, 현재 task의 byte/callback 독점과 weighted balance 유실을 모두 막는다. parser callback timeout이나 UI 상태 변화로 lease를 조기 반환하지 않는다. 동기 throw·backpressure의 기존 idempotent release 계약은 유지한다. 단, unmount/profile replacement는 이미 dispose한 old xterm의 accepted write를 취소할 API가 없으므로 active lease를 해제할 수 있다. 이 경우 old generation마다 최대 한 stale physical callback만 남을 수 있고, 그 callback/release는 새 owner의 상태나 lease를 바꾸지 않는다.
`MessageChannel` task source가 Tauri event·input·paint를 장시간 추월하지 않도록 15개 handoff 뒤 열여섯 번째 handoff는 `setTimeout(0)` gate를 거쳐 다시 `MessageChannel`로 제출한다. 최대 8-pane 기준 두 owner round 안에 한 번인 유한 bound이며, 8-turn gate에서 screenshot과 겹친 8-pane checkpoint catch-up이 3초를 반복 초과한 실측을 반영한다. timer는 parser turn을 직접 실행하지 않고 channel queue를 비운 채 browser task-source에 한 번 양보한다. 실제 xterm write는 그 다음 non-timer task에서 시작하므로 xterm parser timer의 nesting level도 초기화되고, 모든 turn을 timer로 넘기던 처리량 회귀를 되살리지 않는다.

7. 다른 pane owner가 pending인 turn은 non-stabilized fresh visible write 한 번과 checkpoint turn의 누적 physical callback bytes를 최대 64 KiB로 제한한다. 앱에 이 pane만 있으면 기존 256 KiB live/checkpoint fast path를 유지한다. checkpoint lease는 두 경우 모두 최대 128개의 physical callback만 연속 실행하며 byte 상한과 callback 상한 중 먼저 도달한 경계에서 handoff한다. 이 128은 visible batch의 part 상한과 같은 hard liveness bound지만 별도 checkpoint 의미 상수로 소유한다. replay callback barrier는 64 KiB 이하이고, stabilized string/frame의 최대 1 MiB 원자 write와 이미 materialize된 retry batch는 경쟁 중에도 자르지 않는 기존 예외다. retry identity는 변경하지 않는다.
8. background weight 1은 pause나 presentation drop이 아니다. hidden pane의 두 parser와 parsed ACK도 계속 전진하며 부족한 처리량은 ADR-0097에 따라 PTY backpressure로 전달한다. congestion을 reset/replay/replacement attach/fail-stop 사유로 승격하거나 visible parse 전 ACK하지 않는다.
9. parsed frontier는 ADR-0095대로 visible과 checkpoint가 모두 완료한 contiguous prefix의 교집합이다. scheduler는 receipt/hold/close/ACK identity, generation당 하나인 unreceipted envelope, 5초 progress/continuation deadline을 소유하거나 변경하지 않는다. 1초 exact pull watchdog은 500 ms 이상 늦은 tick을 관측하면 같은 main-thread stall 동안 queued된 Tauri output event를 repair가 추월하지 않도록 그 시점부터 정상 watchdog 한 주기의 grace를 둔다. grace deadline은 직전 관측 tick에서 3초를 넘지 않게 고정한다. `setInterval` 위상 때문에 grace 안에 일찍 도착한 callback도 deadline을 연장하지 않고 보류하며 deadline 뒤 첫 tick은 반드시 poll한다. 따라서 관측 poll 간격은 최대 3초라 기존 5초 receipt deadline에 최소 2초의 여유를 남기고 지속 stall에서도 pull을 계속 생략하지 않는다. wall-clock bound는 accepted xterm callback이 유한하게 끝난다는 기존 liveness 가정에 의존한다. rendererless checkpoint capture의 3초 deadline과 Automation bridge의 5초 deadline에 여유를 남기기 위해 2/4/7/8-pane 실측은 backlog가 있는 background owner의 sampled service gap뿐 아니라 flood 중 고정한 `writeSeq` target까지 parsed 교집합 전체가 catch-up하는 시간도 3초 미만임을 검증한다.

10. backend는 새 frozen in-flight envelope를 만든 시점부터 최대 1초이자 configured receipt timeout의 절반인 direct-event grace를 고정한다. grace 안의 matching repair는 emit 성공·실패·callback 진행 상태와 무관하게 `eventPending`을 반환하고 envelope, repair attempt, receipt deadline을 바꾸지 않는다. 이는 build→emit과 emit→WebView listener 사이의 watchdog 선점을 막는다. synchronous emitter 호출 직전에는 같은 state lock 아래 현재 in-flight identity를 다시 확인하고 deadline을 arm하며, 이미 receipt된 identity면 호출을 생략한다. 따라서 receipt가 arm 전후 어느 쪽에서 이겨도 stale emit을 시작하거나 deadline 없는 hung call을 만들지 않는다. frontend는 `eventPending`을 받으면 일반 delayed-tick grace를 해제하고 다음 interval callback을 반드시 poll하므로 scheduler가 추가 watchdog 지연을 만들지 않는다. 정상 1초 timer 위상에서는 실제 유실이 생성 뒤 2초 이내 `exact`로 복구되고 production 5초 receipt deadline에 약 3초가 남는다. main thread 자체가 지연되면 복귀한 첫 callback이 즉시 poll하지만 backend의 5초 hard deadline은 연장하지 않는다. mismatch/stale 판정은 grace보다 먼저 수행한다.

## Alternatives Considered

- **모든 pane이 각자 unrestricted `xterm.write`를 수행한다.** pane 내부 순서는 단순해지지만 같은 WebView main thread에 여러 parser task를 더 빨리 공급한다. ADR-0092의 8-pane 측정에서 수초 Automation timeout과 76초 health report 지연을 만든 경쟁으로 돌아가므로 선택하지 않았다.
- **visible write만 4:2:1로 가중한다.** rendererless checkpoint가 동일 bytes를 scheduler 밖에서 파싱해 main-thread 비용과 parsed 교집합을 계속 지배하므로 선택하지 않았다.
- **visible과 checkpoint를 별도 global owner로 둔다.** 구현은 작지만 각 pane이 owner 두 개를 가져 pane 수가 아니라 내부 lane 수에 따라 지분이 달라진다. pane-local composite lane으로 교대한다.
- **strict foreground priority 또는 hidden parser pause.** background의 5초 parsed-progress expiry, ring pressure, reconnect checkpoint stale을 정상 부하에서 만들 수 있다. 모든 등급에 양의 weight와 age bound를 둔다.
- **hidden workspace refresh 주기만 늦춘다.** hidden surface는 이미 fit·atlas·manual refresh 일부를 생략하지만 xterm parser와 checkpoint는 계속 bytes를 소비한다. 실제 scarce resource인 parser admission을 제어한다.
- **byte drop, sampling, tail-only 표시, early ACK.** transport·parse lossless와 reconstructable checkpoint 계약을 깨므로 선택하지 않았다.
- **가중치를 사용자 설정 또는 자동 튜닝으로 노출한다.** 정확성 acceptance보다 정책 공간이 먼저 커지고 재현성이 낮아진다. 초기 값은 내부 상수로 고정한다.

## Consequences

- focused/visible pane이 hidden flood보다 더 자주 parser turn을 얻고, workspace/focus 전환은 xterm 재생성 없이 다음 dequeue부터 반영된다.
- checkpoint도 전역 단일 lease와 64 KiB contended quantum을 사용하므로 정상 mounted 생명주기의 active desktop xterm physical write는 앱 전체에서 최대 하나다. 한 checkpoint lease 안의 callback도 직렬이며 누적 byte quantum과 128 callback 상한을 넘지 않는다. v3 checkpoint는 같은 envelope의 contiguous same-geometry delta를 먼저 합쳐 callback 수 자체도 줄인다. unmount/profile replacement의 bounded stale callback 예외는 Decision 6을 따른다.
- owner 수가 늘면 background throughput과 최종 drain 시간은 감소할 수 있다. 이는 의도한 responsiveness 우선순위이며 byte를 버리지 않고 PTY backpressure로 나타난다. single-pane 256 KiB fast path는 유지한다.
- smooth balance, age counter, pane-local two-lane arbiter와 16-turn browser task-source yield counter가 scheduler 상태에 추가된다. 결정적 테스트는 4:2:1 share, latest-state reclassification, `K+P-1` owner bound, lane alternation/dedupe/cancel, one-active lease, byte·128-callback quantum, xterm-like timer 순서, 15회 `MessageChannel`+1회 timer yield, callback FIFO를 고정해야 한다.
- 2/4/7/8 hot-pane 150,000-line dev 측정은 Automation control echo/screenshot latency, frontend health, parser frontier service gap, 고정 frontier target의 전체 catch-up, throughput, final marker와 fail-stop/repair를 함께 기록한다. bridge·diagnostics·실제 image payload가 있는 screenshot·control echo와 frontend report age는 모두 5초 미만이어야 하며 backend bridge timeout도 없어야 한다. control echo는 run마다 5회 측정해 p50/p95/max를 남긴다. 실제 OS key latency는 devinput lease를 사용한 별도 실측으로 기록한다. 3초 checkpoint catch-up 또는 5초 parsed-progress 계약을 넘으면 weight·quantum을 재검토하되 single-slot·lossless 계약을 우회하지 않는다.
- #683의 multi-receipt pipeline은 채택하지 않는다. receipt RTT가 실제 병목으로 다시 측정되면 batching/ACK 집계를 먼저 검토하고, slot 확대는 별도 ADR로 다룬다.
