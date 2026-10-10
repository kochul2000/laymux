# 0310. Remote 워크스페이스 관리는 명시적 메뉴와 호스트 이름 변경을 사용한다

- Status: Proposed
- Date: 2026-10-10
- Source: 사용자 요청(롱탭 제외, 워크스페이스 ⋯ 메뉴), architecture/api-contracts.md §13.3, ADR-0149·0166·0187
- Relationship: ADR-0149의 호스트 소유 Remote UI와 ADR-0166의 controller action을 이름 변경으로 확장한다.

## Context

Remote는 워크스페이스 생성·전환·숨김을 제공하지만 이름 변경은 데스크톱에서만 가능하다. 좁은 모바일 행에 작업마다 버튼을 추가하면 목록을 읽기 어려워진다. 롱탭은 기능 발견이 어렵고 스크롤과 충돌하므로 사용하지 않는다. 이번 범위는 이름 변경과 기존 숨김 진입점 통합이며 삭제·복제·순서 변경은 포함하지 않는다.

## Decision

Remote 워크스페이스 행의 명시적 ⋯ 버튼은 현재 터미널을 전환하지 않고 이름 변경·숨김 관리 창을 연다.

이름의 단일 진실원은 데스크톱 workspace store다. `PUT /remote/v1/workspaces/{id}`는 `{name, leaseId?}`를 받고 기존 Remote 인증과 active controller lease를 요구한 뒤 기존 `workspaces.rename` bridge를 호출한다. 빈 이름은 거부하고 정규화·중복 이름 처리는 호스트에 위임한다. 성공 시 `workspace-state-changed`를 발행하고 Remote는 output 재연결 없이 navigation을 갱신한다. Android E2E의 exact HTTP allowlist에도 동일 PUT만 허용한다.

관리 창은 surface-local 상태다. native dialog의 focus containment를 사용하고 Escape·Android system back은 먼저 관리 창을 닫는다. 제어권 상실 후 새 작업을 보내지 않으며 오래된 응답은 새 창의 상태를 덮어쓰지 않는다. 실패한 이름 변경은 입력을 보존하고 오류를 창 안에 표시한다. 기존 마지막 표시 workspace 숨김 제한과 숨김 시 호스트의 fallback 결정은 유지한다.

## Alternatives Considered

- 롱탭 전용 메뉴: 기능 발견과 스크롤 충돌 문제 및 명시적 사용자 요구로 제외한다.
- 이름 변경·숨김 버튼을 행에 모두 표시: 모바일 공간을 더 소비하므로 관리 메뉴로 묶는다.
- Remote에서 이름을 독립 저장: desktop·다른 Remote의 이름이 어긋나므로 기존 store와 bridge를 사용한다.
- 삭제까지 제공: 실행 중 PTY 종료와 확인 절차라는 별도 범위를 만들므로 이번에는 추가하지 않는다.

## Consequences

사용자는 동일 워크스페이스를 유지하며 이름을 수정할 수 있다. 숨김에는 메뉴를 여는 탭이 하나 더 필요하다. 새 PUT route와 Android allowlist, lease 상실·오류·포커스 복원·모바일 표시 검증이 필요하다. 배포에는 Remote asset 재번들과 호스트 재빌드가 필요하며 별도 데이터 마이그레이션은 없다. 관리 작업이 늘어나면 메뉴 크기와 파괴적 작업의 확인 절차를 재검토한다.
