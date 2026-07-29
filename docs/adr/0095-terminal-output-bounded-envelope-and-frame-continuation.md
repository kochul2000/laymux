# ADR-0095: 출력 envelope 경계와 정상 프레임 continuation

- **Status:** Accepted
- **Date:** 2026-07-29
- **Source:** Issues #661, #670; `docs/architecture/data-flow.md` §8.8; `docs/architecture/api-contracts.md` §13.4; ADR-0072, ADR-0080, ADR-0084, ADR-0086, ADR-0088, ADR-0092; `docs/terminal/fix-flicker.md`, `docs/terminal/xterm-shadow-cursor-architecture.md`, `docs/terminal/xterm-cursor-repaint-analysis.md`
- **Extends:** ADR-0080과 ADR-0084의 desktop output 전달/credit 계약을 bounded v3 envelope와 정상 DECSET 2026 continuation으로 확장한다.
- **Amends:** ADR-0086의 active continuation 중 destructive replacement 허용 범위를 fail-stop으로 좁힌다. 기존 command timeout/orphan 상한 원칙은 유지한다.
- **Aligns:** ADR-0092의 app-wide one-active lease, 64 KiB contention quantum, `TerminalWriteBatchQueue` 소유권과 정렬한다. 해당 scheduler와 queue 계약은 수정하지 않는다.
- **Lineage:** 미게시 로컬 `fix/661-output-ingress-bound` HEAD `7c47ac4`의 Proposed ADR-0093이 기록한 bounded envelope 결정을 흡수·대체한다. PR #668의 ADR-0093은 `main`의 `d8e43df`로 병합되었고, donor ADR은 게시·병합·cherry-pick하지 않으며 이 ADR-0095만 해당 data-plane 결정의 단일 정본이다.
- **Related:** ADR-0072의 sequence-exact repair, ADR-0088의 authoritative fatal generation teardown, ADR-0094의 ACK control admission

## Context

#661의 동시 hot-pane 재현에서는 pane당 약 351 KiB의 출력이 약 32,800개 event로 팽창했다. byte credit만 제한해도 event 개수, JSON 객체와 callback이 제한되지 않으면 WebView ingress가 과부하되어 다른 pane 내용의 순간 노출, 빈 화면, 입력 지연으로 이어질 수 있다.

#670에서는 기본 parsed credit 512 KiB보다 크고 정상 DECSET 2026 frame 상한 1 MiB 이하인 frame이 완결되기 전에 parser ACK가 멈춘다. producer는 ACK를 기다리고 parser는 닫는 시퀀스를 기다리므로 정상 frame이 교착한다.

두 결함은 같은 `source bytes → retained ring → delivery envelope → physical write queue → semantic parse ACK` 경계의 서로 반대편이다. v3 envelope만 먼저 도입하고 512 KiB credit을 고정하면 512 KiB 초과 정상 frame은 계속 교착한다. continuation만 v2 event 위에 먼저 도입하면 ACK되지 않은 event/object 수를 더 늘려 #661을 악화한다. 따라서 wire 경계, receipt, parsed ACK, ring 보존과 continuation을 한 결정과 한 구현 PR에서 원자적으로 검증해야 한다.

이 ADR은 Remote snapshot 계약이나 xterm parser의 DECSET 2026 의미를 바꾸지 않는다. desktop 전달의 bounded ownership과 정상 frame을 끝까지 전달할 제한된 credit만 결정한다.

## Decision

desktop output은 generation별 bounded v3 envelope로 전달하고 receipt와 parsed ACK를 분리한다. 기본 parsed credit은 512 KiB로 유지하되, healthy active surface가 이미 열린 정상 DECSET 2026 frame에 대해서만 frame 시작부터 최대 1 MiB까지 하나의 bounded continuation grant를 받을 수 있다.

### 상태 소유권과 frontend 경계

