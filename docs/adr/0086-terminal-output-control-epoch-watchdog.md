# 0086. terminal output control IPC는 epoch watchdog으로 stale lease를 교체한다

- Status: Proposed
- Date: 2026-07-29
- Source: issue #629 · [architecture/data-flow.md §8.8](../architecture/data-flow.md) · [architecture/api-contracts.md §13.4](../architecture/api-contracts.md) · [ADR-0084](0084-desktop-terminal-output-parsed-credit.md)
- Extends: [ADR-0084](0084-desktop-terminal-output-parsed-credit.md)의 desktop attach·ACK control-plane liveness 경계

## Context

ADR-0084는 desktop PTY producer를 generation-local parsed-credit lease로 제한한다. 이 구조에서 `attach_terminal_output`이 새 token을 반환하지 못하거나 `acknowledge_terminal_output`의 단일 in-flight Promise가 정착하지 않으면, frontend가 parse를 계속해도 backend credit은 전진하지 않는다. WebView 자체가 회복한 뒤에도 control bridge의 고아 Promise 하나만 남아 있으면 producer는 window에서 영구 정지한다.

기존 reject 경로는 attach 재부착 또는 동일 token/sequence ACK 재시도를 수행하지만, 영구 pending은 resolve도 reject도 하지 않아 그 경로에 들어가지 않는다. timeout 뒤 원 Promise를 취소할 Tauri 계약도 없다. 따라서 늦은 완료를 흡수하면서 현재 surface만 새 lease로 교체해야 하고, bridge가 계속 죽어 있을 때 timeout마다 취소 불가능한 Promise를 영원히 추가하지 않는 상한도 필요하다.

범위는 desktop Tauri surface의 attach·ACK IPC와 frontend epoch/token 소유권이다. backend wire payload, Remote/Cloud subscriber, exact repair, WebView process 자체의 재시작 정책은 바꾸지 않는다.

## Decision

**desktop surface는 attach와 token-scoped ACK control IPC를 5초 epoch watchdog으로 감시하고, timeout이면 현재 epoch를 먼저 폐기한 뒤 유한한 replacement만 허용한다.**

- `TerminalView`의 mount-local `outputAttachEpoch`가 단 하나의 current epoch 진실원이다. attach 시작, 재부착, unmount는 이 값을 전진시키며, 모든 async continuation은 캡처한 epoch가 현재인지 확인한 뒤에만 lease·parser·readiness를 변경한다.
- `attach_terminal_output` Promise는 fulfillment와 rejection handler를 먼저 연결한 뒤 5초 timer와 경쟁한다. timeout outcome은 원 Promise의 값이나 오류를 노출하지 않는다. 늦은 resolve/reject는 연결된 handler가 흡수하고 이미 교체된 epoch에는 아무 작업도 하지 않는다.
- `TerminalOutputFlowAcknowledger` 하나는 attach token 하나와 단일 in-flight ACK만 소유한다. 각 ACK에 5초 timer를 두며 timeout이면 sender와 timer를 먼저 폐기한 뒤 current epoch에만 replacement를 요청한다. 늦은 `true`/`false`/reject는 confirmed prefix, retry timer, 새 token을 움직이지 않는다.
- timeout replacement는 attach와 ACK 종류별 연속 streak를 가진다. 50 ms부터 지수 backoff하고 1,000 ms를 넘지 않는다. 성공한 attach fulfillment만 attach streak를, backend가 `true`로 수락한 ACK만 ACK streak를 0으로 만든다. 중간의 replacement attach 성공은 ACK streak를 지우지 않는다.
- 취소할 수 없는 orphan을 유한하게 유지하기 위해 종류별로 초기 요청 하나와 replacement 다섯 개, 합계 6개의 unsettled operation까지만 허용한다. 여섯 번째 timeout 뒤에는 current epoch를 폐기하고 readiness를 닫되 새 control Promise를 만들지 않는다. backend producer는 마지막 lease의 bounded credit에서 fail-stop하며 pane remount가 새 mount/epoch를 시작한다.
- 정상 reject 의미는 유지한다. attach reject는 기존 즉시 재부착 경로를 사용한다. ACK Promise reject는 같은 token/sequence를 기존 50 ms 간격으로 재시도하며, backend `false`는 stale lease로 보고 재시도 없이 즉시 재부착한다. settled reject는 orphan을 남기지 않으므로 timeout streak나 6개 상한에 포함하지 않는다.
- recovery state 변경은 warning/counter보다 먼저 확정한다. `console.warn` 또는 diagnostic counter가 throw해도 epoch 폐기·replacement/fail-stop 결정을 되돌리거나 막지 않는다. session-scoped recovery counter는 attach와 ACK timeout을 `attachTimeout`, `ackTimeout`으로 각각 센다.
- unmount는 sender/timer를 폐기하고 epoch를 전진시킨다. 그 뒤 도착한 attach/ACK orphan completion은 no-op이다.

## Alternatives Considered

- **timeout 없이 Promise 정착을 기다린다.** WebView가 회복해도 고아 control Promise 하나가 parsed credit을 영구 정지시키므로 기각했다.
- **timeout마다 무제한 재부착한다.** 일시적인 고아는 복구하지만 bridge가 계속 죽으면 취소할 수 없는 Promise와 handler가 시간에 비례해 늘어나므로 기각했다.
- **ACK만 감시하고 initial attach는 기다린다.** bootstrap lease가 attach 전부터 producer를 제한하므로 첫 attach pending도 동일한 liveness 결함이다.
- **generation만 비교하고 token/epoch를 생략한다.** 같은 generation 안의 replacement attach도 token을 교체하므로 old ACK가 새 lease를 전진시키는 경합을 막지 못한다.
- **backend나 Tauri bridge에 cancel API를 추가한다.** 더 강한 자원 회수가 가능하지만 새 IPC/cancellation 계약과 backend 작업 소유권을 요구한다. 이번 범위는 기존 Promise를 안전하게 고아 처리하고 frontend 메모리를 유한하게 유지하는 것으로 한정한다.
- **timeout 즉시 WebView나 앱을 재시작한다.** 사용자의 다른 pane 상태까지 잃는 과도한 복구이고 process lifecycle 정책을 새로 요구하므로 비목표로 둔다.

## Consequences

- 한 번 고아가 된 attach/ACK 뒤 control bridge가 다시 응답하면 새 epoch/token으로 출력이 진행된다. old completion은 새 prefix나 화면을 바꾸지 않는다.
- control bridge가 계속 응답하지 않아도 backend output과 frontend pending delta는 ADR-0084 window/ring 경계 안에서 멈추고, mount당 취소 불가능한 attach·ACK operation도 종류별 최대 6개다.
- 여섯 번째 연속 timeout 뒤에는 자동 회복보다 유한 자원을 우선해 pane output이 fail-stop한다. 사용자는 pane remount로 새 시도를 시작할 수 있다. 실측에서 이 상한 도달이 반복되면 cancellable bridge 또는 surface lifecycle 재시작을 별도 결정한다.
- 두 timeout counter와 warning은 운영 진단용이며 delivery 결정을 소유하지 않는다. sabotage 회귀 테스트가 recovery-before-diagnostics 순서를 고정한다.
- 화면 셀 의미나 terminal byte 변환은 바뀌지 않으므로 별도 xterm screen test는 필요하지 않다. fake-timer helper/component 테스트가 pending, replacement, stale completion, unmount, retry 상한을 검증한다.
