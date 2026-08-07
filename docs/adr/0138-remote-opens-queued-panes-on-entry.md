# 0138. Remote 진입은 아직 열리지 않은 pane 을 직접 열고 붙는다

- Status: Accepted
- Date: 2026-08-07
- Source: issue #779(리모트에서 아직 PC 에서 열리지 않은 pane 진입 시 "No open terminal sessions"); [ADR-0039](0039-remote-spatial-notification-step-navigation.md); [ADR-0127](0127-terminal-startup-slot-follows-eligibility.md); [architecture/api-contracts.md §13.3](../architecture/api-contracts.md)

## Context

`/remote/v1/navigation` 의 pane 요약에는 `terminalLive` 가 있고, 이는 "지금 이 pane 에 backend PTY 세션이 존재하는가" 만 뜻한다. workspace 는 lazy mount 이고 terminal 시작은 전역 슬롯 하나로 직렬화되므로([ADR-0127](0127-terminal-startup-slot-follows-eligibility.md)), **아직 데스크톱에서 한 번도 열리지 않은 pane 은 정상 상태에서도 `terminalLive=false`** 다. 세션이 죽은 pane 과 아직 시작되지 않은 pane 이 payload 상 구분되지 않는다.

Remote 페이지는 `terminalLive` 를 "진입 가능" 조건으로 써 왔다. 그 결과:

- drawer 의 pane 행이 버튼이 아니라 비활성 `div` 로 렌더되어 아직 열리지 않은 pane 은 탭조차 할 수 없었다.
- preferred terminal 선택이 live pane 만 후보로 삼아, 활성 workspace 의 pane 이 전부 아직 시작 전이면 선택 결과가 없었다.
- 그 경우 페이지는 "No open terminal sessions." 를 띄우고 소켓을 닫았다. Remote 는 navigation 을 주기적으로 폴링하지 않으므로 사용자가 수동 refresh 하기 전까지 복구되지 않는 막다른 상태였다.

issue #578 은 이 문제의 일부만 막았다. `workspaces.switchActive` 가 착지 terminal 의 세션 준비를 최대 3.5초 기다리지만, 상한을 넘기면 전환은 성공으로 답하고 Remote 는 다시 live pane 이 없는 스냅샷을 읽는다. 착지 pane 이 아닌 나머지 pane 은 애초에 대기 대상도 아니다.

[ADR-0039](0039-remote-spatial-notification-step-navigation.md) 는 이미 같은 함정을 스텝 내비게이션에서 명시적으로 배제했다 — "`terminalLive` 는 조건이 아니다. live 조건을 걸면 방문한 적 없는 workspace 가 영구 도달 불가가 된다." 이번 결정은 그 원칙을 pane 목록 선택과 메인 출력 attach 경로까지 확장한다.

범위는 Remote 클라이언트의 진입 규칙이다. navigation payload 스키마, lease/권한 경계, 데스크톱 startup slot 정책은 바꾸지 않는다.

## Decision

**Remote 에서 pane 진입 가능 여부는 pane 정체성(터미널 pane 인가)이 정하고, 세션이 없는 pane 은 진입이 직접 연다.**