- Rust `TerminalOutputSession`이 terminal generation, 정확한 source sequence, retained ring, parsed frontier, continuation grant와 server expiry의 단일 진실원이다.
- generation-local delivery worker가 pending delta, envelope ID, 전송/receipt slot과 Rust compact sequence/byte ledger를 소유한다. 동시에 receipt되지 않은 v3 envelope는 generation당 하나뿐이다.
- frontend desktop envelope ingress가 receipt 전 decoded backing buffer, delta 경계, envelope identity와 receipt 상태를 소유한다. logical write descriptor가 queue에 수락될 때까지 post-semantic compact cursor도 ingress가 소유한다.
- `TerminalWriteBatchQueue`는 계속 physical byte FIFO, materialization, enqueue/backpressure, write 완료 callback과 discard의 유일한 소유자다. queue가 descriptor를 수락하는 순간 backing slice와 callback의 물리 수명 소유권이 ingress에서 queue로 이전된다. ingress는 그 뒤 sequence/frontier ledger만 보유하고 physical bytes를 다시 materialize하거나 재정렬하지 않는다.
- parsed frontier는 visible xterm write callback과 별도 rendererless checkpoint xterm write chain이 모두 같은 prefix를 완료한 경우에만 전진한다. native stabilizer는 bytes를 보류해 두 완료를 늦추는 gate이며 checkpoint나 frontier를 소유하지 않는다. receipt는 이 semantic 완료를 대신하지 않는다.
- 이 경계는 ADR-0092를 **Amend하지 않는다**. app-wide lease, 64 KiB contention quantum과 queue scheduler는 그대로이고, 이 ADR은 그 queue 앞의 envelope ingress와 backend credit 계약을 확장·정렬한다.

### v3 bounded envelope와 receipt

- v3 envelope는 최대 64 KiB physical bytes, 최대 8,192개 logical delta, 직렬화된 payload 1 MiB 미만을 모두 만족한다. 하나라도 먼저 도달하면 envelope를 닫는다.
- receipt는 frontend가 envelope backing과 모든 logical descriptor를 bounded ownership 안으로 인수했다는 뜻이다. ESC/CSI/OSC가 envelope 경계에서 갈라져도 receipt할 수 있으며 parsed ACK와 동일하지 않다.
- frontend는 연속된 source sequence만 수락한다. gap 또는 overlap은 정확 repair를 요청하고 screen reset/replay로 복구하지 않는다.
- post-semantic compact ledger는 source byte range와 materialized slice의 대응을 보존해야 한다. marker, ring, cell grid와 screenshot은 동일 source prefix를 가리켜야 한다.

### surface 상태의 단일 진실원

- mount-local frontend surface lifecycle owner가 현재 attach epoch, generation, lease token, visible xterm과 별도 rendererless checkpoint xterm의 생존/준비 상태를 함께 보고 `healthy` 또는 `unavailable`을 계산하는 단일 진실원이다. backend registry, native stabilizer, queue 길이와 metrics는 이 판정을 독자적으로 만들 수 없다.
- `healthy`는 같은 generation/token에 속한 visible parser와 rendererless checkpoint parser가 모두 살아 있고 ready이며 mount가 dispose 중이 아닌 상태다. native stabilizer가 정상 frame bytes를 보류하거나 단순히 느리거나 capacity를 기다리는 상태는 `unavailable`이 아니다.
- `unavailable`은 unmount/dispose, visible 또는 rendererless parser의 terminal failure, stale generation/token, 또는 명시적인 delivery-control fail-stop이다.
- active continuation 중 healthy surface는 grant close 또는 parsed ACK 전까지 destructive re-attach와 token 교체를 지연한다. unavailable이 되면 reset/replay나 자동 replacement attach를 하지 않고 해당 generation을 fail-stop한다.

### 기본 credit, continuation과 bootstrap

