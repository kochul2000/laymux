# 0054. Composer 과거 입력 recall 범위는 전역·워크스페이스·페인 중 고르는 설정이다

- Status: Proposed
- Date: 2026-07-25
- Source: 사용자 요구(과거 입력이 pane 별로 격리되어 다른 pane 에서 재사용 못함) · [ADR-0029](0029-detached-terminal-input-composer.md) · [ADR-0034](0034-single-send-terminal-composer.md) · [data-flow §8.8](../architecture/data-flow.md) · [api-contracts §13.4](../architecture/api-contracts.md)

## Context

Composer 가 전송한 초안은 지금 terminal id 하나만을 키로 하는 runtime 버킷에 쌓인다. 데스크톱과 Remote 가 각각 자기 페이지 안에 `terminalId → string[]`(oldest→newest, 최대 200) 맵을 두고, recall 경로 세 개(초안 edge 의 ↑/↓, 빈 초안 Tab 팝업, 타이핑 중 자동완성)가 모두 그 pane 의 버킷만 읽는다. 그래서 한 pane 에서 쓴 긴 명령을 옆 pane 이나 다른 워크스페이스에서 다시 쓰려면 손으로 다시 입력해야 한다. pane 격리는 ADR-0029 가 초안(draft)에 요구한 격리를 history 에도 그대로 적용한 결과이지, history 자체를 위해 따로 고른 범위가 아니었다.

작용하는 force:

- 사용자에게 필요한 재사용 범위가 하나로 고정되지 않는다. 같은 작업을 여러 pane 에 나눠 돌리는 사용자는 워크스페이스 단위 공유를, 앱 전체에서 같은 몇 개 명령을 반복하는 사용자는 전역 공유를, 세션 격리를 원하는 사용자는 현행 pane 을 원한다.
- ADR-0029/0034 가 세운 **입력 문자열 비영속 경계**는 이번 결정으로 흔들려선 안 된다. 셸에 입력한 비밀번호 같은 문자열이 `settings.json`·`localStorage`·`sessionStorage`·디스크·네트워크·로그로 새지 않아야 한다.
- 범위를 넓히는 것은 **같은 세션 안에서** 실수로 입력한 secret 이 보이는 recall 표면을 넓힌다. 다만 워크스페이스는 보안 경계가 아니다 — 같은 앱·같은 세션·같은 사용자 데스크톱의 in-memory 상태이므로, 노출 반경 차이는 `pane`(격리) 대 공유 사이에만 실질적으로 존재하고 `workspace` 와 `global` 사이에는 거의 없다. 따라서 이 트레이드오프는 사용자가 `pane` 을 고를 수 있게 보장하는 문제이고, 공유 범위의 기본값을 좁히는 근거는 되지 못한다.
- 워크스페이스는 작업 단위이기도 하지만 **레이아웃 단위**로도 쓰인다. 같은 프로젝트를 워크스페이스 여러 개로 쪼개 쓰는 사용자에게는 워크스페이스 경계도 여전히 임의의 격리다.
- Remote 정적 페이지는 host `settings.json` 을 읽지 않는다(설정 endpoint 없음). 그러나 두 surface 의 recall 동작 규칙은 같은 설계로 유지해야 한다.
- 워크스페이스 단위 키를 쓰려면 terminal → workspace 해석이 필요하다. 데스크톱은 `terminalStore` 를 SoT 로 하는 `resolveWorkspaceId(terminalId)` 가 이미 있고, Remote 는 snapshot 의 terminal `workspaceId` 를 가지지만 dock(앱 전역) 터미널은 이 값이 없다.
- 내부 개발 단계이므로 설정 스키마 변경에 마이그레이션 로직을 만들지 않는다(AGENTS.md).

범위: recall 이 읽고 쓰는 history 버킷의 키 규칙과 그 범위를 고르는 설정, 두 surface 의 설정 저장 위치. 비목표: history 의 디스크 영속, 셸 자체 history(`HISTFILE`) 통합, Remote 에 host 설정 전달 endpoint 신설, history 항목 편집·삭제 UI, pane 별 범위 override.

## Decision

Composer history 버킷의 키는 terminal id 가 아니라 **선택된 범위에서 도출한 scope key** 이며, 범위는 `global`·`workspace`·`pane` 세 값 중 하나를 고르는 설정이다. 기본값은 `global` — 사용자가 설정을 건드리지 않아도 pane 격리 불편이 사라지는 값을 기본으로 한다. `workspace` 는 목록 노이즈를 줄이려는 사용자를 위한 중간 값이고, `pane` 은 현행 격리 동작이다.

