# 0161. 터미널 세션 시작과 DOM 렌더러 시작을 분리한다

- Status: Proposed
- Date: 2026-08-16
- Source: 사용자 RDP 최소 폭 재현 요구, `docs/architecture/overview.md` §3.2, `docs/architecture/data-flow.md` §8·§13.5, [ADR-0043](0043-global-terminal-ready-startup-slot.md), [ADR-0127](0127-terminal-startup-slot-follows-eligibility.md), [ADR-0138](0138-remote-opens-queued-panes-on-entry.md)

## Context

Windows RDP로 laymux를 시작할 때 창 폭이 작으면 레이아웃 계산 중 terminal host의 한 축이 0이 될 수 있다. 기존 `TerminalView`는 `ResizeObserver`가 양의 폭과 높이를 보고한 뒤에야 `terminal.open()`뿐 아니라 PTY 생성, 출력 attach, serializer와 Automation inspector 등록까지 모두 실행했다. 따라서 화면 공간이 없는 것은 일시적인 렌더링 제약인데도 terminal session 자체가 존재하지 않았고, Remote의 cold pane 진입도 준비되지 않은 세션을 기다리다 실패했다.

xterm의 parser·buffer·serializer와 laymux의 rendererless checkpoint model은 DOM renderer 없이 동작한다. 반면 `terminal.open()`, fit, WebGL atlas는 실제 양의 크기가 필요하다. 시작 조정기의 전역 슬롯은 여러 canvas 초기화를 직렬화하고 첫 화면의 흰색 노출을 막는 책임이 있으므로 이 결정에서 없애거나 PTY 성공만으로 완료시키지 않는다.

범위는 desktop `TerminalView`의 최초 시작 순서와 Remote/Automation에서 관찰 가능한 세션 준비 상태다. 기존 reflow, hidden terminal 회수, PTY geometry cutover 정책은 변경하지 않는다.

## Decision

`TerminalView`가 시작 슬롯을 받아 마운트되면 terminal host 크기와 무관하게 rendererless terminal 기능과 PTY session을 시작하고, DOM renderer만 양의 크기가 관측될 때 시작한다.

- xterm Unicode provider, `SerializeAddon`, buffer inspector/scroller, output listener와 rendererless checkpoint를 `terminal.open()` 전에 준비한다.
- PTY는 xterm의 초기 기본 grid(`80×24`)로 즉시 생성한다. output attach와 cache/snapshot replay도 세션 성공 뒤 즉시 시작해, 0폭 동안의 출력이 parser·buffer·checkpoint에 보존되게 한다.
- `terminal.open()`, fit, WebGL addon과 focus는 `ResizeObserver`가 `width > 0 && height > 0`을 처음 보고할 때 정확히 한 번 실행한다. 0축 크기에서는 renderer나 PTY resize를 시도하지 않는다.
- Remote와 Automation의 session-ready 의미는 DOM canvas 존재가 아니라 PTY 및 rendererless output surface가 사용 가능하다는 뜻이다. 따라서 0폭 desktop pane도 Remote attach 대상이 된다.
- 전역 시작 슬롯의 완료 경계는 기존대로 PTY 생성 성공과 첫 xterm `onRender`의 결합이다. 크기가 계속 0이면 기존 10초 watchdog이 다음 후보의 liveness를 보장한다. PTY 성공만으로 슬롯을 넘겨 여러 canvas가 나중에 동시에 열리게 하지 않는다.

## Alternatives Considered

- **CSS로 최소 폭만 강제한다.** 일반 flex 축소 문제에는 도움이 되지만 RDP 창 자체와 다단 레이아웃이 실제 가용 폭을 0으로 만들 수 있어 session liveness를 보장하지 못한다.
- **0 크기에서도 `terminal.open()`을 호출한다.** xterm viewport/canvas가 0 크기로 초기화되어 첫 행 손상과 atlas 문제를 다시 만들 수 있어 시각 자원 gate를 제거하지 않는다.
- **양의 크기까지 현재처럼 모든 시작을 미룬다.** 일시적인 시각 제약이 PTY와 Remote attach의 생명주기를 막는 직접 원인이므로 기각한다.
- **PTY 성공만으로 전역 시작 슬롯을 완료한다.** 0폭 pane 여러 개가 watchdog 없이 진행되는 대신, 창이 넓어질 때 canvas/WebGL 초기화가 한꺼번에 몰려 ADR-0043의 부하 직렬화 목적을 훼손한다.

## Consequences

RDP 최소 폭과 초기 flex 계산 중에도 shell과 출력 ring/rendererless checkpoint가 살아 있어 desktop 화면이 나중에 넓어지거나 Remote가 먼저 붙을 수 있다. 양의 크기가 생기면 같은 xterm instance를 열므로 0폭 동안 파싱한 buffer를 잃거나 PTY를 중복 생성하지 않는다.

세션 준비와 렌더러 준비가 서로 다른 시점이 되므로 렌더러 동작을 검증하는 테스트는 session 생성 호출이 아니라 `terminal.open()` 완료를 명시적으로 기다려야 한다. 크기가 영구히 0인 현재 slot owner는 PTY를 소유한 채 최대 10초 동안 다음 시작을 막을 수 있는데, 이는 기존 watchdog 상한 안에서 canvas 직렬화를 보존하기 위해 수용한다. 향후 xterm이 pre-open parser/serialization을 지원하지 않게 바뀌면 pinned bundle의 rendererless screen test와 이 시작 계약을 함께 재검토한다.
