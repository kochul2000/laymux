# 0122. terminal output server delivery expiry는 frontend watchdog보다 길게 둔다

- Status: Proposed
- Date: 2026-08-02
- Source: 사용자 실기 보고(`ai-inference` background workspace의 `backend receipt timeout`) · dev 8-pane flood 측정(active screenshot 5,078 ms, background parser service gap 5,016–5,266 ms) · [issue #700](https://github.com/kochul2000/laymux/issues/700) · [ADR-0095](0095-terminal-output-bounded-envelope-and-frame-continuation.md) · [ADR-0098](0098-terminal-parser-weighted-starvation-free-admission.md) · [ADR-0101](0101-active-workspace-weighted-parser-admission.md)
- Amends: ADR-0095의 active surface receipt/grant server expiry 5초를 15초로 정정한다. frontend command watchdog 5초, parsed-progress expiry 5초, bounded repair/identity/fail-stop 계약은 유지한다.

## Context

ADR-0095는 frontend receipt/hold/close command watchdog과 backend receipt/grant expiry를 모두 5초로 정했다. 그러나 두 시간은 다른 실패를 감시한다. frontend watchdog은 이미 시작한 Tauri command Promise가 정착하지 않는지를 감시하고 같은 immutable identity/payload retry와 orphan cap을 구동한다. backend expiry는 아직 receipt되지 않은 frozen envelope 또는 닫히지 않은 continuation grant를 얼마나 오래 보존할지 정한다.

두 경계를 같은 5초로 두면 정상 WebView main-thread stall이 곧 데이터-plane fail-stop이 된다. 2026-08-02 dev 결정적 flood에서 8개 background pane의 parser service gap은 5.016–5.266초였고, 8개 active pane을 포함한 정상 screenshot은 5.078초 동안 main thread를 점유했다. 해당 run은 envelope 시점이 겹치지 않아 fail-stop하지 않았지만, 사용자의 장시간 background workspace에서는 실제 `receipt_timeout`이 발생했다. backend가 envelope를 emit한 직후 main thread가 이 구간에 들어가면 event listener, 1초 pull watchdog, receipt command가 모두 같은 thread에서 멈추므로 기존 5초 안에 진행할 수 없다.

parser class share는 이 실패의 직접 소유자가 아니다. receipt는 xterm parse 완료 전에 logical descriptor가 bounded queue에 수락된 직후 전송되고, hidden share 2는 parsed ACK 처리량만 조절한다. hidden share를 높여도 이미 시작한 하나의 main-thread task를 선점하거나 Tauri receipt를 전달할 수 없다.

범위는 desktop v3 backend의 receipt와 active continuation grant 보존 시간이다. parser share/quantum, frontend command watchdog과 orphan cap, parsed-progress backpressure, Remote/Cloud 출력, 자동 reattach는 비목표다.

## Decision

**desktop v3 backend는 receipt 전 frozen envelope와 active continuation grant를 15초 동안 보존하고, frontend command watchdog과 parsed-progress expiry는 5초로 유지한다.**

15초 예산은 다음 유한 경로를 합한 값이다.

- 정상 WebView main-thread stall 허용: 5초
- 복귀 뒤 pull watchdog의 최대 poll 간격: 3초
- exact event/receipt 또는 hold/close control attempt: 5초
- host scheduling과 경계 경쟁 margin: 2초

receipt와 grant가 같은 delivery-control FIFO와 identity 계약을 사용하므로 server expiry도 같은 값 하나(`TERMINAL_OUTPUT_SERVER_DELIVERY_EXPIRY_MS`)에서 파생한다. 유효 receipt/close, token retire 또는 expiry가 기존과 같이 waiter를 깨운다. exact repair의 generation-local 회수 상한은 expiry를 무한 연장할 수 없으며, 15초가 지나면 기존 typed `receipt_timeout`/`continuation_expired` fail-stop과 사용자 close/recreate 계약을 그대로 적용한다.

frontend가 이미 시작한 command Promise의 5초 watchdog과 terminal-local/WebView-global orphan cap 6은 바꾸지 않는다. bridge가 실제로 죽었으면 5초마다 동일 identity만 재시도하고 orphan cap으로 유한하게 닫힌다. parsed ACK가 hard ceiling에서 전진하지 않는 parser/backpressure 실패도 기존 5초 `parsed_progress_expired`로 별도 감시한다. 즉 server delivery expiry 확대가 parser 정지나 무한 producer 대기를 숨기지 않는다.

## Alternatives Considered

- **5초를 유지하고 parser hidden share를 높인다.** receipt는 parser 완료 전 전송되며 share는 이미 실행 중인 main-thread task를 선점하지 못한다. active workspace 우선순위를 약화하면서 원인을 고치지 않아 기각했다.
- **모든 screenshot·reflow·parser task를 3초 미만으로 최적화한다.** issue #700과 이번 5.078초 측정처럼 현재 정상 경로가 이미 경계를 넘고, 장치·WebView·pane 수에 따라 단일 보편 상한을 보장할 수 없다. 성능 개선은 계속 필요하지만 transport 보존 안전 여유를 대신할 수 없어 기각했다.
- **frontend health report가 늦으면 backend expiry를 동적으로 연장한다.** delivery worker가 Automation/frontend-vitals 상태와 결합되고, 죽은 WebView와 장기 stall을 구분하는 새 상태 소유권이 생긴다. 고정된 유한 예산보다 복잡하고 expiry를 반복 연장할 위험이 있어 기각했다.
- **timeout 뒤 자동 reset/replay/re-attach한다.** 이미 적용된 byte와 authoritative ring 경계를 추측해 중복 또는 손실을 숨길 수 있어 ADR-0095의 fail-stop 원칙과 충돌한다. 명시적 close/recreate를 유지한다.
- **server expiry를 없앤다.** 죽은 WebView가 PTY read/credit waiter를 영구 정지시키므로 기각했다.

## Consequences

- 5초 안팎의 정상 main-thread stall과 뒤이은 bounded repair/control round가 frozen envelope 또는 grant를 조기 폐기하지 않는다.
- 실제로 죽은 WebView에서 backend fail-stop과 PTY waiter 해제는 최대 10초 늦어진다. retained memory 상한과 generation당 unreceipted envelope 하나라는 공간 상한은 그대로다.
- frontend command timeout/orphan 진단은 계속 5초부터 발생하므로 bridge 장애 관측이 15초까지 늦어지지 않는다.
- production timeout 배선 테스트는 receipt와 continuation이 모두 15초인지 고정한다. 2/4/7/8-pane flood는 receipt/continuation/repair/fail-stop 0과 frontier 정합을 계속 검증한다.
- 재검토 조건은 WebView transport가 main thread와 독립적인 native receipt를 제공하거나, 정상 UI 작업의 strict upper bound를 플랫폼별로 증명할 수 있는 경우다.
