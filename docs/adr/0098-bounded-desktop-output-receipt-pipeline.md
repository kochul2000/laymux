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
- repair는 동일한 full transport identity의 slot을 조회한다. hold/close는 pipeline에 먼저 동결된 transport grant와 새 control grant가 다를 수 있으므로 `(generation, lease token, envelope id)` boundary와 active control grant 소유권을 분리해 검증한다. receipt 뒤 close도 recent receipt의 전체 `[seqStart, seqEnd]`를 사용한다. deadline worker는 모든 slot 중 가장 이른 receipt deadline에서 generation을 fail-stop한다.
- `heldEnvelopeId`는 opener envelope마다 backend hold를 최대 하나만 허용하는 불변식으로 유지한다. hold/close는 수락된 뒤 receipt를 열며, 이 control 순서는 receipt pipeline과 독립적으로 보존한다.
- frontend는 앞 envelope가 continuation control에 보류된 동안 뒤따라 관측한 contiguous successor를 backend pipeline 상한과 같은 4개까지 source 순서로 보존한다. 이 bounded chain은 단일 drain owner만 순차 소비해 병렬 완료 callback이 뒤 successor를 먼저 판정하지 못하게 한다. ingress가 기다리는 정확한 envelope를 continuation gate가 이미 소유하면 뒤 successor를 gap으로 판정하지 않고 그 owner의 settle을 기다리며, 그 뒤 각 successor를 최신 control gate에 재진입시킨다.
- frontend는 최대 4-slot에서 겹쳐 발행된 이전 closed grant들을 bounded history로 기억한다. pre-hold에 동결된 null-grant envelope 뒤에 hold 반영분이 올 수 있으므로 null 하나만으로 이 history를 지우지 않고 bounded eviction으로만 퇴출한다. 보류 envelope는 재개할 때마다 최신 opening/closing gate에 재진입시켜, 앞 envelope가 새 control 전이를 만들면 뒤 envelope가 그 전이를 우회하지 못하게 한다.
- parsed ACK credit, active continuation grant, envelope byte/delta/wire 상한, fail-stop과 명시적 close/recreate 복구는 ADR-0095 그대로다.
- Automation diagnostics의 기존 `receiptSlot`은 호환성을 위해 가장 오래된 미수령 slot을 계속 나타낸다. 다중 slot 전체의 공개는 별도 외부 계약 변경으로 다룬다.

## Alternatives Considered

- base parsed credit을 늘린다: frame과 무관하게 retained memory 및 attach snapshot을 키우므로 receipt IPC 왕복 병목의 직접 해법이 아니다.
- 무제한 receipt pipeline: 고출력 때 immutable payload와 repair state를 무한히 쌓을 수 있어 거절한다.
- slot 하나를 유지하고 receipt 호출만 최적화한다: IPC 지연이 남는 일반 output을 여전히 직렬화하므로 거절한다.

## Consequences

- 정상 고출력은 최대 네 envelope 동안 receipt 왕복과 emit을 겹칠 수 있다.
- 구현은 slot별 exact repair, out-of-order receipt, duplicate retry, earliest deadline fail-stop을 회귀 테스트로 고정해야 한다.
- 연속 DECSET frame이 서로 다른 transport/control grant를 겹치게 하는 경우와 terminator 뒤 trailing bytes가 있는 receipt 이후 close 범위를 회귀 테스트로 고정해야 한다.
- worst-case 미수령 envelope 메타데이터와 frozen backing은 네 envelope로 제한된다. source bytes의 retention 상한과 parsed-credit 정책은 바뀌지 않는다.
- 이 결정은 hold/close IPC를 receipt보다 앞에서 await하는 control 순서를 바꾸지 않으며, xterm write scheduling 자체도 병렬화하지 않는다.