- **저장 SoT** — surface 별로 `Map<scopeKey, string[]>`(oldest→newest, 버킷당 최대 200) 하나를 둔다. cap 은 범위와 무관하게 버킷당 200 으로 유지한다 — `global` 에서는 모든 워크스페이스·pane 의 입력이 같은 200 을 나눠 쓰므로 오래된 항목이 더 빨리 밀린다. recall 표면이 최신 8개 수준이므로 cap 을 범위별로 다르게 두는 복잡도를 감수할 이유가 없다. 텍스트는 ADR-0029 의 경계를 그대로 승계해 **in-memory only** 이며 어떤 storage·디스크·네트워크·로그에도 쓰지 않는다. 이번 설정으로 영속되는 것은 **범위 선택값 하나**뿐이고 입력 내용은 아니다.
- **키 도출은 순수 함수 하나** — `global` → 고정 상수 키, `workspace` → 해당 워크스페이스 id 키, `pane` → terminal id 키. 읽기 세 경로와 쓰기(전송 성공 콜백) 모두 이 함수 하나만 호출한다. 읽기와 쓰기가 키를 각자 계산하는 구현은 금지한다.
- **workspace 해석** — `workspace` 범위에서만 필요하다(`global` 은 terminal 소속을 보지 않는다). 데스크톱은 기존 `resolveWorkspaceId(terminalId)`(SoT: `terminalStore`)를 재사용한다. Remote 는 snapshot 의 terminal `workspaceId` 를 쓴다. 해석할 수 없으면(dock 등 워크스페이스에 속하지 않는 터미널) **global 로 승격하지 않고 pane 키로 좁게 fallback** 한다 — 알 수 없는 소속을 공유 버킷에 섞지 않는 fail-narrow 규칙이다.
- **범위 전환은 병합·이관·복사를 하지 않는다** — 전환 시점부터 다른 버킷을 읽고 쓸 뿐이다. 이전 버킷은 세션 동안 남아 있어 되돌리면 다시 보인다. 전환 순간 열려 있던 recall 팝업·자동완성은 닫아 stale 인덱스를 없앤다.
- **수명** — 버킷은 세션(WebView·Remote 페이지 수명) 한정이다. reload 는 전부 소멸시킨다(현행 유지). 워크스페이스 삭제는 그 워크스페이스 키 버킷을 폐기한다. pane 종료는 그 pane 키 버킷만 폐기하고 공유 버킷은 건드리지 않는다.
- **설정 계약(데스크톱)** — `settings.json` 의 `terminal.composerHistoryScope`(string enum, 기본 `"global"`). 알 수 없는 값은 오류 없이 기본값으로 해석하고, semantic validation 의 enum allowlist 에 `/terminal/composerHistoryScope` 를 등록해 `describe_settings`/`validate_settings`/MCP 가 같은 값 집합을 본다([ADR-0032](0032-llm-settings-introspection-and-safe-mutation.md)). 기존 `terminal.composerHistoryPopup`·`terminal.composerAutocomplete` 와 직교한다 — 범위는 "무엇을 보나", 두 토글은 "어떻게 보나"다.
- **설정 계약(Remote)** — Remote 는 host 설정을 읽지 않으므로 surface-local `localStorage` 키 `laymux.remote.composerHistoryScope` 에 같은 세 값을 저장한다(없거나 알 수 없으면 `global`). 토글 UI 는 기존 소프트 키 `⚙` 팝오버의 "Composer recall" 섹션에 둔다. 새 Remote endpoint 를 만들지 않고, 데스크톱 설정과 자동 동기화하지도 않는다.
- **보안 경계 재확인** — 범위 확대는 같은 세션 안에서 recall 목록에 뜨는 항목의 출처만 넓힌다. 세션을 넘는 유출 경로는 이전과 같이 존재하지 않는다. 노출 반경을 최소화하려는 사용자는 `pane` 을 고르면 현행 동작과 동일하다.

## Alternatives Considered

