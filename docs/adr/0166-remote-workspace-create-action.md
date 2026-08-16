# 0166. Remote는 lease 보유자에게 선택한 레이아웃의 워크스페이스 생성 액션을 제공한다

- Status: Accepted
- Date: 2026-08-16
- Source: 사용자 요구(2026-08-16), [api-contracts.md §13.3](../architecture/api-contracts.md#133-navigation-metadata), [ADR-0151](0151-remote-workspace-selector-information-parity.md)

## Context

Remote drawer는 PC의 워크스페이스 목록을 보고 선택·숨김·복원할 수 있지만 새 워크스페이스를 만들 수는 없다. 원격에서 작업을 분리하려면 PC를 다시 열어야 한다. 이 변경의 범위는 목록 섹션에서 PC에 정의된 layout 하나를 골라 생성하는 동작이며, 이름 편집·자동 전환은 포함하지 않는다.

## Decision

**Remote Workspaces 섹션 제목 아래에 layout 선택 하위 패널을 두고, active controller lease가 있는 요청만 `POST /remote/v1/workspaces`로 PC WebView의 기존 `workspaces.add` 액션을 호출한다.**

- `GET /remote/v1/layouts`가 PC WebView의 layout 목록을 제공하고, POST는 받은 `layoutId`가 그 목록에 있는지 다시 검증한다.
- 서버가 선택한 layout 이름과 현재 개수로 워크스페이스 이름을 정한다.
- 성공해도 현재 active workspace와 terminal focus는 유지한다. Remote는 navigation snapshot을 다시 읽어 PC가 확정한 목록만 렌더한다.
- 생성은 다른 workspace 변경과 같이 `workspace-state-changed`를 발행하고, Android E2E 내부 HTTP exact allowlist에 같은 경로를 추가한다.

## Alternatives Considered

- **Remote에 이름 입력까지 노출**: 데스크톱 selector의 더 넓은 편집 흐름을 복제하고 좁은 drawer의 목적을 벗어나므로 제외한다.
- **기존 workspace로 이동시켜 생성**: 생성이 현재 작업 맥락을 바꾸므로, 새 항목을 목록에만 반영하는 편이 안전하다.
- **lease 없이 생성 허용**: 원격 observer가 PC 상태를 바꾸게 되어 기존 controller 권한 경계와 충돌하므로 제외한다.

## Consequences

- 원격 controller가 PC를 열지 않고 작업 공간을 하나 추가할 수 있다.
- PC에 정의된 layout은 선택할 수 있지만 이름은 자동 생성한다.
- Remote route·페이지·Android E2E allowlist·계약 문서가 함께 변경되며, route와 정적 페이지 계약 테스트로 이를 고정한다.