- 기본 parsed credit `B`는 512 KiB다. source는 `parsedAck + B`까지 진행할 수 있고, 이미 시작한 한 번의 PTY read 때문에 최대 `R = MAX_PTY_READ_CHUNK_BYTES`만큼만 물리적으로 초과할 수 있다.
- bootstrap lease에는 visible xterm과 rendererless checkpoint xterm을 함께 가진 healthy surface가 없으므로 continuation grant를 요청하거나 받을 수 없다. bootstrap의 논리 credit은 base 512 KiB뿐이고, 완료된 한 read의 `R` 초과만 허용한다.
- 첫 desktop attach는 generation/token과 완전한 unparsed desktop snapshot을 원자적으로 인수한다. surface가 healthy 판정을 받은 뒤 열린 frame을 관측한 경우에만 continuation을 요청할 수 있다.
- active 또는 re-attach surface가 정상 DECSET 2026 open을 확인하면 frontend는 hold-open command를 호출하기 전에 충돌하지 않는 immutable opaque `grant id` nonce를 생성한다. backend는 그 ID를 해당 frame의 grant ID로 채택하고, 같은 identity/payload 재시도에는 최초 결과를 idempotent하게 반환하며 같은 ID의 다른 payload는 거절한다.
- backend는 해당 frame 시작 sequence부터 terminator까지 최대 `F = 1 MiB`인 단일 monotonic grant를 발급할 수 있다. grant는 뒤따르는 여러 envelope가 같은 frame을 운반하는 동안 참조할 수 있지만 다른 frame이나 generation/token으로 이전되지 않는다.
- terminator, malformed sequence, frame timeout 또는 `F + 1 byte` oversized가 확인되면 fail-open으로 raw bytes를 계속 표시하고 grant를 닫는다. screen reset/replay는 하지 않는다.

### retention, desktop attach snapshot과 eviction

다음 값은 동일 named constant에서 파생한다.

```text
B = 512 KiB
F = 1 MiB
R = MAX_PTY_READ_CHUNK_BYTES
MAX_DESKTOP_RETAINED_BYTES = B + F + 2 * R
DESKTOP_OUTPUT_RING_CAPACITY_BYTES = MAX_DESKTOP_RETAINED_BYTES
DESKTOP_ATTACH_SNAPSHOT_MAX_BYTES = MAX_DESKTOP_RETAINED_BYTES
```

- active/re-attach desktop snapshot은 원자적으로 `[parsedAck, writeSeq)` 전체와 generation/token을 캡처한다. 최신 tail로 clamp하거나 frame 중간을 잘라서는 안 된다.
- retained length가 capacity와 정확히 같을 때 unparsed/ACK 전 oldest byte를 eviction하지 않는다. 다음 append/read admission은 parsed ACK, generation retire, server-side grant expiry 또는 parsed-progress lease expiry 중 하나가 상태를 전진시킬 때까지만 기다린다.
- eviction은 append 전에도 `sequence < parsedAck`인 byte에만 허용한다. ACK 전에 `ringStart`가 전진하는 경로는 금지하며, append가 이를 요구하면 mutation 전에 중단한다.
- snapshot 상한 안에서 완전한 `[parsedAck, writeSeq)`를 만들 수 없으면 attach ready를 반환하지 않고 typed fail-stop으로 전환한다. 잘린 snapshot으로 계속하지 않는다.
- Remote snapshot의 기존 최대 1 MiB와 tail-oriented 계약은 별개다. 이 desktop retention/snapshot 상한을 Remote API에 적용하거나 Remote 계약을 변경하지 않는다.

### v3 control identity와 liveness

