# 0046. Remote 공간순회 제외 상태는 Remote 클라이언트가 소유한다

- Status: Accepted
- Date: 2026-07-20
- Source: 사용자 요구(Remote 전용, 기본 전체 포함, Remote 상단 바에서 현재 pane 제외/복귀); [architecture/api-contracts.md §13.3](../architecture/api-contracts.md); [ADR-0015](0015-remote-terminal-state-ownership.md); [ADR-0028](0028-remote-soft-key-toolbar.md); [ADR-0039](0039-remote-spatial-notification-step-navigation.md) 확장

## Context

ADR-0039의 Remote 공간순서는 표시 중인 모든 workspace의 TerminalView pane을 하나의 순환 리스트로 만든다. 워크스페이스 경계를 신경 쓰지 않고 이동할 수 있지만 pane이 많아지면 Remote에서 필요하지 않은 pane까지 매번 방문하게 된다.

이 선택은 PC workspace 편집 기능이 아니다. 사용자는 PC pane 컨트롤 바에 별표나 상태를 노출하지 않고, 현재 터미널을 보고 있는 Remote 상단 바에서만 순회 포함 여부를 바꾸길 원한다. 또한 아무 설정이 없는 기본 동작은 기존과 동일하게 모든 eligible pane을 포함해야 한다. 그러므로 favorites allowlist보다 기본 전체 목록에서 일부를 빼는 denylist가 의도에 직접 대응한다.

Remote 페이지는 PC React layout과 별도 브라우저 surface다. 제외 상태를 호스트 pane override로 둘지, Remote surface의 로컬 상태로 둘지, 그리고 그 상태를 데스크톱 프론트엔드가 계산하는 공간순서에 어떻게 전달할지 결정해야 한다. Notification 순회, dock 순회 포함, PC 키보드 탐색은 범위 밖이다.

## Decision

**Remote 공간순회는 모든 eligible pane을 기본 포함하고, 활성 Remote 클라이언트가 요청에 실어 보낸 pane ID denylist만 그 순회에서 제외한다. 제외 상태와 편집 UI는 Remote surface에만 존재한다.**

- 제외 raw state의 SoT는 Remote 페이지의 `Set<paneId>`다. `localStorage` 키 `laymux.remote.spatialExcludedPaneIds`에 문자열 배열로 저장하며, 키가 없거나 값이 잘못됐으면 빈 집합으로 복구한다. 이 상태는 Remote 브라우저별 surface-local UI 선호이고 PC WebView·`settings.json`·workspace layout·`paneOverrides`에는 저장하지 않는다.
- Remote 상단 바는 현재 출력이 active workspace의 TerminalView pane일 때만 건너뛰기 토글을 표시한다. Dock terminal, 연결 전, 연결된 workspace pane이 없을 때는 숨긴다. 기본 `aria-pressed=false`는 포함, pressed 상태는 제외를 뜻하며 같은 버튼으로 즉시 다시 포함할 수 있다. PC pane 컨트롤 바에는 관련 표시나 조작을 추가하지 않는다.
- `/remote/v1/navigation/spatial` body는 기존 `leaseId`와 `direction`에 `excludedPaneIds: string[]`를 선택적으로 받는다. 누락은 빈 배열과 같아 기존 클라이언트 동작을 보존한다. Rust는 active lease를 검증한 뒤 목록을 frontend bridge `navigation.spatialStep`에 중계하고, 데스크톱 프론트엔드는 ADR-0039의 eligible 공간순서를 먼저 만든 다음 일치하는 pane ID를 제거한다.
- stale ID, hidden workspace의 pane ID, non-terminal 또는 dock pane ID처럼 현재 eligible 목록에 없는 값은 효과가 없다. 제외 목록은 navigation notification step에 적용하지 않는다.
- 모든 eligible pane이 제외되면 전체 목록으로 폴백하지 않고 `{moved:false, reason:"no_included_panes"}`를 반환한다. 현재 출력은 그대로 남고 상단 토글도 유지되므로 사용자는 그 pane을 다시 포함할 수 있다. 실제 eligible terminal pane이 하나도 없는 경우는 기존 `no_terminal_panes`를 유지한다.
- 제외 목록은 순회 대상을 좁히는 요청 파라미터일 뿐 새 권한이 아니다. endpoint의 bearer token/IP/Origin gate와 active controller lease 요구는 변하지 않는다.

## Alternatives Considered

- **즐겨찾기 allowlist**: 별표가 하나라도 있으면 favorites만 순회하고 없으면 전체로 폴백할 수 있다. 그러나 기본 전체 포함에서 사용자가 표현하려는 것은 “자주 쓰는 것만 고르기”보다 “불필요한 것을 빼기”이며, 별표가 하나도 없는 상태의 의미가 전체 선택이라는 점도 UI와 맞지 않아 채택하지 않았다.
- **PC `PaneControlBar`에서 별표/제외 상태 편집**: 전체 layout을 보며 고를 수 있지만 Remote 전용 기능이 PC에 표시되고 Remote 사용 중 즉시 바꿀 수 없다는 사용자 요구 위반이라 채택하지 않았다.
- **호스트 `paneOverrides` 또는 별도 mutation endpoint에 제외 상태 저장**: Remote 기기 사이에서 같은 목록을 공유할 수 있지만 surface-local 선호가 호스트 UI 상태가 되고 API·수명주기·동시 클라이언트 책임이 늘어난다. 기기 간 동기화 요구가 생기기 전에는 채택하지 않는다.
- **모든 pane 제외 시 전체로 폴백**: Remote 이동이 막히지 않지만 사용자가 명시적으로 제외한 pane을 다시 방문해 denylist 의미를 깨므로 채택하지 않았다.
- **settings.json 또는 workspace layout에 저장**: Remote 브라우저별 탐색 선호를 공유 구성과 레이아웃에 섞고 내보내기 의미까지 넓히므로 채택하지 않았다.

## Consequences

- 기존 Remote 클라이언트와 새 클라이언트의 최초 동작은 모두 모든 eligible pane 순회다. 별도 초기화나 마이그레이션은 없다.
- 제외 설정은 브라우저 origin/profile별로 유지되며 다른 기기와 자동 동기화되지 않는다. pane이 삭제되어 stale ID가 남아도 순회에는 영향이 없고, 별도 호스트 정리 수명주기가 필요하지 않다.
- 공간순회 요청에 현재 denylist가 반복 전송되지만 pane ID 배열 크기만큼의 작은 additive payload이며 서버 영속 상태나 동시성 제어를 만들지 않는다.
- 모든 eligible pane을 제외하면 공간 스텝은 명시적 no-op이 된다. Remote 상단의 현재 pane 토글이나 drawer의 직접 pane 선택으로 복구할 수 있다.
- 테스트는 기본 빈 denylist, 일부/전체 제외, stale ID, bridge 중계, malformed 목록 거절, Remote 상단 토글 표시·영속·요청 반영, PC 컨트롤 부재를 검증한다.
