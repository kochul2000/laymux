# 0087. Mutex poison은 기본 fail-closed이며 폐기 전용 close만 guard를 회수한다

- Status: Proposed
- Date: 2026-07-29
- Source: issue #631 · PR #626 failure-path 리뷰 · [architecture/api-contracts.md §14.3](../architecture/api-contracts.md) · [ADR-0084](0084-desktop-terminal-output-parsed-credit.md)
- Extends: [ADR-0084](0084-desktop-terminal-output-parsed-credit.md)의 terminal-output generation retirement 예외를 리포 전역 poison 정책으로 일반화한다.

## Context

Rust `std::sync::Mutex`의 poison은 이전 holder가 보호 상태를 갱신하던 중 panic했다는 신호다. `PoisonError::into_inner()`로 값에 다시 접근할 수는 있지만, 그 값이 불변식을 만족한다는 보장은 없다. 정상 운영 경로가 이를 성공으로 취급하면 terminal output sequence, parsed credit, per-terminal 입력 직렬화, 설정 파일 쓰기 순서처럼 외부에서 관찰되는 계약을 손상시킬 수 있다.

ADR-0084는 terminal-output protocol/runtime/flow가 poison된 뒤 정상 output을 재개하지 않고 explicit retirement만 guard를 회수하도록 좁은 예외를 만들었다. 이 예외는 close가 subscriber와 waiter를 깨우고 PTY handle 종료까지 도달하려면 필요하지만, 당시 helper 이름과 허용 범위는 terminal-output에 한정되어 있었다. 반면 sequenced output ring, MCP exec-lock table, memo 직렬화 gate에는 poison을 무조건 회수하는 코드가 남아 있어 리포 전역 원칙이 일관되지 않았다.

