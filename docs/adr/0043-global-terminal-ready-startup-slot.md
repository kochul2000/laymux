# 0043. 터미널 시작은 앱 전역 준비 완료 슬롯으로 직렬화한다

- Status: Accepted
- Date: 2026-07-20
- Source: 사용자 재발 보고(여러 pane 동시 시작 시 흰 화면); PR #453; [architecture/overview.md §3.2](../architecture/overview.md); [architecture/data-flow.md §13.5](../architecture/data-flow.md)

## Context

PR #453은 많은 pane을 한 React commit에서 마운트할 때 생기는 흰 화면을 줄이기 위해 `PaneGrid`별 reveal queue를 추가했다. 그러나 pane 수가 4개 이하이면 전부 동기 reveal했고, 그보다 많아도 첫 4개를 동시에 시작한 뒤 나머지를 animation frame마다 하나씩 마운트했다. 이 간격은 `terminal.open()`·PTY 생성·첫 xterm paint 중 어느 것도 완료됐다는 뜻이 아니므로 느린 환경에서는 다음 terminal 시작과 계속 겹친다. 또한 workspace와 각 dock의 queue가 서로 독립이어서 여러 surface가 동시에 terminal을 시작할 수 있었다.

흰 화면은 애니메이션 속도의 문제가 아니라 무거운 terminal 초기화의 동시성 문제다. 시작 허가, 대기 우선순위, 완료 경계를 앱 전체에서 한 곳이 소유해야 한다. 동시에 Automation은 아직 PTY가 없는 deterministic terminal id를 깨워 write/focus할 수 있어야 하되, 이 경로가 안전 경계를 우회해서는 안 된다.

이번 결정의 범위는 frontend `TerminalView`의 최초 마운트와 PTY/xterm 준비 단계다. 이미 준비된 terminal의 출력 처리·reflow·cursor 계층, backend PTY 내부 구조, WebGL 구현 방식은 바꾸지 않는다.

## Decision

**laymux는 앱 전체에서 terminal 시작 슬롯을 하나만 허용하고, 현재 terminal의 PTY 세션과 첫 xterm render가 모두 준비된 뒤 다음 terminal을 시작한다.**

- frontend `terminal-startup-store`가 알려진 terminal pane, 현재 시작 가능한 후보 순서, reveal 완료 집합, 현재 슬롯 소유 pane을 단일 진실원으로 가진다. 후보 수집과 상태 전이는 순수 함수로 분리한다.
- `AppLayout`에서 조정기를 한 번만 구동해 활성 workspace, visible dock, terminal-backed FileViewer overlay를 함께 계산한다. 비활성 workspace와 hidden dock에는 새 슬롯을 주지 않는다. 기존 lazy mount와 dock persist 정책으로 이미 마운트된 terminal은 유지한다.
- 대기 우선순위는 Automation 요청, 현재 전경 FileViewer terminal, 현재 focused pane terminal, 활성 workspace의 pane 배열 순서, visible dock 배열 순서다. 현재 슬롯은 후보 우선순위나 focus가 바뀌어도 선점하지 않는다.
- 슬롯을 받은 terminal pane만 `ViewRenderer`를 마운트하고 terminal-backed FileViewer도 같은 reveal 집합을 통과한 뒤 `TerminalView`를 마운트한다. 나머지는 어두운 `PaneLoadingPlaceholder`를 표시한다. non-terminal view는 이 슬롯을 소비하지 않고 즉시 마운트한다.
- `TerminalView`는 backend `createTerminalSession` 성공과 xterm 첫 `onRender`를 별도 원시 신호로 기록하고 둘 다 충족됐을 때만 슬롯 완료를 보고한다. 생성 실패는 슬롯을 즉시 반납한다.
- 한 신호가 영구히 오지 않아 전체 대기열이 멈추는 것을 막기 위해 슬롯마다 10초 watchdog을 둔다. watchdog 이후 늦게 도착한 이전 소유자의 완료 신호는 현재 슬롯을 반납할 수 없다.
- `prefers-reduced-motion`은 placeholder spinner 애니메이션만 중단한다. 시작 직렬화는 시각 효과가 아니라 리소스 안전 불변식이므로 우회하지 않는다.
- Automation reveal 요청은 대상의 대기 우선순위만 높인다. 진행 중 슬롯을 선점하거나 추가 슬롯을 만들지 않는다. 비활성 workspace 대상은 기존처럼 임시 활성화하고, PTY 세션 준비 대기 상한은 선행 슬롯 watchdog을 포함할 수 있도록 20초로 둔다.
- 기존 앱 전역 WebGL 예약 간격 150ms는 유지한다. 시작 슬롯은 terminal 전체 준비의 동시성을, WebGL 예약기는 GPU context 생성 간격을 책임지는 독립된 방어선이다.

