# 0127. terminal startup slot은 준비 완료 전 eligibility를 따라간다

- Status: Accepted
- Date: 2026-08-03
- Source: [issue #753](https://github.com/kochul2000/laymux/issues/753) 재발 분석 · 사용자 재현 조건(워크스페이스가 뜨기 전 진입 후 즉시 다음 워크스페이스로 이동) · [architecture/overview.md §3.2](../architecture/overview.md) · [architecture/data-flow.md §13.5](../architecture/data-flow.md) · [ADR-0043](0043-global-terminal-ready-startup-slot.md)
- Supersedes: ADR-0043의 현재 슬롯 비선점 규칙. 전역 단일 슬롯, PTY 준비+xterm 첫 render 완료 경계, 후보 우선순위와 10초 결함 watchdog은 유지한다.

## Context

ADR-0043은 여러 `TerminalView`의 `terminal.open()`·PTY 생성·canvas 초기화를 직렬화하기 위해 현재 startup slot을 focus나 workspace 전환으로 선점하지 않도록 정했다. 이미 크기가 있는 terminal이 시작 중일 때 순서 변경만으로 작업을 버리지 않는다는 의도였다.

하지만 아직 `terminal.open()` 전인 pane이 slot을 받은 직후 사용자가 다른 workspace로 전환하면 그 pane은 `knownPaneIds`에는 남지만 `eligiblePaneIds`에서는 빠지고 컨테이너가 `display:none`의 0×0이 된다. `TerminalView`는 실제 크기가 생길 때까지 xterm과 PTY 생성을 시작하지 않으므로 PTY 준비와 첫 render를 절대 보고할 수 없다. 기존 조정기는 `known`인 slot owner를 계속 보존해 다음 workspace의 terminal을 10초 watchdog까지 막았다. Remote workspace 전환도 같은 경로를 사용한다.

범위는 아직 준비되지 않은 startup slot의 liveness다. 이미 준비된 terminal의 mount·PTY 보존, background 출력, 일반 focus 우선순위, Automation의 명시적 workspace 활성화 계약은 바꾸지 않는다.

## Decision

**아직 준비되지 않은 startup slot owner는 `known`인 것만으로 충분하지 않고 매 후보 동기화 시점에 `eligible`이기도 해야 하며, eligibility를 잃으면 즉시 slot을 반납한다.**

- 현재 slot은 `knownPaneIds`와 `eligiblePaneIds`에 모두 있고 `readyPaneIds`에는 없을 때만 유지한다.
- workspace 전환, dock 숨김, foreground FileViewer 교체 등으로 owner가 ineligible이 되면 같은 순수 상태 전이에서 owner를 `null`로 만들고 새 eligible 미시작 pane 하나에 slot을 준다.
- 한 번 reveal된 pane은 `known`인 동안 `revealedPaneIds`에 남긴다. slot 반납은 unmount·PTY 종료를 뜻하지 않으며, 늦은 이전 owner의 settle 신호는 현재 owner를 바꾸지 않는다.
- 조정기가 가리키는 slot owner는 계속 하나뿐이다. 이전 owner가 크기 0 때문에 아직 실제 시작하지 못했다는 조건에서 즉시 넘기는 것이 정상 경로다.
- 이미 실제 시작했지만 ready 전에 숨겨지는 극단적 경합에서는 두 초기화가 잠시 겹칠 수 있다. 이는 10초 동안 모든 후속 시작을 막는 것보다 작은 위험이며, 실제 세션 생성 여부를 별도 상태로 추가하지 않는다.

## Alternatives Considered

- **10초 watchdog만 유지한다.** 사용자의 정상적인 빠른 전환을 결함 timeout으로 처리해 새 workspace가 최대 10초 비어 보이고 Remote checkpoint provider도 미부착 상태로 기다리므로 기각했다.
- **`knownPaneIds`에서 비활성 workspace를 제거한다.** 이미 시작된 background terminal의 add-only mount와 세션 보존까지 깨뜨리므로 기각했다.
- **slot owner를 강제로 1×1 크기로 열어 PTY를 시작한다.** 숨은 renderer를 초기화해 원래의 GPU/main-thread 직렬화 목적과 xterm 0×0 방어를 우회하므로 기각했다.
- **실제 `terminal.open()` 진입 여부를 startup store에 추가한다.** 더 세밀하지만 새 교차 모듈 상태와 신호가 필요하다. 현재 재현은 open 전 0×0 경계이며 eligibility 전이만으로 결정적으로 해결할 수 있어 기각했다.

## Consequences

- 앱 시작·세션 복원 중 workspace를 빠르게 넘겨도 새 활성 workspace terminal이 즉시 startup slot을 받는다.
- 이전 workspace를 다시 열면 이미 reveal된 `TerminalView`가 실제 크기를 얻어 기존 mount에서 시작할 수 있다.
- slot owner가 ineligible이 되는 순간에는 아직 ready가 아니므로, 이후 도착한 stale settle은 무시해야 한다.
- 순수 coordinator 테스트와 `AppLayout` 실제 workspace 전환 테스트가 이 계약을 고정한다.
