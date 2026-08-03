# 0128. Remote control 상태 감시는 desktop window 전역 coordinator 하나가 소유한다

- Status: Accepted
- Date: 2026-08-03
- Source: [issue #753](https://github.com/kochul2000/laymux/issues/753) 재발 분석 · Remote 연결 직후 `repair:timeout` 관측 · [architecture/api-contracts.md §Direct Remote Mode 설정](../architecture/api-contracts.md) · [architecture/data-flow.md §8.8](../architecture/data-flow.md) · [ADR-0015](0015-remote-terminal-state-ownership.md)
- Extends: ADR-0015의 controller owner 상태를 desktop UI에 배포하는 frontend 소유권과 fail-closed 규칙을 구체화한다.

## Context

각 `TerminalView`와 `RemoteControlOverlay`가 각각 `remote-control-changed` listener, 초기 `get_remote_control_status` snapshot, Remote 활성 중 3초 polling을 소유했다. 한 번 방문한 workspace는 `display:none`으로 계속 마운트되므로 Remote가 control lease를 얻는 순간 보이는 pane과 숨은 pane 모두 같은 tick에 polling을 시작했다. 터미널 수를 N이라 하면 동일한 Tauri IPC가 약 N건/3초로 늘고, 각 pane의 1초 terminal-output repair watchdog과 함께 WebView/IPC dispatcher를 경쟁했다.

owner 상태는 앱 전체에서 하나인데 pane마다 독립 조회하는 것은 상태 소유권과 비용이 맞지 않는다. 다만 listener 설치 전 Local snapshot을 적용하면 그 사이 Remote owner 이벤트를 놓쳐 human input을 잘못 허용할 수 있고, 느린 snapshot이 더 최신 이벤트를 덮어써서도 안 된다. Remote→Local 전환은 각 terminal의 renderer/PTY geometry 재동기화를 깨우므로 React가 연속 이벤트를 한 render로 batch해도 전환 사실을 보존해야 한다.

범위는 desktop WebView의 Remote owner 상태 배포다. Rust owner gate, lease·heartbeat 정책, Remote browser polling, PTY write/resize 권한은 바꾸지 않는다.

## Decision

**desktop window의 Remote control listener·snapshot·fallback polling은 모듈 전역 coordinator 하나가 소유하고, 모든 React surface는 그 immutable snapshot을 `useSyncExternalStore`로 구독한다.**

- coordinator는 첫 구독자에서 시작하고 마지막 구독자가 사라지면 listener와 timer를 정리한다. 구독자 수와 무관하게 Tauri listener, initial snapshot, polling timer는 각각 최대 하나다.
- listener 설치가 완료된 뒤에만 initial snapshot을 요청한다. 그 전이나 listener 설치 실패·초기 snapshot 실패 상태는 `null`이며 모든 Local human input과 PTY resize를 fail-closed한다.
- event revision과 query epoch로 listener 이벤트 뒤에 도착한 stale snapshot을 버린다.
- Remote가 active일 때만 3초 fallback poll을 두고, 다음 poll은 이전 조회가 끝난 뒤 예약한다. 한 조회가 pending인 동안 다른 조회를 만들지 않는다. unknown 초기 조회 실패와 listener 설치 실패도 각각 단일 timer로 retry한다.
- snapshot은 typed `RemoteControlStatus | null`과 `releaseRevision`을 가진다. Remote→Local을 관측할 때 revision을 올려 React가 active→inactive 이벤트를 한 commit으로 batch해도 각 `TerminalView`가 복귀 reflow와 protected backend resize를 한 번 수행할 수 있게 한다.
- `TerminalView`와 `RemoteControlOverlay`는 Tauri listener나 poll을 직접 만들지 않는다. reclaim command 응답은 coordinator에 즉시 게시하며 같은 owner event가 뒤따라도 값 비교로 불필요한 render를 만들지 않는다.

## Alternatives Considered

- **TerminalView별 polling을 유지하고 hidden pane만 중단한다.** visible pane 수만큼 IPC가 남고 visibility 판정과 lease 상태 소유권이 결합되므로 기각했다.
- **event만 사용하고 polling을 제거한다.** listener 전달 실패나 lease expiry 이벤트 누락 때 Local 제어가 영구 잠길 수 있어 bounded fallback을 유지한다.
- **React Context provider가 상태와 effect를 소유한다.** 가능하지만 provider 밖의 명령 응답 게시와 테스트 reset이 복잡하고, 이 상태는 DOM 계층이 아니라 Tauri 외부 상태이므로 `useSyncExternalStore` 기반 모듈 coordinator를 선택했다.
- **Zustand store와 별도 App hook으로 나눈다.** raw state와 lifecycle owner가 두 모듈로 갈라지고 hook 누락 시 감시가 시작되지 않는다. 작은 외부 store 하나가 둘을 함께 소유하는 편이 불변식이 단순해 기각했다.

## Consequences

- 방문 workspace·mount된 terminal 수가 늘어도 Remote status IPC는 initial 1건과 active 중 최대 1건/3초로 고정된다.
- 각 terminal은 snapshot render를 구독하지만 IPC callback과 timer를 만들지 않는다.
- unknown 상태는 overlay가 보이지 않더라도 terminal input을 막으므로 일시적인 IPC 오류가 Local 권한으로 오인되지 않는다.
- coordinator 단위 테스트가 listener-first, 다중 구독 단일화, stale snapshot 폐기, sequential poll, batched release revision을 검증하고 TerminalView 테스트가 Remote 복귀 reflow를 계속 검증한다.
