# 0014. MCP 설정 구성 — 에이전트가 laymux settings 를 읽고 쓰는 경로

- Status: Accepted
- Date: 2026-06-28
- Source: 사용자 요구(에이전트가 MCP 로 laymux 를 셋업 — "클로드가 자체 세팅 바꾸듯") · ADR-0002 · ADR-0004 · ADR-0006 · ADR-0013 · architecture/api-contracts.md §"Direct Remote Mode 설정"

## Context

laymux 설정의 단일 진실원은 `settings.json` 이다([ADR-0004](0004-settings-vs-ui-state-separation.md)). 현재 이 파일을 바꾸는 경로는 세 가지뿐이다.

1. SettingsView UI 에서 사람이 직접 편집.
2. `settings.json` 파일 직접 편집 후 앱 재시작/리로드.
3. Automation HTTP REST 의 좁은 세터 — `PUT /api/v1/settings/app-theme`, `/profile-defaults`, `/profiles/{index}` 3개뿐. 임의 키(예: ADR-0013 의 `remote`, appearance 전체)는 다루지 못한다.

MCP 경로는 **읽기조차 부분적**이다. 내장 MCP 서버([ADR-0006](0006-embedded-mcp-server.md))는 terminal/workspace/grid/pane/memo/notification/screenshot 제어 툴을 제공하지만 설정 툴은 `list_profiles`(프로필 조회) 하나뿐이고, 설정을 바꾸는 MCP 툴은 **하나도 없다**.

사용자 목표는 에이전트(예: Claude)가 MCP 로 laymux 를 **셋업**하는 것이다. 에이전트가 자기 설정을 바꾸듯, laymux 에게 "원격 모드 켜고 allowlist/토큰 설정해", "이 프로필로 바꿔", "테마 바꿔" 를 시키면 구성이 적용돼야 한다. 특히 ADR-0013 Direct Remote Mode 는 `remote.enabled`/`allowedIps`/`authToken` 등 opt-in 구성이 필요한데, 이를 MCP 로 켤 방법이 없으면 에이전트 주도 셋업이 끊긴다.

작용하는 force:

- **신뢰 경계**([ADR-0002](0002-automation-api-fixed-port-ip-allowlist.md)). Automation API/MCP 는 고정 포트 + 로컬 IP allowlist + 무인증이다. 설정 쓰기는 읽기보다 위험하지만, 이미 `write_to_terminal`·`create_workspace` 등 상태를 바꾸는 MCP 툴이 같은 경계 안에서 동작한다. 설정 쓰기도 같은 로컬 신뢰 경계에 속한다.
- **원격면과의 분리**([ADR-0013](0013-direct-remote-mode.md)). Direct Remote Mode 의 브라우저 원격면은 별도 인증/Origin/세션을 가진 다른 경계다. 원격 브라우저가 allowlist/토큰을 스스로 고쳐 권한을 확대하면 안 된다.
- **검증의 단일화.** 설정 로드는 `validate_and_repair` 로 결정론적 복구를 한다(`SettingsLoadResult { Ok | Repaired | ParseError } + warnings`). 쓰기 경로도 같은 머지·검증·영속을 재사용해야 하며, 두 번째 설정 변경 구현을 만들면 안 된다.
- **영속 경로의 단일화**([ADR-0006](0006-embedded-mcp-server.md)). 기존 HTTP 세터는 frontend store 로 bridge 한 뒤 store 머지 → `persistSession()` → `save_settings` 로 `settings.json` 에 쓴다. MCP 도 같은 bridge 경로를 타야 store 와 디스크가 갈라지지 않는다.

## Decision

laymux 설정 읽기/쓰기를 **MCP 툴로 노출**한다. 다른 MCP 제어 툴과 동일한 설계(내장 MCP 서버, frontend bridge, 로컬 신뢰 경계)를 따른다.

