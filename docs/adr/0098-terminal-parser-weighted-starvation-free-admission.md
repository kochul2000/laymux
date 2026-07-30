# 0098. 데스크톱 terminal parser는 가시성 가중치로 starvation 없이 진입한다

- Status: Proposed
- Date: 2026-07-30
- Source: issue #661; [data-flow.md §8.8](../architecture/data-flow.md); [ADR-0092](0092-app-wide-terminal-write-round-robin.md); [ADR-0095](0095-terminal-output-bounded-envelope-and-frame-continuation.md); [ADR-0097](0097-transport-lossless-presentation-lossy-ownership.md)
- Relation: ADR-0092의 동일 우선순위 round-robin과 visible-only admission 범위를 확장한다. ADR-0095의 single receipt slot·두 parser 교집합 ACK와 ADR-0097의 lossless transport/backpressure 계약은 유지한다.

## Context

여러 terminal pane이 동시에 출력할 때 각 pane의 byte FIFO가 정확해도 모든 xterm parser와 UI·Automation·input은 같은 WebView main thread를 사용한다. ADR-0092는 visible xterm write를 앱 전역 한 개로 제한하고 turn 사이에 macrotask를 두어 무제한 parser 경쟁을 막았지만, 모든 visible pane을 같은 비율로 처리한다. 사용자가 조작하는 focused pane, 현재 workspace의 다른 visible pane, `display:none` 또는 0 px track로 유지되는 hidden pane이 같은 지분을 가져 foreground 응답성을 우선하지 못한다.

또한 Remote attach용 rendererless checkpoint xterm은 pane-local Promise chain만 사용해 ADR-0092 scheduler를 우회한다. visible 경로만 가중하면 같은 PTY bytes를 소비하는 checkpoint parser 여러 개가 여전히 main thread를 연속 점유하므로 앱 전체 parser 공정성을 주장할 수 없다.

정확성 제약은 우선순위보다 강하다. pane별 byte·callback FIFO, visible/checkpoint의 contiguous parsed 교집합, v3 immutable envelope·single receipt slot, DECSET 2026 continuation, retry identity를 바꿀 수 없다. background도 drop·pause하지 않고 유한하게 진전해야 하며 정상 적체는 parsed ACK 지연과 PTY backpressure로 전달되어야 한다. active xterm write callback을 선점하거나 timeout으로 lease를 조기 반환할 수도 없다.

범위는 desktop WebView 안에서 PTY stream을 소비하는 visible 및 rendererless checkpoint xterm parser admission이다. Remote browser의 별도 event loop, OS/PTY producer scheduling, fit/reflow, window minimize·lock 감지는 비목표다.

## Decision

**Desktop visible xterm과 rendererless checkpoint xterm은 pane당 하나의 owner로 앱 전역 단일 parser lease를 공유하고, owner는 최신 surface 상태에서 도출한 4:2:1 가중치와 bounded age promotion으로 선택한다.**