- receipt, hold-open과 hold-close의 identity는 모두 `(operation kind, terminal id, generation, lease token, envelope id, grant id)`다. continuation이 없는 receipt는 `grant id = none`이라는 명시적 sentinel을 사용한다. hold-close는 close sequence와 reason도 immutable payload로 포함한다.
- 같은 identity와 같은 payload의 retry는 idempotent하다. 같은 identity의 다른 payload는 typed contract fault로 fail-stop한다.
- stale generation/token/envelope/grant completion은 현재 receipt slot, grant, parsed frontier 또는 waiter를 변경하지 않고 stale 결과로 종료한다.
- WebView/window 단위 `TerminalOutputControlOperationRegistry`가 receipt/hold/close Promise의 watchdog, timed-out orphan과 terminal별/전역 cap을 소유한다. terminal별 및 WebView 전체 orphan hard cap은 각각 6이며, capacity FIFO에서 호출 전 기다리는 시간에는 command watchdog을 적용하지 않는다.
- 실제 command 호출의 watchdog은 5초다. timeout 뒤에는 동일 identity/payload로만 retry하고, 늦은 completion은 registry가 흡수·회계한다. orphan cap에 도달하면 새 command나 replacement attach를 만들지 않고 해당 generation을 fail-stop한다.
- backend `TerminalOutputSession`은 receipt deadline, continuation grant expiry와 generation/token-scoped parsed-progress lease expiry를 소유한다. active surface의 receipt와 grant expiry는 각각 5초이며 유효한 동일 identity의 receipt/close/parsed ACK만 slot 또는 grant를 완료한다.
- producer가 base 또는 retention hard ceiling에서 실제로 차단되면 backend는 현재 `(generation, lease token, parsedAck)`에 5초 parsed-progress deadline을 건다. 같은 token의 parsed ACK가 전진하면 credit을 재평가해 차단이 풀린 경우 deadline을 취소하고, 여전히 hard ceiling이면 새 frontier로 다시 건다. token retire도 취소한다. receipt나 동일 frontier 재전송은 이를 연장하지 않는다. bootstrap도 base ceiling에서 이 규칙을 적용한다.
- envelope receipt가 오지 않으면 receipt deadline이, close가 유실되거나 Promise가 영구 pending이면 server-side grant expiry가, continuation이 없거나 이미 닫힌 뒤 parsed ACK가 멈추면 parsed-progress lease expiry가 원자적으로 해당 generation을 typed fail-stop한다. 세 expiry 모두 grant/receipt wait를 종료하고 delivery worker, credit waiter와 PTY read waiter를 모두 깨우며 waiter는 성공으로 가장하지 않고 stop/error를 받는다.
- hard ceiling에서 producer가 영구 정지할 수 없다. 모든 대기는 parsed ACK, 유효 close, token retire, receipt deadline, grant expiry 또는 parsed-progress lease expiry 중 하나로 유한하게 해제되며, 어떤 경우에도 screen reset/replay로 liveness를 회복하지 않는다.

### 실패 관측과 사용자 복구

- backend는 generation별 `desktopOutputState = healthy | backpressured | failStopped`, reason code, generation/token과 sequence bounds를 진단 정본으로 보존한다. reason은 최소한 `receipt_timeout`, `control_orphan_cap`, `continuation_expired`, `parsed_progress_expired`, `surface_unavailable`, `desktop_snapshot_incomplete`, `identity_conflict`를 구분한다. terminal payload는 diagnostics에 기록하지 않는다.
- Automation diagnostics API와 pane UI는 fail-stop 상태와 reason을 관측 가능하게 해야 한다. output readiness는 false가 되고 명시적인 “output stopped” 상태를 표시하며 자동 reset/replay/re-attach는 하지 않는다.
- 사용자 복구 계약은 해당 terminal을 명시적으로 close하고 recreate하는 것이다. close는 generation을 retire하고 모든 waiter를 깨우며, recreate는 새 generation과 base-only bootstrap으로 시작한다.
- emit 실패는 exact repair를 사용한다. authoritative retained bytes 또는 sequence ledger 자체가 손상된 경우만 ADR-0088의 generation 복구 경계로 넘어가며 정상 capacity/timeout을 데이터 손상으로 승격하지 않는다.

## Alternatives Considered

### #661 envelope를 먼저 배포하고 512 KiB credit 유지

event 수는 줄지만 512 KiB 초과 정상 DECSET 2026 frame은 계속 교착하고 timeout fail-open에 의존한다. wire/ledger를 두 번 바꾸며 전체 acceptance를 통과할 수 없어 기각한다.

### #670 continuation을 v2 event 위에 먼저 배포

큰 frame을 끝낼 수 있지만 ACK 전 event/object 수와 callback backlog를 늘려 #661의 원인을 악화한다. bounded ownership 없이 credit만 넓히므로 기각한다.

### 기본 credit을 항상 1 MiB 이상으로 확대

구현은 단순하지만 모든 pane의 정상 메모리 상한과 attach snapshot 비용을 늘리고 frame 여부와 관계없이 backpressure를 약화한다. base 512 KiB와 조건부 grant를 선택한다.