- 내장 MCP 서버에 설정 툴을 추가한다: 현재 설정을 읽는 **`get_settings`** 와, 타입 스키마 위에서 부분 deep-merge 로 설정을 바꾸는 **`update_settings`**. 키는 `settings.json` 계약(appearance, profiles, profileDefaults, remote, memo, fileExplorer 등)을 그대로 따른다.
- 쓰기는 **frontend bridge 경로를 재사용**한다([ADR-0006](0006-embedded-mcp-server.md)). MCP `update_settings` 는 기존 HTTP 세터와 같은 `"settings"` action 으로 bridge 해 store 머지 → `persistSession()` → `save_settings` 로 영속한다. 설정 변경 구현은 frontend store 한 곳으로 단일화하고, MCP 툴과 HTTP 세터는 같은 핸들러를 공유한다(두 번째 구현 금지).
- 입력은 **부분(partial) JSON** 이다. 서버/스토어가 현재 설정에 deep-merge 한 뒤 `validate_and_repair` 동일 규칙으로 정규화하고, **결과로 적용된 실효 설정과 복구 warnings 를 반환**한다. 잘못된 값은 조용히 버리지 않고 복구하거나 보고한다 — 이것이 사용자가 요구한 결정론적 검증의 형태다.
- 설정 쓰기는 **Automation/MCP 의 로컬 신뢰 경계 안에만** 둔다([ADR-0002](0002-automation-api-fixed-port-ip-allowlist.md)). Direct Remote Mode 의 원격 브라우저면([ADR-0013](0013-direct-remote-mode.md))에서는 설정 쓰기를 노출하지 않는다. 원격 peer 가 `remote.allowedIps`/`authToken` 등을 고쳐 권한을 확대하는 경로를 차단한다.
- 기존 좁은 HTTP 세터(app-theme/profile-defaults/profiles)는 유지한다. `update_settings` 는 이를 대체하지 않고 임의 키까지 포괄하는 상위 경로로 보완한다.
- 설정의 **런타임 반영 시점은 각 설정의 기존 의미를 따른다**. 라이브 반영되는 값(테마 등)은 즉시, 매 요청 시 `load_settings` 를 읽는 값(remote 게이트 등)은 다음 요청부터, 시작 시 한 번만 읽는 값(예: bind address)은 재시작 후 적용된다. MCP 툴은 "영속"을 보장하고, "즉시 런타임 반영"은 설정별 기존 정책에 위임한다.

## Consequences

- 에이전트가 MCP 만으로 laymux 를 셋업할 수 있다. ADR-0013 Direct Remote Mode 를 포함해 임의 설정 키를 켜고 구성하는 에이전트 주도 셋업이 가능해진다.
- 설정 변경 로직이 frontend store 한 곳에 머문다. MCP·HTTP·UI 가 같은 머지/검증/영속 경로를 공유하므로 store 와 `settings.json` 이 갈라지지 않는다.
- bridge 경로를 타므로 **앱 창(frontend)이 살아 있어야** `update_settings` 가 동작한다. 다른 bridge 기반 MCP 툴과 같은 제약이며, headless 백엔드 단독 변경은 이 결정의 범위가 아니다.
- 설정 쓰기는 로컬 IP allowlist 안에 있는 호출자면 무인증으로 수행된다([ADR-0002](0002-automation-api-fixed-port-ip-allowlist.md)). 이는 기존 쓰기 툴과 동일한 신뢰 모델이고, 원격 브라우저면에는 노출하지 않아 권한 확대 경로를 만들지 않는다.
- 부분 머지 + `validate_and_repair` 반환으로 에이전트는 자기가 보낸 값이 어떻게 정규화/복구됐는지 결정론적으로 확인하고 후속 호출을 조정할 수 있다.
- 설정의 즉시 반영 여부가 설정별로 다르므로, 일부 키(예: bind address)는 변경 후에도 재시작 전까지 효과가 없을 수 있다. 이 비대칭은 MCP 툴이 아니라 각 설정의 런타임 정책 책임이다 — 필요하면 후속 ADR/리팩터로 reload 일관성을 따로 다룬다.