- pane 요약에 `terminalId` 가 있으면 terminal pane 이며 `terminalLive` 와 무관하게 선택 가능하다. workspace drawer 행과 dock 행 모두 버튼으로 렌더한다.
- 메인 출력 attach 는 단일 진입점을 통과한다. 세션이 있으면 즉시 attach 하고, 없으면 먼저 `/remote/v1/terminals/{id}/focus` 를 보낸 뒤 세션이 생길 때까지 navigation 을 폴링하고 나서 attach 한다. 세션 없는 terminal 에 output 소켓을 여는 것은 404 이므로 순서를 뒤집지 않는다.
- **focus 가 곧 "열어달라" 요청이다.** focus 는 pane 의 workspace 를 활성화하고 그 pane 에 startup slot 우선순위를 준다. 다만 **focus 응답은 판정 근거가 아니다** — cold start 는 Rust bridge 요청 예산(5초)을 넘길 수 있어 성공해도 504 로 돌아올 수 있다. 판정은 navigation 폴링만 소유한다. 폴링 상한은 데스크톱의 terminal 준비 상한과 같은 20초다(선행 슬롯 watchdog 10초를 포함할 수 있어야 한다).
- preferred terminal 폴백 순서는 focused pane → 활성 workspace 의 live pane → 활성 workspace 의 아직 열리지 않은 pane → visible dock 의 live pane → visible dock 의 아직 열리지 않은 pane 이다. live 는 후보 자격이 아니라 동순위 tie-breaker 다.
- **기억된 선택(hint)의 복원만은 live 를 요구한다.** 재접속 시 마지막으로 머문 terminal 이 종료됐다면 사용자가 요청하지 않은 재시작을 하지 않고 기존대로 폴백한다(§13.3 의 hint 계약 유지). 반대로 사용자가 방금 진입한 pane 은 열리는 동안 pinned 로 취급해, 대기 중 실행되는 navigation 재조회가 다른 pane 으로 표류하지 않는다.
- "열 수 있는 터미널이 없다" 는 표시는 활성 workspace 와 모든 visible dock 에 terminal pane 자체가 하나도 없을 때만 남는다.

## Alternatives Considered

- **Remote 가 navigation 을 상시 폴링해 live 가 되면 자동 attach**: 막다른 상태는 풀리지만 사용자가 원한 pane 이 아니라 "먼저 살아난 pane" 으로 끌려가고, 아무도 보지 않는 동안에도 계속 요청을 만든다. 진입이라는 명시적 행위에만 대기를 붙이는 편이 비용과 의도 모두에 맞는다.
- **`/remote/v1/terminals/{id}/attach` 같은 신규 엔드포인트로 backend 가 PTY 를 직접 생성**: startup slot 과 pane reveal 은 frontend 가 소유한다는 ADR-0043/0127 의 단일 슬롯 불변식을 우회한다. 세션만 만들고 xterm 준비를 모르는 경로가 하나 더 생긴다.
- **`terminals.setFocus` 의 세션 대기(20초)를 bridge 예산 안(3.5초)으로 줄여 focus 응답을 판정으로 사용**: 응답 계약이 MCP `focus_terminal` 과 공유되고, 상한을 줄이면 느린 cold start 가 실패로 보고된다. Remote 가 응답에 의존하지 않으면 이 계약을 건드릴 이유가 없다.
- **아직 열리지 않은 pane 을 목록에서 숨기기**: 현재 증상(도달 불가)을 더 나쁘게 만든다. 데스크톱 grid 에는 보이는 pane 이 Remote 에서만 사라진다.

## Consequences

- 아직 열리지 않은 workspace/pane 으로 Remote 가 진입할 수 있고, 활성 workspace 전체가 시작 전이어도 막다른 상태가 되지 않는다. issue #578 의 3.5초 착지 대기는 여전히 빠른 경로로 남고, 그 상한을 넘긴 경우를 이 경로가 받는다.
- 아직 열리지 않은 pane 진입은 즉시 attach 되지 않고 "Opening the pane on the desktop..." 상태를 거친다. 데스크톱 startup slot 이 밀려 있으면 최대 20초까지 걸릴 수 있고, 넘기면 실패 상태를 남긴다(자동 재시도 없음, 다시 탭하면 재시도).
- cold 진입 1회당 focus 요청이 하나 나가고, 열릴 때까지 0.4초 간격의 navigation 재조회가 발생한다. focus 가 504 로 끝나도 정상 경로로 취급한다.
- `terminalLive` 는 payload 계약에 그대로 남는다. 의미가 "진입 가능" 이 아니라 "지금 attach 하면 바로 붙는다" 로 좁혀졌을 뿐이다.
- 검증은 `ui/e2e/remote-cold-pane-entry.spec.ts`(전부 cold 인 접속, cold pane 탭 진입)와 `src-tauri/src/remote_server/page.rs` 의 page.html 불변식 테스트가 담당한다.
- 재검토 조건: 데스크톱이 "종료된 pane" 과 "아직 열리지 않은 pane" 을 payload 에서 구분하게 되면 hint 복원 규칙의 live 요구를 다시 볼 수 있다.