## Alternatives Considered

- **기존 animation-frame reveal의 batch와 간격만 조정**: 환경별 PTY·renderer 준비 시간과 무관한 추측값이라 재발을 막는 불변식이 되지 않는다. pane 4개 이하 bypass와 surface별 동시성도 남는다.
- **`PaneGrid`마다 준비 완료 기반 슬롯 하나**: 한 workspace 내부는 직렬화하지만 visible dock과 workspace가 동시에 시작하는 문제를 해결하지 못한다.
- **PTY 생성 성공만 완료 경계로 사용**: backend 세션은 준비됐어도 `terminal.open()`과 첫 canvas paint가 끝나지 않았을 수 있어 renderer 부하가 다시 겹친다.
- **첫 PTY 출력까지 대기**: shell/profile에 따라 초기 출력이 없을 수 있어 정상 terminal도 queue를 영구 차단한다. 첫 xterm render는 출력 유무와 독립적인 frontend 준비 경계다.
- **backend에서 전역 PTY 생성을 직렬화**: PTY 생성만 제어하고 xterm/canvas 준비 상태를 알 수 없다. UI surface 후보와 focus/Automation 우선순위도 frontend가 이미 소유한다.
- **Automation 요청은 즉시 별도 슬롯 부여**: 응답은 빨라지지만 자동화가 실행되는 순간 바로 동시 시작 불변식을 깨므로 채택하지 않는다.

## Consequences

- terminal pane 수가 2~4개인 일반 레이아웃, workspace+dock 조합, 시작 중 열린 terminal-backed FileViewer도 실제 준비 완료를 기준으로 직렬화되어 PR #453의 bypass가 사라진다.
- 첫 terminal은 즉시 보이고 나머지는 어두운 spinner를 유지하므로 전체 terminal이 준비되는 시간은 늘 수 있지만 UI main thread와 GPU의 순간 부하는 낮아진다.
- 이미 reveal된 terminal은 focus나 workspace 전환 때문에 다시 언마운트되지 않는다. 큐는 최초 시작만 제어한다.
- 10초 watchdog이 발동한 결함 상황에서는 liveness를 위해 일시적으로 둘 이상의 초기화가 겹칠 수 있다. 경고 로그를 남기며, 이는 정상 경로가 아닌 명시적 실패 완화다.
- Automation은 진행 중 terminal 하나를 기다릴 수 있어 기존 4초보다 응답이 늦어질 수 있다. 20초 상한 안에서 우선순위와 세션 준비 계약을 유지하며, 상한을 넘으면 기존처럼 명시적 timeout 오류를 반환한다.
- 단위 테스트는 전역 단일 슬롯, 완료 전 진행 금지, workspace/dock/FileViewer 후보와 우선순위, 제거·eviction 정리, PTY 실패를 검증한다. `TerminalView` 통합 테스트는 PTY 성공과 첫 render 두 신호가 모두 있어야 다음 슬롯이 열린다는 것을 검증한다.
- 향후 startup 동시성을 1보다 크게 완화하려면 실제 성능 측정과 실패 재현 자료를 근거로 이 ADR의 안전 불변식을 새 ADR에서 재검토해야 한다.
