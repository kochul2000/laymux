# 0233. Remote 워크스페이스 메뉴는 기기 로컬 너비와 컷오프로 고정한다

- Status: Accepted
- Date: 2026-09-05
- Source: 사용자 요구(고정·너비 조정·컷오프 이하 비고정 폴백) · [architecture/api-contracts.md §10, §13.3](../architecture/api-contracts.md) · [ADR-0015](0015-remote-terminal-state-ownership.md) · [ADR-0209](0209-remote-display-preferences-are-device-local.md)
- Extends: [ADR-0015](0015-remote-terminal-state-ownership.md), [ADR-0209](0209-remote-display-preferences-are-device-local.md)

## Context

Remote 워크스페이스 메뉴는 터미널 위에 잠시 겹치는 drawer 하나만 제공한다. 넓은 모바일 화면과 태블릿에서는 워크스페이스를 계속 보면서 터미널을 조작할 수 있어야 하지만, 좁은 화면에서 같은 배치를 강제하면 터미널 폭을 과도하게 줄인다. 메뉴 너비는 고정 여부와 무관하게 조정할 필요가 있고, 고정 가능 여부를 가르는 화면 너비도 기기마다 다르다.

이 선택은 PC의 workspace나 terminal 상태가 아니라 Remote 문서의 표시 선호다. 따라서 host 설정이나 Remote API를 확장하지 않고 기존 기기 로컬 표시 설정 경계 안에서 결정해야 한다.

## Decision

**Remote 워크스페이스 메뉴는 사용자가 요청한 고정을 viewport 컷오프로 gate하고, 고정·비고정 양쪽에서 하나의 기기 로컬 메뉴 너비를 사용한다.**

- `localStorage["laymux.remote.displaySettings"]`에 `navigationPinned`(기본 `false`), `navigationWidth`(기본 `360`, 범위 `200..=720`px), `navigationPinCutoff`(기본 `720`, 범위 `320..=2560`px)를 저장한다. 잘못된 숫자는 기본값으로 복구하고 범위 밖 숫자는 clamp한다.
- 실효 고정은 `navigationPinned && window.innerWidth > navigationPinCutoff`다. viewport가 컷오프와 같거나 작으면 요청값을 지우지 않고 기존 floating drawer로 폴백한다.
- `navigationWidth`는 floating drawer와 pinned drawer에 함께 적용한다. floating drawer는 기존처럼 화면 오른쪽에 닫기 영역 28px을 남기는 상한을 유지한다.
- 실효 고정 중에는 drawer와 terminal을 같은 행의 두 열로 배치하고 scrim과 메뉴 토글을 숨긴다. 기존 close 요청은 drawer를 닫지 않으며, 고정이 풀리면 기존 open/close drawer 의미로 돌아간다.
- 너비·고정·컷오프 변경과 viewport 폭 변경은 기존 Remote terminal fit 경로를 예약한다. 별도 PTY resize 경로나 host 동기화 상태를 만들지 않는다.
- Direct browser, PWA, Android secure WebView, 데스크톱 내부 `localApp=1`은 같은 Remote 문서와 각 origin/WebView의 저장소를 사용한다.

## Alternatives Considered

- **고정 전용 CSS breakpoint를 둔다.** 구현은 짧지만 사용자가 컷오프를 조정할 수 없고 기기별 가용 폭 차이를 반영하지 못한다.
- **메뉴 너비를 고정 모드에서만 적용한다.** 비고정 drawer의 폭 조정 요구를 충족하지 못하고 같은 메뉴에 두 너비 의미를 만든다.
- **PC `settings.json`에 저장한다.** 여러 Remote 기기의 화면 크기와 선호가 서로 덮어쓰며 ADR-0209의 기기 로컬 소유권을 어긴다.
- **컷오프 이하에서 고정 요청을 삭제한다.** 회전하거나 창을 넓혔을 때 사용자의 선택을 잃으므로, 요청값과 실효 배치를 분리한다.

## Consequences

- 넓은 화면에서는 워크스페이스 메뉴와 터미널을 동시에 볼 수 있고, 좁아지면 같은 설정으로 기존 drawer가 된다.
- 메뉴 폭 변화는 terminal pixel geometry를 바꾸므로 active controller라면 기존 fit/debounced PTY resize가 수행된다.
- 저장값은 origin/WebView별로 독립하며 사이트 데이터를 지우면 기본 비고정 상태로 돌아간다.
- 사용자가 낮은 컷오프나 큰 메뉴 폭을 고르면 terminal 영역이 작아질 수 있다. 입력 범위 clamp 외에 자동 비율 보정은 두지 않으며 실제 사용성 요구가 확인될 때 재검토한다.