- **현행 pane 고정 유지** — 사용자 불편이 그대로 남고, 재사용 범위가 하나로 고정될 근거가 없다. 기각.
- **설정 없이 전역 단일 history(범위 선택 제거)** — 격리를 원하는 사용자에게 되돌릴 방법이 없어진다. secret 을 실수로 입력했을 때 그 pane 안으로 노출을 묶어두는 선택지는 남겨야 한다. 기각.
- **기본값을 `workspace` 로** — 최신순 Tab 팝업(기본 8개)에 다른 워크스페이스의 최근 입력이 끼는 노이즈를 줄인다는 장점이 있고, 초안 검토 단계에서 이 값을 먼저 제안했다. 그러나 (1) 워크스페이스는 보안 경계가 아니므로 노출 반경 근거가 되지 못하고, (2) 워크스페이스를 레이아웃 단위로 쓰는 사용자에게는 여전히 임의의 격리가 남아 사용자가 다시 설정을 만져야 하며, (3) 기본값의 기준은 "설정을 건드리지 않은 사용자의 가장 흔한 기대"다. 노이즈는 자동완성이 prefix 매칭이고 팝업이 최신 8개로 짧다는 점에서 감수할 수 있는 비용이라 판단해 `global` 을 기본값으로 정했다. 노이즈가 실제로 문제되면 사용자가 `workspace` 로 좁힌다.
- **pane 버킷은 그대로 두고 읽을 때만 상위 범위를 union 으로 병합** — 쓰기 위치가 모호해지고, 중복 제거·최신순 정의와 버킷당 200 cap 의 의미가 흐려진다. 키 하나로 결정되는 단일 버킷이 계약이 단순하다. 기각.
- **범위 전환 시 기존 항목을 새 범위로 병합·이관** — 좁은 범위에서 쌓인 문자열(비밀번호 포함 가능)을 사용자 의도 없이 넓은 범위로 승격시킨다. 기각.
- **범위를 pane 별 override 로** — recall 경로 3 개 × surface 2 개 × pane override 조합이 커지고, 사용자 요구는 "범위를 하나 고르고 싶다"였다. 전역 설정 하나로 시작하고 필요가 확인되면 재검토한다.
- **Remote 가 host `settings.json` 을 읽는 endpoint 신설** — Remote 표면 설정을 surface-local 로 두는 기존 원칙(ADR-0029/0036/0040)과 어긋나고 lease·권한 계약을 건드린다. 기각.
- **셸 history(`HISTFILE`) 통합** — 디스크 영속과 셸별 파싱이 필요해 비영속 경계와 정면 충돌한다. 비목표.

## Consequences

- 사용자는 pane·워크스페이스를 옮겨도 최근 입력을 재사용할 수 있고, 필요하면 `workspace` 로 좁히거나 `pane` 격리로 되돌릴 수 있다. 기본값이 `global` 이므로 첫 실행 동작은 지금과 달라진다(마이그레이션 없음).
- `global` 기본값의 비용은 두 가지다. (1) Tab 팝업 최신 목록에 다른 워크스페이스의 입력이 섞인다. (2) 버킷당 200 cap 을 전체가 공유하므로 여러 워크스페이스를 활발히 쓰면 오래된 항목이 더 빨리 밀린다. 둘 다 설정으로 좁히면 사라진다.
- history API 의 인자가 terminal id 에서 scope-resolved key 로 바뀐다. 데스크톱 `readComposerHistory`/`pushComposerHistory`/`clearRuntimeComposerState` 와 Remote 대응 함수·호출부가 모두 새 키 도출 함수를 거쳐야 한다. 한 곳이라도 예전 키를 쓰면 쓰기와 읽기가 다른 버킷을 보는 조용한 버그가 되므로, 키 도출 함수를 단일 진입점으로 고정하는 것이 이 결정의 핵심 불변식이다.
- 공유 버킷이 생기면서 pane 종료·워크스페이스 삭제의 정리 대상이 달라진다. pane 종료가 공유 버킷을 비우면 다른 pane 의 recall 이 사라지므로, 위 수명 규칙을 테스트로 고정해야 한다.
- 테스트 후속: 키 도출 순수 함수(3 범위 + workspace 해석 실패 시 pane fallback), 범위 전환 시 병합 없음과 팝업 닫힘, pane 종료가 공유 버킷을 유지함, 비영속 회귀 테스트에 새 설정 키가 입력 텍스트를 담지 않음, Rust settings contract·semantic validation, Remote `page.rs` HTML 계약.
- 문서 후속: 구현 PR 에서 [data-flow §8.8](../architecture/data-flow.md) 과 [api-contracts §13.4](../architecture/api-contracts.md)·설정 표를 갱신한다.
- 재검토 조건: pane 별 override 요구가 실제로 생기거나, recall 목록에 항목의 출처(워크스페이스·pane) 라벨·필터가 필요해지거나, 범위 공유가 secret 노출 사고로 이어지면 새 ADR 로 정정한다.
