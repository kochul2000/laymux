# 0017. MCP dev 전용 툴 노출 정책

- Status: Accepted
- Date: 2026-07-03
- Source: 사용자 요구(Phase 2 MCP dev 전용 툴 추가 + 게이팅) · ADR-0002 · ADR-0006 · architecture/api-contracts.md §12.7

## Context

laymux MCP 표면은 에이전트가 IDE를 처음부터 끝까지 조작해 기능 개발 e2e를 구동할 수 있어야 한다. 기존 release MCP 툴은 터미널·워크스페이스·그리드 조작에는 충분하지만, UI 검증에 필요한 hover 시뮬레이션, Settings/Remote Access 모달 제어, hide mode 조작, 설정 일부 쓰기 같은 프론트엔드 bridge 경로가 빠져 있었다.

동시에 이 툴들은 사용자가 실행하는 release 인스턴스의 일반 자동화 표면으로 공개하기에는 성격이 다르다. `simulate_hover`처럼 스크린샷 검증 상태를 강제로 만들거나, `set_pane_view`처럼 pane view config를 직접 바꾸거나, Settings/Remote Access 모달을 임의로 여닫는 동작은 개발·검증 편의가 목적이다. release에서는 기존 안정 툴 표면을 유지하고, dev에서는 기능 개발 루프를 위해 더 넓은 조작면을 제공해야 한다.

release/dev 구분은 ADR-0002의 고정 포트 정책과 일치한다. release는 `19280`, dev는 `19281`이며, 현재 코드는 `automation_port()`가 `cfg!(debug_assertions)`로 포트를 결정한다. MCP 서버는 같은 axum Automation API 아래에 붙으므로 이 런타임 구분을 MCP handler에 전달할 수 있다.

## Decision

MCP 툴에는 release 기본 표면과 dev 전용 표면을 둔다.

- release(`19280`) MCP는 기존 안정 툴만 `tools/list`에 노출한다.
- laymux-dev(`19281`) MCP는 release 툴에 더해 기능 개발 e2e 구동용 dev 전용 툴을 노출한다.
- dev 전용 툴은 release에서 `tools/list` 결과에 나오지 않아야 하며, 이름을 직접 `tools/call`로 호출해도 `tool not found`로 거부한다. `get_tool`도 같은 정책을 따른다.
- `rmcp`의 `#[tool_handler]` 매크로는 `call_tool`/`list_tools`/`get_tool`가 impl에 이미 있으면 생성하지 않으므로, 단일 `ToolRouter`를 유지하고 `McpHandler.is_dev` 기반 런타임 필터를 직접 구현한다. 별도 prod/dev 라우터를 병렬 유지하지 않는다.
- dev 여부는 Automation API가 바인드한 고정 포트로 판정해 `McpHandler` 생성 시 주입한다. 포트 정책이 바뀌면 MCP 노출 정책도 같은 기준을 따른다.

## Consequences

- 에이전트는 laymux-dev에서 Settings/Remote Access/hover/hide mode/view 전환을 MCP로 제어할 수 있어 UI 기능 개발과 스크린샷 검증 루프를 닫을 수 있다.
- release 사용자는 dev 검증용 툴을 발견하거나 호출할 수 없다. MCP 클라이언트가 툴 목록을 캐시하더라도 release 서버는 직접 호출을 거부한다.
- 모든 툴 구현은 계속 `bridge(category,target,method,params)` 얇은 래퍼 패턴을 따른다. bridge/REST 핸들러를 복제하지 않는다.
- dev 전용 툴 추가 시 `DEV_ONLY_TOOLS` 목록, living doc의 dev 전용 툴 표, 필터 테스트를 함께 갱신해야 한다.
- 단일 라우터를 유지하므로 schema 생성과 라우팅 중복은 늘지 않지만, 툴 이름 기반 게이팅 목록이 release/dev 계약의 명시적 유지 지점이 된다.
