# 0365. 숨김 터미널 회수 중에도 명시적 탐색을 허용한다

- Status: Proposed
- Date: 2026-10-31
- Source: 사용자 보고(Remote에서 사용 중인 pane으로 복귀할 때 `Focus failed: hidden terminal eviction is in progress` 반복), [api-contracts §13.3](../architecture/api-contracts.md#133-navigation-metadata), [ADR-0231](0231-hidden-eviction-target-scoped-input-admission.md)
- 관계: ADR-0231의 generic frontend action 차단 범위에서 명시적 탐색과 탐색에 수반되는 읽음 처리를 분리한다.

## Context

숨김 자동 종료가 저장 증거를 확정하지 못하면 재시도하며 그동안 일반 상태 변경을 거부한다. Remote의 terminal focus도 일반 변경으로 등록되어 회수 대상과 무관한 정상 pane 전환까지 실패한다. 새 숨김 항목을 만들지 않아도 기존 항목의 회수 재시도가 작업을 반복적으로 방해한다.

탐색은 입력·대화 복원 증거를 쓰는 작업과 구분할 수 있다. 다만 비동기 frontend 요청은 HTTP 응답 기한 뒤에도 실행될 수 있으므로 업데이트의 drain 추적에서는 빠지면 안 된다. 생성·종료·설정·PTY 쓰기의 기존 보호와 controller lease는 유지해야 한다.

## Decision

**명시적 탐색과 그에 수반되는 읽음 처리는 숨김 회수와 독립적으로 승인하고, 앱 전체 finalization에서는 기존처럼 거부하고 완료를 기다린다.**

Rust frontend bridge는 정확한 target/method 허용 목록으로 terminal focus, workspace 전환, grid focus, spatial/direction/notification 이동, workspace/terminal 읽음 처리를 분류한다. 알 수 없는 action과 구조 변경은 기존 generic admission을 사용한다. REST·MCP·Remote는 같은 분류를 사용하고 Remote lease 검증은 계속 적용한다.

checkpoint runtime은 요청 ID별 종류와 종류별 진행 수를 소유한다. 탐색은 숨김 회수의 drain에 포함하지 않는다. 업데이트는 두 종류를 모두 drain하고 신규 요청을 차단한다. 승인 전후 finalization을 재검사하여 경합을 닫으며, frontend 응답이 HTTP timeout 뒤 도착해도 같은 ID를 정확히 한 번 해제한다.

탐색이 회수 대상 workspace를 활성화하면 기존 frontend checkpoint ACK 직전 적격성 검사가 회수를 거부한다. 이미 close를 넘긴 대상은 기존 closed-ID 반영과 즉시 remount 경로를 따른다. PTY 입력·생성·종료의 admission은 완화하지 않는다. Windows·Linux에 같은 정책을 적용한다.

## Alternatives Considered

- Remote 오류 숨김 또는 자동 재시도: 다른 pane 전환을 막는 원인은 남고 사용자 선택보다 늦은 응답의 탐색이 실행될 수 있다.
- 모든 frontend action을 회수 중 허용: 대화 증거·구조를 바꾸는 작업까지 저장/종료 transaction과 경합한다.
- 탐색을 추적하지 않는 query로 취급: 업데이트가 아직 실행 중인 탐색을 기다리지 않고 checkpoint를 확정할 수 있다.
- 탐색도 generic 진행 수에 포함: 터미널 준비를 기다리는 탐색이 회수 drain을 붙잡을 수 있어 종류별 카운터를 사용한다.

## Consequences

기존 숨김 항목의 회수 실패가 반복되어도 정상 pane 탐색은 유지된다. 허용 목록을 넓힐 때에는 해당 action이 대화 증거·PTY 수명을 직접 변경하지 않는지 검토해야 한다. 요청 등록·중복·해제·update 경합과 회수 중 탐색 및 구조 변경 거부를 회귀 검증한다. 적격성 취소·close 뒤 remount의 기존 검증도 유지한다.

새 설정·API 인자·마이그레이션은 없다. 버전 영향은 patch다. 회수 중 foreground 탐색이 실패하는 버그를 고친다.
