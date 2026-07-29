# 0092. 데스크톱 xterm physical write는 앱 전역 round-robin으로 진입한다

- Status: Proposed
- Date: 2026-07-29
- Source: 사용자 보고(issue #661: 여러 pane 동시 대량 출력에서 UI·입력 심각한 지연) · 2026-07-29 dev baseline(1 pane 82.7 ms, 2 pane 193.1 ms, 4 pane 556.5 ms, 8 pane에서 echo·Automation timeout 및 WebView event send failure) · [architecture/data-flow.md §8.8](../architecture/data-flow.md) · [ADR-0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md) · [ADR-0084](0084-desktop-terminal-output-parsed-credit.md)
- Extends: [ADR-0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md)의 pane-local macrotask 양보를 앱 전역 admission 순서와 경쟁 시 64 KiB fairness quantum으로 확장한다. batch allowlist와 [ADR-0084](0084-desktop-terminal-output-parsed-credit.md)의 parsed ACK 교집합은 변경하지 않는다.

## Context

ADR-0080은 각 `TerminalView`가 single-flight FIFO를 두고 physical write 하나가 끝날 때마다 새 macrotask로 양보하게 했다. 한 pane만 출력할 때는 이 규칙이 input·paint가 끼어들 기회를 주지만, scheduler와 in-flight 표식이 pane마다 독립이다. 여러 pane이 동시에 backlog를 가지면 각 pane이 xterm write 하나씩을 동시에 제출할 수 있고, 서로 독립인 xterm parser task들이 같은 WebView 메인 스레드에서 연속 실행된다. 어느 pane도 자기 FIFO 규칙을 어기지 않지만 앱 전체의 parser 경쟁에는 상한이나 순서가 없다.

issue #661의 동일한 bounded flood baseline에서 관측한 상호작용 지연은 1 pane 82.7 ms, 2 pane 193.1 ms, 4 pane 556.5 ms로 pane 수보다 빠르게 증가했다. 8 pane에서는 첫 세 probe가 60.1 ms, 3493.8 ms, 2588.3 ms였고 뒤의 probe와 grid query가 약 5초 timeout으로 실패했다. 이때 frontend health report가 최대 76.1초 묵고 Tauri의 terminal-output event가 WebView로 전송되지 않았지만 backend API와 dev 프로세스는 계속 살아 있었다. 이는 pane-local 양보와 pane당 256 KiB physical batch가 결합하면 단일 전역 lease만으로도 WebView가 control/input을 처리할 유한한 비용 경계를 만들지 못한다는 증거다. 동시에 sequence·ring·visible/checkpoint parse 교집합은 손실 없이 유지해야 하므로 output drop이나 ACK 선행으로 비용을 숨길 수 없다.

범위는 데스크톱에 마운트된 `TerminalView`들의 visible xterm physical write admission과 ordinary live byte의 enqueue/dequeue quantum이다. PTY producer/ring, Tauri event, rendererless checkpoint, logical segment 처리, 병합 allowlist, 커서/OSC/IME 상태기는 바꾸지 않는다. 활성 pane 특별 우선순위, visible/hidden 가중치, Remote xterm scheduling은 비목표다.

## Decision

**데스크톱의 모든 마운트된 `TerminalView`는 앱 전역 scheduler에서 physical xterm write lease를 하나씩 round-robin으로 얻고, 수락된 write의 parse callback 또는 명시적 lifecycle 취소 뒤에만 다음 pane으로 넘긴다.**

- 앱 전역 scheduler가 physical write admission turn의 단일 진실원이다. 각 `TerminalView`의 `TerminalWriteBatchQueue`는 계속 자기 byte FIFO·batch materialization·callback을 소유하며 scheduler는 byte나 metadata를 읽거나 재배열하지 않는다.
- scheduler owner는 `TerminalView`의 xterm 생성 effect마다 새로 만드는 opaque identity token이다. 프로파일 변경 뒤에도 재사용되는 `instanceId`를 owner key로 쓰지 않는다. old effect의 늦은 parse callback·pending 취소·unmount release는 그 token에만 작용하며 replacement effect가 같은 `instanceId`로 등록한 turn을 제거하거나 반환할 수 없다.
- 전역 active lease는 최대 하나다. pane은 lease 한 번에 자기 FIFO의 physical batch 하나만 제출한다. 같은 pane이 backlog를 더 가져도 미래 turn은 하나만 등록하고 대기열 꼬리로 돌아간다. 이미 기다리는 다른 pane이 있으면 그 pane들이 먼저 한 turn씩 얻는다.
- ordinary non-stabilized live `Uint8Array`는 pane-local FIFO에 최대 64 KiB 조각으로 enqueue한다. scheduler가 turn을 부여할 때 다른 owner가 이미 pending이면 그 turn의 fresh dequeue는 compatible 조각을 최대 64 KiB까지만 합친다. 다른 owner가 없으면 기존 128 part·256 KiB 상한까지 합쳐 단독 pane 처리량을 유지한다.
- string, stabilized frame, replay와 기존 metadata/callback barrier는 64 KiB quantum 때문에 합치거나 다시 자르지 않는다. 단독 상태에서 이미 materialize된 64~256 KiB batch가 backpressure로 복원된 뒤 경쟁이 시작돼도 같은 batch 객체·buffer·callback 집합을 재시도한다. retry를 64 KiB로 다시 쪼개 no-rematerialization 불변식을 깨지 않는다.
- 앱 전체에 active·pending turn이 없는 idle 최초 request는 즉시 admission한다. 수락된 write가 끝나거나 거부·취소된 뒤 다음 turn은 반드시 새 macrotask에서 시작해 input·paint·Automation control이 pane 사이에 실행될 기회를 둔다.
- xterm이 write를 수락하면 lease는 parse callback까지 유지한다. 동기 backpressure와 non-backpressure 거부는 local FIFO의 기존 restore/discard 처리를 끝낸 뒤 lease를 반환한다. backpressure 재시도는 기존 16 ms를 기다린 뒤 새 future turn으로 대기열에 진입한다.
- attach epoch 무효화는 아직 실행되지 않은 그 pane의 future turn만 취소한다. 이미 수락된 physical write는 callback까지 lease를 유지하고 기존 replacement attach가 그 callback을 기다린다. `TerminalView` unmount는 pending turn과 active scheduler lease를 모두 취소한다. 그 뒤 도착한 callback의 release는 idempotent no-op이고 local byte outcome만 기존 규칙대로 마친다.
- 공정성은 “수락된 xterm write가 callback을 호출하거나 owner lifecycle이 취소된다”는 기존 single-flight liveness 전제 아래 starvation-free다. timeout으로 active lease를 먼저 반환해 두 parser를 겹치게 하지 않는다. callback 미정착이 실기에서 확인되면 별도 fail-stop/watchdog 결정을 한다.
- scheduler는 active/visible/hidden pane에 우선순위를 두지 않는다. 대화형 pane 가중치는 starvation·우선순위 역전 정책이 필요한 별도 결정이며 이번 변경에 포함하지 않는다.

## Alternatives Considered

- **pane-local `setTimeout(0)`만 유지한다**: 각 pane 내부 재귀 drain은 막지만 여러 xterm 인스턴스가 동시에 하나씩 in-flight가 되는 앱 전역 경쟁을 제한하지 못해 기각했다.
- **256 KiB batch 상한만 줄인다**: 한 physical write의 비용은 낮추지만 pane 수만큼 parser가 동시에 outstanding인 구조와 pane 간 순서는 그대로다. throughput을 일률적으로 낮추면서 공정성을 만들지 못해 단독 해법으로 기각했다.
- **활성/포커스 pane을 항상 우선한다**: 입력 echo latency에는 유리할 수 있지만 background pane이 지속적으로 굶을 수 있고 visible/hidden·focus 전환의 정책 소유권까지 새로 필요하다. 이번 증거가 요구하는 최소 starvation-free 정책보다 범위가 커서 제외했다.
- **한 pane의 queue를 모두 비운 뒤 다음 pane으로 간다**: 전역 동시 parser 수는 줄지만 한 flood pane이 나머지 pane을 무한히 굶길 수 있어 기각했다.
- **느린 pane의 output을 drop하거나 visible parser 전에 ACK한다**: ADR-0072의 sequence-exact 화면과 ADR-0084의 parsed-credit 불변식을 깨므로 기각했다.

## Consequences

- 동시에 폭주하는 pane 수와 무관하게 visible xterm physical parse는 앱 전체에서 하나만 outstanding이다. 각 pane은 최대 한 batch 뒤 대기열 꼬리로 이동하므로 다른 pane과 input·paint가 끼어들 경계가 생긴다.
- byte 순서·batch allowlist·128 part/256 KiB hard 상한·stabilizer/string/replay/IME barrier·visible/checkpoint ACK 교집합은 그대로다. ordinary live enqueue 조각은 64 KiB이며 경쟁 turn의 fresh coalescing 상한도 64 KiB, 단독 owner의 coalescing 상한은 256 KiB다. 공정성 scheduler는 성능 때문에 정확성 경계를 합치거나 건너뛰지 않는다.
- 여러 pane의 총 renderer throughput은 기존 동시 outstanding 방식보다 낮아질 수 있고 ADR-0084 producer backpressure가 더 일찍 shell까지 전달될 수 있다. 이는 무제한 메인 스레드 경쟁 대신 bounded 응답성을 선택한 비용이다.
- 64 KiB는 bytes를 폐기하는 budget이 아니라 pane 사이의 admission quantum이다. 한 pane만 남으면 같은 네 조각을 최대 256 KiB로 다시 materialize하므로 단독 flood의 기존 physical-write 처리량을 의도적으로 보존한다. 경쟁 시작 전 만들어진 retry가 64 KiB보다 클 수 있다는 예외는 byte/callback identity 보존 비용이다.
- accepted callback이 영구히 오지 않고 pane도 unmount되지 않으면 모든 pane의 physical output이 멈춘다. 기존에는 해당 pane만 멈췄던 failure의 영향 범위가 넓어지는 비용이며, 실기에서 확인되면 callback watchdog 또는 격리 정책을 새 ADR로 재검토한다.
- 순수 scheduler/queue 테스트는 one-active, round-robin, contention 신호, pending dedupe, 64/256 KiB dequeue 상한, restored retry identity, pending-only epoch 취소, unmount release, stale callback idempotence와 동일 `instanceId` replacement 세대 격리를 고정한다. `TerminalView` 통합 테스트는 A pane이 backlog를 가진 동안 B pane이 A의 다음 batch보다 먼저 한 turn을 얻고, 경쟁 중 ordinary live turn이 64 KiB를 넘지 않으며 최종 byte stream이 보존됨을 고정한다.
- dev 재검증은 동일한 bounded 1/2/4/8 pane flood에서 input/control latency, `xtermParseMaxMs`, queue/credit 상한, callback/discard/gap/repair/attach 카운터와 최종 고유 marker를 함께 비교한다. 성능 개선만으로 완료하지 않고 byte 무손실과 화면 tail을 같이 확인한다.