1. 앱 전역 `TerminalWriteFairScheduler`는 동시에 하나의 pane owner만 활성화한다. owner는 `TerminalView` xterm effect 생명주기마다 새 opaque `Symbol`이고, stale generation의 cancel/release는 replacement owner에 영향을 주지 않는다.
2. 한 pane의 visible과 checkpoint는 별도 전역 owner가 아니라 하나의 `TerminalParserAdmission` 아래 두 lane이다. lane별 future callback은 최대 하나이고 둘 다 계속 pending이면 번갈아 선택한다. 따라서 checkpoint가 전역 gate를 우회하지 않으면서도 한 pane의 가중 지분을 두 배로 만들지 않는다.
3. 선택 가중치는 focused visible `4`, visible unfocused `2`, hidden `1`이다. hidden은 `display:none`과 0 px track을 이미 관측하는 container visibility ref가 진실원이며 focus보다 먼저 판정한다. priority resolver는 request 때 값을 동결하지 않고 dequeue 때 committed visibility/focus ref를 읽는다. 사용자 설정이나 OS lock/minimize 상태는 입력이 아니다.
4. owner 선택은 smooth weighted round-robin balance를 사용한다. 동일 balance는 pending FIFO 순서로 결정한다. 다른 owner에게 `K=8` turn을 양보한 owner는 age-promoted되고 FIFO의 다른 overdue owner보다만 뒤에 선다. 선택 시점에 pending owner가 `P`개라면 continuously pending pane owner의 최대 대기는 `K + P - 1`개의 다른 completed turn이고, 두 lane이 모두 saturated인 특정 lane은 sibling 교대 때문에 최대 한 turn을 더 기다린다. 새 arrival는 overdue owner를 앞지르지 않는다.
5. priority 변경은 다음 dequeue부터 balance와 weight에 반영한다. 이미 active인 write는 선점·취소하지 않으며 materialized batch, envelope identity, sequence, callback을 바꾸지 않는다. resolver 실패는 background로 fail-safe 분류하되 admission 자체를 멈추지 않는다.
6. active callback이 끝나기 전 다음 local lane/turn을 예약하고, scheduler가 lease를 반환한 뒤 새 macrotask에서 다음 owner를 실행한다. parser callback timeout이나 UI 상태 변화로 lease를 조기 반환하지 않는다. 동기 throw·backpressure·lifecycle cancel의 기존 idempotent release 계약은 유지한다.
7. 다른 pane owner가 pending인 turn은 visible과 checkpoint 모두 최대 64 KiB를 parser에 제출한다. 앱에 이 pane만 있으면 기존 256 KiB live/checkpoint fast path를 유지한다. replay callback barrier, stabilized string/frame 원자성, 1 MiB DECSET 상한, retry batch identity는 변경하지 않는다.
8. background weight 1은 pause나 presentation drop이 아니다. hidden pane의 두 parser와 parsed ACK도 계속 전진하며 부족한 처리량은 ADR-0097에 따라 PTY backpressure로 전달한다. congestion을 reset/replay/replacement attach/fail-stop 사유로 승격하거나 visible parse 전 ACK하지 않는다.
9. parsed frontier는 ADR-0095대로 visible과 checkpoint가 모두 완료한 contiguous prefix의 교집합이다. scheduler는 receipt/hold/close/ACK identity, generation당 하나인 unreceipted envelope, 5초 progress/continuation deadline을 소유하거나 변경하지 않는다. wall-clock bound는 accepted xterm callback이 유한하게 끝난다는 기존 liveness 가정에 의존하며, 2/4/7/8-pane 실측에서 background service gap이 5초보다 짧아야 이 weight를 유지한다.

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
- checkpoint도 전역 단일 lease와 64 KiB contended quantum을 사용하므로 동시에 진행 중인 desktop xterm physical write는 앱 전체에서 최대 하나다.
- owner 수가 늘면 background throughput과 최종 drain 시간은 감소할 수 있다. 이는 의도한 responsiveness 우선순위이며 byte를 버리지 않고 PTY backpressure로 나타난다. single-pane 256 KiB fast path는 유지한다.
- smooth balance, age counter, pane-local two-lane arbiter가 scheduler 상태에 추가된다. 결정적 테스트는 4:2:1 share, latest-state reclassification, `K+P-1` owner bound, lane alternation/dedupe/cancel, one-active lease, callback FIFO를 고정해야 한다.
- 2/4/7/8 hot-pane 150,000-line dev 측정은 key/Automation/screenshot latency, frontend health, parser frontier service gap, throughput, final marker와 fail-stop/repair를 함께 기록한다. 5초 timeout 또는 background parsed-progress expiry가 발생하면 weight·quantum을 재검토하되 single-slot·lossless 계약을 우회하지 않는다.
- #683의 multi-receipt pipeline은 채택하지 않는다. receipt RTT가 실제 병목으로 다시 측정되면 batching/ACK 집계를 먼저 검토하고, slot 확대는 별도 ADR로 다룬다.
