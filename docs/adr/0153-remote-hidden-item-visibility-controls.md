# 0153. Remote 숨김 항목 편집은 PC 상태 소유자를 재사용한다

- Status: Proposed
- Date: 2026-08-13
- Source: 사용자 요구(2026-08-13), [ADR-0033](0033-hidden-items-shelf-set-contract.md), [ADR-0035](0035-workspace-only-shelf-per-pane-hide-toggle.md), [ADR-0151](0151-remote-workspace-selector-information-parity.md), [api-contracts.md §13.3](../architecture/api-contracts.md#133-navigation-metadata)

## Context

Remote navigation payload는 숨긴 workspace와 pane도 `hidden`/`collapsed`로 전달하지만, Remote drawer는 이를 접어서 표시하지 않고 가시성 변경 API도 제공하지 않는다. PC에 접근할 수 없는 사용자는 Remote에서 무엇이 숨겨졌는지 확인하거나 복원할 수 없고 새 항목을 숨길 수도 없다.

숨김 상태는 PC WebView의 `uiStore.hiddenWorkspaceIds`와 `hiddenPaneIds`가 정본이다. 특히 active workspace를 숨길 때는 다음 visible workspace로 먼저 전환해야 하고 마지막 visible workspace는 숨길 수 없으며, 복원할 때 자동 종료 eviction도 함께 해제해야 한다. Remote가 이 규칙을 복제하면 두 표면의 상태와 불변식이 갈릴 수 있다. Android E2E도 PC가 배포한 같은 Remote 문서를 실행하므로 새 동작은 브라우저와 암호화 transport에서 같아야 한다.

범위는 workspace/pane 숨김·복원과 그 표시다. workspace/pane 삭제, 재배치, dock 숨김, Remote 전용 숨김 상태는 비목표다.

## Decision

**Remote는 목표 `hidden` 값을 명시하는 lease-gated API로 PC WebView의 기존 숨김 상태 소유자를 호출하고, drawer는 PC의 workspace 보관함과 pane eye 제어를 Remote 표면에 맞게 미러한다.**

- `POST /remote/v1/workspaces/{id}/visibility`와 `POST /remote/v1/panes/{id}/visibility`는 `{hidden:boolean, leaseId?}`를 받는다. `X-Laymux-Remote-Lease`도 허용하며 active controller lease가 필수다.
- API는 toggle이 아니라 목표 상태를 받는 멱등 set이다. 전송 재시도나 늦은 snapshot이 같은 요청을 반복해도 상태가 역전되지 않는다.
- frontend bridge의 `ui.setWorkspaceHidden`은 PC의 `setWorkspaceHiddenWithFallback`을 호출한다. 따라서 active fallback, 마지막 visible workspace 차단, 정렬 순서와 focus 착지 규칙을 공유한다. `ui.setPaneHidden`은 존재하는 workspace pane만 대상으로 기존 `setPaneHidden`을 호출한다. 복원 시 eviction 해제도 기존 store가 담당한다.
- Remote drawer는 visible workspace만 평상시 목록에 두고, 헤더의 `Hidden N` chip 아래 workspace-only shelf를 연다. shelf 행 클릭은 복원 후 진입하고 eye action은 복원만 한다. visible workspace의 eye action은 숨김을 요청한다.
- Remote는 PC의 여러 pane grid를 동시에 그리지 않으므로 pane 행마다 eye action을 둔다. 숨긴 pane은 선택 대상이 아닌 축약·저강조 control row로 남겨 사용자가 상태를 보고 같은 위치에서 복원할 수 있게 한다. 이는 Remote에서 PC pane controlbar eye에 대응하는 표면이다.
- 변경 중 control은 중복 제출을 막고, 성공 뒤 `/remote/v1/navigation`을 다시 읽어 서버가 확정한 상태만 그린다. 실패하면 기존 snapshot을 유지하고 오류를 표시한다.
- 두 endpoint는 Android E2E 내부 HTTP exact allowlist에도 추가한다. relay와 Android wrapper는 workspace/pane 의미를 해석하지 않는다.
- 성공한 변경은 `workspace-state-changed`를 발행한다. read-only navigation endpoint의 lease-free 계약은 유지한다.

## Alternatives Considered

- **기존 `ui.toggle*Hidden`을 Remote에서 직접 호출**: endpoint와 구현은 짧지만 응답 유실 뒤 재시도하면 목표와 반대로 뒤집힐 수 있어 기각했다.
- **Remote localStorage에 별도 숨김 상태 저장**: PC 자원 절약과 selector 상태에 영향을 주지 않고 다른 기기와도 불일치하므로 기각했다.
- **숨긴 pane도 완전히 제거하고 active pane header에서만 복원**: PC controlbar와 가깝지만 inactive hidden pane으로 이동할 경로가 없어 Remote만으로 복원이 불가능하므로 기각했다.
- **workspace와 pane을 하나의 전역 shelf에 함께 표시**: 복원은 쉽지만 workspace-only shelf와 pane controlbar로 책임을 나눈 ADR-0035의 PC 모델에서 멀어지므로 기각했다.

## Consequences

- Remote만으로 PC와 동일한 workspace/pane 숨김 상태를 관리할 수 있고, 마지막 visible workspace와 focus 전환 불변식이 유지된다.
- drawer에 workspace 보관함과 두 종류 eye action이 추가되어 좁은 화면의 control 밀도가 늘어난다. 숨긴 pane은 저강조 행으로 남기고 workspace 보관함은 평소 접어 비용을 제한한다.
- API·frontend bridge·Android E2E allowlist·Remote 정적 page가 함께 바뀌며 Rust unit, frontend bridge, Playwright mobile UI 회귀 테스트가 필요하다.
- 기존 payload의 `hidden`/`collapsed` 필드는 유지하므로 read-only 소비자에 breaking change는 없다. 새 endpoint를 모르는 이전 Remote 문서는 기존처럼 열람만 한다.
