# 0025. Dev terminal viewport diagnostics

- Status: Accepted
- Date: 2026-07-11
- Source: 사용자 요구(스크롤 렌더링 버그 자율 재현) · ADR-0015 · ADR-0017 · architecture/api-contracts.md §12.7

## Context

터미널 scrollback 렌더링 버그는 출력 생성, pane 폭 변경, viewport 스크롤, 스크린샷 비교를 한 인스턴스에서 반복해야 재현할 수 있다. 기존 laymux-dev MCP는 출력·폭 변경·스크린샷은 제어하지만 xterm viewport를 움직일 수 없었고, 화면 손상이 xterm line model 자체의 문제인지 WebGL paint 문제인지 구분할 수도 없었다. OS 전역 마우스·키보드 주입은 동일한 창 제목을 쓰는 release와 dev 중 잘못된 WebView에 입력될 수 있어 인스턴스 격리를 보장하지 못한다.

ADR-0015에 따라 xterm scroll viewport는 PTY 전역 상태가 아니라 surface-local 상태다. 따라서 검증 도구도 PTY 입력을 합성하지 않고 대상 dev surface의 live xterm만 직접 조작해야 한다.

## Decision

laymux-dev MCP에 `scroll_terminal(terminal_id, lines)`와 `dump_terminal_buffer(terminal_id, limit?)`를 dev 전용 도구로 추가한다.

- `lines < 0`은 scrollback 위로, `lines > 0`은 live bottom 방향으로 이동한다.
- 프론트 bridge가 stable terminal ID로 등록된 live xterm을 찾아 공개 `scrollLines()` API를 호출한다.
- 응답은 `cols`, `rows`, `baseY`, `viewportY`, `isAtBottom`을 반환한다.
- `dump_terminal_buffer`는 같은 live xterm의 현재 `cols`, `rows`, `baseY`와 각 line의 `text`, `isWrapped`를 반환한다. `limit: 0`은 전체 버퍼다.
- PTY에 키나 escape sequence를 쓰지 않고 backend terminal 상태도 변경하지 않는다.
- ADR-0017의 게이트를 적용해 release(`19280`)에서는 목록과 직접 호출 모두 차단하고 dev(`19281`)에서만 노출한다.

## Consequences

- 에이전트가 release 창에 OS 입력을 보낼 필요 없이 width→scroll→screenshot 재현 루프를 닫을 수 있다.
- WebGL screenshot과 xterm line model을 대조해 renderer 잔상과 실제 reflow 손상을 분리할 수 있다.
- viewport는 surface-local 상태로 유지되며 SIGWINCH, PTY 입력, remote controller 소유권과 섞이지 않는다.
- live xterm이 없는 terminal ID는 명시적 오류를 반환한다.
- dev MCP 외부 계약이 두 개 늘어나므로 툴 게이팅, bridge, 문서 테스트를 함께 유지해야 한다.
