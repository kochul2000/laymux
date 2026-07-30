# ADR-0098: bounded desktop output receipt pipeline

- Status: Proposed
- Date: 2026-07-30
- Source: 고출력 상황의 desktop output 지연 관측; `docs/architecture/data-flow.md` §8.8; `docs/architecture/api-contracts.md` §13.4; ADR-0084, ADR-0086, ADR-0094, ADR-0095
- Extends: ADR-0095의 generation당 단일 미수령 envelope 규칙을 bounded receipt pipeline으로 확장한다.

## Context

v3 envelope가 bounded여도 delivery worker가 receipt 하나를 기다린 뒤에만 다음 envelope를 emit하면, 평범한 고출력도 WebView IPC 왕복 시간에 직렬화된다. parsed credit은 이미 별도 frontier이므로 receipt 대기는 parser·renderer의 실제 처리량을 나타내지 않는다.

무제한 pipeline은 repair 대상, timeout, retained backing ownership을 다시 callback backlog로 키운다. continuation과 parsed ACK의 계약은 이번 결정 범위에서 바꾸지 않는다.

## Decision

desktop generation은 최대 **4개**의 immutable v3 envelope를 receipt 대기 상태로 동시에 보유한다. 각 slot은 원래 envelope identity, receipt deadline, repair 횟수를 독립적으로 소유한다.

- delivery worker는 lease가 있고 pending bytes가 있을 때 미수령 slot 수가 4보다 작으면 다음 envelope를 emit한다.
- receipt는 대상 identity의 slot 하나만 제거하며, 순서 밖 receipt도 허용한다. 최근 수락 receipt는 bounded history에 남겨 같은 identity/payload retry를 idempotent하게 처리한다.
- repair, hold, close는 단일 현재 slot이 아니라 동일 identity의 slot을 조회한다. deadline worker는 모든 slot 중 가장 이른 receipt deadline에서 generation을 fail-stop한다.
- frontend는 hold/close IPC를 시작한 뒤 그 Promise를 receipt 전에 await하지 않는다. receipt가 먼저 Rust에 도착해도 bounded receipt history가 opener/closing envelope의 immutable sequence boundary를 보존하므로, 뒤늦은 hold/close는 그 기록을 기준으로 같은 결과를 낸다.
- hold 또는 close가 아직 settle되지 않았을 때 이미 emit된 successor는 frontend가 xterm/ingress에 넣지 않고 순서대로 보류한다. hold 전에는 null-grant envelope만, close 중에는 기존 grant 또는 null-grant envelope만 보류하며, backend의 4-slot 상한이 이 보류 집합의 상한이다. control이 accept되면 보류분을 source 순서대로 다시 admission한다.
- `heldEnvelopeId`는 opener envelope마다 backend hold를 최대 하나만 허용하는 불변식으로 유지한다. receipt/control의 병렬화는 이 불변식을 약화하지 않으며, control sender는 hold가 close보다 먼저 Rust에 도착하도록 순서를 보존한다.
- parsed ACK credit, active continuation grant, envelope byte/delta/wire 상한, fail-stop과 명시적 close/recreate 복구는 ADR-0095 그대로다.
- Automation diagnostics의 기존 `receiptSlot`은 호환성을 위해 가장 오래된 미수령 slot을 계속 나타낸다. 다중 slot 전체의 공개는 별도 외부 계약 변경으로 다룬다.

## Alternatives Considered

- base parsed credit을 늘린다: frame과 무관하게 retained memory 및 attach snapshot을 키우므로 receipt IPC 왕복 병목의 직접 해법이 아니다.
- 무제한 receipt pipeline: 고출력 때 immutable payload와 repair state를 무한히 쌓을 수 있어 거절한다.
- slot 하나를 유지하고 receipt 호출만 최적화한다: IPC 지연이 남는 일반 output을 여전히 직렬화하므로 거절한다.

## Consequences

- 정상 고출력은 최대 네 envelope 동안 receipt 왕복과 emit을 겹칠 수 있다.
- 구현은 slot별 exact repair, out-of-order receipt, duplicate retry, earliest deadline fail-stop을 회귀 테스트로 고정해야 한다.
- worst-case 미수령 envelope 메타데이터와 frozen backing은 네 envelope로 제한된다. source bytes의 retention 상한과 parsed-credit 정책은 바뀌지 않는다.
- hold/close와 receipt의 병렬화는 local transport slot을 IPC 왕복에서 분리하지만, control이 settle될 때까지 successor admission을 보류한다. 따라서 이 변경은 xterm write scheduling 자체를 병렬화하지 않는다.