이번 결정의 범위는 동기 `std::sync::Mutex` poison의 분류, 오류 전파, explicit close/rollback에서의 discard-only 회수, 진단 상태의 조건, 락 순서와 tracing 규율이다. Tokio mutex의 취소 정책, panic 자체의 복구, fatal PTY reader 자동 중단(issue #630)은 비목표다.

## Decision

**모든 운영 mutex는 poison을 기본적으로 fail-closed하고, 소유 자원을 되돌릴 수 없이 폐기하는 close/rollback만 이름 있는 discard helper로 guard를 회수하며, 일반 진단 복구를 위한 범용 guard helper는 제공하지 않는다.**

- 정상 읽기·쓰기·조회·권한 판정·sequence/credit 계산·registry 생성은 `MutexExt::lock_or_err()`를 사용한다. poison을 빈 값, not-found, 성공, 새 기본 상태로 바꾸지 않는다. 호출자가 오류를 반환할 수 있으면 `AppError::Lock` 또는 경계의 동등한 오류로 전파한다.
- `lock_or_recover_for_discard(context)`, owner `Drop`의 `get_mut_or_recover_for_discard(context)`, Condvar용 `recover_poison_for_discard(error, context)`은 explicit close, creation rollback, generation retirement처럼 보호 상태의 외부 사용을 종료하는 경로에서만 허용한다. 호출자는 entry 제거, collection clear, 상태 overwrite, waiter wake, 추출한 OS resource의 terminate/drop만 수행한다. recovered field로 새 작업을 승인하거나 정상 registry/lease/sequence를 재개하지 않는다.
- discard recovery는 mutex의 poison을 지우지 않는다. 같은 mutex의 후속 `lock_or_err()`는 계속 실패해야 한다. 일부 entry만 폐기한 map도 정상 운영 상태로 재노출하지 않는다.
- terminal-output fatal waiter는 예외적으로 recovered guard를 Condvar에 다시 전달할 수 있다. 이때 보호된 lease·ACK·credit은 읽지 않고 mutex 밖의 `AtomicBool retired`만 lifecycle SoT로 사용한다. 이는 운영 복구가 아니라 discard 완료 대기다.
- 진단 상태라는 이유만으로 poison guard를 반환하는 범용 helper를 만들지 않는다. 복구 가능한 진단은 해당 타입이 제어·권한·sequence 판단에 전혀 소비되지 않음을 소유 타입 경계로 증명하고, typed snapshot이 poison/degraded 사실을 함께 드러내는 경우에만 별도 ADR 또는 living doc 근거로 추가할 수 있다. 현재 frontend health도 poison을 500 오류로 드러내며 복구하지 않는다.
- authoritative sequenced output ring의 모든 읽기와 쓰기는 `Result`를 반환한다. ring poison은 빈 history나 기존 sequence로 대체하지 않는다. MCP exec-lock table과 memo serialization gate도 poison을 회수하지 않아 입력 직렬화 분리와 설정 쓰기 순서 손상을 막는다.
- activity·sync-CWD·MCP 입력처럼 상태를 근거로 side effect를 승인하는 경로는 strict snapshot의 오류를 `Shell`, 빈 target, not-found, `null`로 축소하지 않는다. bulk activity는 `terminals → output_buffers → ring` 순서를 지키며, CWD source/target admission은 poison 시 차단한다. MCP pre-write sampling 실패는 쓰기 전에 끝나고 post-write capture 실패는 이미 수행된 write와 byte count를 tool error에 보존한다.
- terminal/session close는 lock order를 그대로 지키며 catalog/session registry/protocol/runtime/flow/output projection/PTY registry에서 필요한 discard만 수행한다. PTY registry에서 추출한 handle은 종료에만 사용한다. poison helper는 lock order의 우회 수단이 아니다.
- poison 회수마다 정적인 `context`를 포함한 `tracing::warn!`을 남긴다. 정상 운영의 fail-closed 호출자가 오류를 의도적으로 무시하는 경우에도 제어 결론은 보수적이어야 하며, poison 상태를 성공 데이터로 합성하지 않는다.
- test-only mock mutex와 테스트의 의도적 poison 생성용 직접 `lock()`은 프로덕션 helper 규칙의 대상이 아니다. 프로덕션의 모든 blocking `Mutex::lock()`은 이름 있는 helper를 사용한다.

## Alternatives Considered

- **모든 poison을 `into_inner()`로 복구한다.** 가용성은 높아 보이지만 panic 시점의 중간 sequence, 권한, registry 상태를 정상으로 신뢰하게 된다. 손상 여부를 증명할 수 없어 기각했다.
- **poison이 발생하면 프로세스를 즉시 abort한다.** 손상 상태 노출은 막지만 한 terminal generation이나 memo gate의 결함이 앱 전체와 다른 PTY를 종료한다. 명시적 close로 OS resource를 회수할 기회도 잃어 기각했다.
- **immutable diagnostic guard를 반환하는 범용 helper를 둔다.** `&T`에서도 clone한 값을 제어 경로로 전달할 수 있고 어떤 field가 안전한지 helper가 증명하지 못한다. 타입별 snapshot과 명시적 degraded 표식을 요구하는 쪽을 선택했다.
- **poisoned registry를 빈 map으로 교체하고 운영을 계속한다.** 기존 Arc lock과 새 lock이 공존해 per-terminal 직렬화가 갈라지고, 살아 있는 generation/handle을 잃을 수 있다. discard close 외의 reset은 금지했다.
- **close도 fail-closed하여 아무 상태도 만지지 않는다.** orphan PTY와 영구 대기 waiter를 남기고 explicit close의 resource disposal 계약을 깨므로, 정상 재사용 없는 discard-only 예외를 유지했다.

## Consequences

- poison 발생 시 일부 조회·Automation/MCP 요청은 빈 성공 대신 명시적 오류를 반환한다. 이는 손상된 상태로 계속 동작하는 것보다 가용성이 낮지만 sequence·직렬화·권한 불변식을 보존한다.
- output ring API가 오류 가능성을 드러내므로 내부 호출자가 오류를 전파하거나 보수적 결론을 명시해야 한다. Tauri/HTTP/MCP의 정상 payload 스키마는 바뀌지 않으며 poison failure 응답만 달라진다.
- activity bulk 조회와 sync-CWD target 계산은 poison에서 부분/빈 성공을 반환하지 않는다. MCP capture는 관찰 실패와 입력 미수행을 구분하므로, 실패 응답을 받은 호출자는 `written`/`sideEffect`를 확인한 뒤 재시도 여부를 결정해야 한다.
- explicit close는 poisoned terminal-output state와 PTY registry에서도 waiter를 깨우고 handle을 종료할 수 있다. recovered mutex는 계속 poisoned라 새 운영 작업이 조용히 재개되지 않는다.
- discard helper 호출자는 리뷰 시 좁은 allowlist가 된다. 새 호출자는 irreversible ownership 종료, 상태 비재노출, 기존 락 순서, tracing, poison 유지 테스트를 함께 제시해야 한다.
- protocol/runtime/flow/session registry/output ring/exec-lock registry/memo gate/PTY close의 poison 회귀 테스트가 정책을 고정한다. 새 mutex domain이 poison recovery를 요구하면 범용 helper를 재사용하기 전에 typed invariant와 재노출 여부를 문서화해야 한다.
- issue #630은 fatal reader stop과 자동 teardown만 다룬다. 그 구현도 이 ADR의 fail-closed/discard-only 경계를 지키며 정상 output 상태를 복구해서는 안 된다.