### receipt를 parsed ACK로 취급

왕복은 줄지만 WebView가 bytes를 소유했다는 사실과 xterm/stabilizer가 적용했다는 사실을 섞는다. 조기 eviction과 잘린 repair를 만들 수 있어 기각한다.

### desktop attach도 최신 1 MiB tail만 제공

Remote와 상한을 공유할 수 있지만 active unparsed prefix 또는 DECSET frame 앞부분을 절단해 lossless desktop 계약을 깨뜨린다. 별도 desktop cap을 선택한다.

### timeout/cap에서 자동 reset/replay 또는 replacement attach

일시적으로 진행할 수 있지만 이미 적용된 bytes를 중복 표시하고 generation/token 경계를 숨긴다. 관측 가능한 fail-stop과 사용자 close/recreate를 선택한다.

## Consequences

- event/object 수, backing memory와 callback 소유권이 bounded되고, 512 KiB 초과 1 MiB 이하 정상 DECSET 2026 frame도 semantic close까지 진행할 수 있다.
- 최악의 desktop generation retained memory와 attach snapshot은 `512 KiB + 1 MiB + 2 * max-read-chunk`까지 증가한다. desktop snapshot IPC도 이에 맞춰 커진다.
- receipt/parsed 이중 frontier, identity registry, expiry와 fail-stop 상태가 추가되어 구현 및 장애 주입 테스트가 복잡해진다.
- bootstrap은 base credit에서 첫 attach를 기다리지만 hard ceiling의 parsed-progress lease expiry 뒤에는 bounded fail-stop하고 waiter를 깨운다. surface가 영원히 붙지 않아도 reader가 영구 pending으로 남지 않는다.
- implementation/living doc 단계에서는 다음 acceptance를 candidate SHA와 병합 후 최신 `main` 양쪽에서 각각 수행한다.
  - 2/4/7/8 pane, hot pane당 150,000줄을 2회 연속 실행한다.
  - Automation API는 20/20 성공, p95 250 ms 이하, 최대 1 s 이하, 504 없음이며 report age 2초 이하를 유지한다.
  - early/mid/final screenshot은 각 3초 안에 완료되고 blank/reset/foreign-pane frame이 없어야 한다.
  - 빠른 physical ASCII 입력 20자는 loss/duplicate/order 오류 0, p95 150 ms 이하, 최대 500 ms 이하다.
  - 정상 경로의 emit/repair/attach 실패는 0이고 fault injection 결과만 정확한 typed failure로 집계한다.
  - marker, retained ring, xterm cell grid와 screenshot이 같은 source prefix와 내용을 보여야 한다.
  - 정확히 `512 KiB + 1 byte`, 768 KiB, 정확히 1 MiB DECSET 2026 frame을 split 및 1-byte chunk로 전달해 중단 없이 닫는다. 정상 3종은 timeout/malformed/oversized fail-open 0이고 같은 grant identity의 정상 close가 확인되어야 한다. malformed, timeout, 1 MiB+1은 loss 없이 각각의 사유로만 fail-open한다.
  - exact retention equality에서 ACK 전 eviction 0, 다음 append 차단, ACK 뒤 parsed prefix만 eviction되는지 검증한다. bootstrap base 상한과 active/re-attach 최대 unparsed snapshot도 검증한다.
  - receipt/hold/close의 retry, stale completion, lost close, 영구 pending, grant expiry, 일반 parsed-progress lease expiry와 waiter wake를 주입해 bootstrap/base/continuation hard ceiling의 영구 정지와 reset/replay가 없음을 검증한다.
- 중간 PR은 `Refs #661 #659 #669 #670`만 사용한다. 위 전체 acceptance가 병합 후 `main`에서 통과하기 전에는 어느 관련 이슈도 닫지 않는다.
- 재검토 조건은 WebView transport가 ordered bounded stream과 취소 가능한 ACK를 네이티브로 제공하거나, xterm이 DECSET 2026 frame을 semantic ACK 없이 안전하게 분할하는 보장된 API를 제공하는 경우다.
