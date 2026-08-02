# 0122. terminal output server delivery expiry는 frontend watchdog보다 길게 둔다

- Status: Accepted
- Date: 2026-08-02
- Source: 사용자 실기 보고(`ai-inference` background workspace의 `backend receipt timeout`) · dev 8-pane flood 측정(active screenshot 5,078 ms, background parser service gap 5,016–5,266 ms) · [issue #700](https://github.com/kochul2000/laymux/issues/700) · [PR #743](https://github.com/kochul2000/laymux/pull/743) 서브에이전트 리뷰 · [ADR-0095](0095-terminal-output-bounded-envelope-and-frame-continuation.md) · [ADR-0098](0098-terminal-parser-weighted-starvation-free-admission.md) · [ADR-0101](0101-active-workspace-weighted-parser-admission.md)
- Amends: ADR-0095 Decision의 active surface receipt/grant server expiry 5초, ADR-0098 Decision 9·10의 inherited receipt 5초 제약, ADR-0101 Context의 inherited receipt 5초 제약을 30초로 정정한다. frontend command watchdog 5초, emitter 호출·worker shutdown 5초, parsed-progress expiry 5초, bounded repair/identity/fail-stop 계약은 유지한다.

## Context

ADR-0095는 frontend receipt/hold/close command watchdog과 backend receipt/grant expiry를 모두 5초로 정했다. 그러나 두 시간은 다른 실패를 감시한다. frontend watchdog은 이미 시작한 Tauri command Promise가 정착하지 않는지를 감시하고 같은 immutable identity/payload retry와 orphan cap을 구동한다. backend expiry는 아직 receipt되지 않은 frozen envelope 또는 닫히지 않은 continuation grant를 얼마나 오래 보존할지 정한다.

두 경계를 같은 5초로 두면 정상 WebView main-thread stall이 곧 데이터-plane fail-stop이 된다. 2026-08-02 dev 결정적 flood에서 8개 background pane의 parser service gap은 5.016–5.266초였고, 8개 active pane을 포함한 정상 screenshot은 5.078초 동안 main thread를 점유했다. 해당 run은 envelope 시점이 겹치지 않아 fail-stop하지 않았지만, 사용자의 장시간 background workspace에서는 실제 `receipt_timeout`이 발생했다. backend가 envelope를 emit한 직후 main thread가 이 구간에 들어가면 event listener, 1초 pull watchdog, receipt command가 모두 같은 thread에서 멈추므로 기존 5초 안에 진행할 수 없다.

parser class share는 이 실패의 직접 소유자가 아니다. receipt는 xterm parse 완료 전에 logical descriptor가 bounded queue에 수락된 직후 전송되고, hidden share 2는 parsed ACK 처리량만 조절한다. hidden share를 높여도 이미 시작한 하나의 main-thread task를 선점하거나 Tauri receipt를 전달할 수 없다.

범위는 desktop v3 backend의 receipt와 active continuation grant 보존 시간이다. parser share/quantum, frontend command watchdog과 orphan cap, parsed-progress backpressure, Remote/Cloud 출력, 자동 reattach는 비목표다.

## Decision

**desktop v3 backend는 receipt 전 frozen envelope와 active continuation grant를 30초 동안 보존하고, frontend command watchdog·synchronous emitter 호출·delivery worker shutdown·parsed-progress expiry는 5초로 유지한다.**

30초 예산은 lost event가 opener와 closer를 함께 실은 최장 직렬 복구 경로를 합한 값이다.

- 정상 WebView main-thread stall 허용: 5초
- 복귀 뒤 pull watchdog의 최대 poll 간격: 3초
- exact repair invoke attempt: 5초
- 공유 delivery-control FIFO의 `hold → close → receipt`: 호출별 5초, 합계 15초
- host scheduling과 경계 경쟁 margin: 2초

receipt와 grant가 같은 delivery-control FIFO와 identity 계약을 사용하므로 server expiry도 같은 값 하나(`TERMINAL_OUTPUT_SERVER_DELIVERY_EXPIRY_MS`)에서 파생한다. 유효 receipt/close, token retire 또는 expiry가 기존과 같이 waiter를 깨운다. exact repair는 envelope 생성 시 정한 절대 receipt deadline을 갱신하지 않으며 generation-local 회수 횟수도 제한한다. 생성 뒤 30초가 지나면 기존 typed `receipt_timeout`/`continuation_expired` fail-stop과 사용자 close/recreate 계약을 그대로 적용한다.

synchronous event emitter 호출과 delivery worker shutdown은 frozen delivery 보존과 다른 실패 경계다. 각각 별도 5초 상수를 사용하며 server expiry 확대를 상속하지 않는다. 따라서 hung emitter나 terminal retirement의 종료 대기가 30초로 늘어나지 않는다.

frontend가 이미 시작한 command Promise의 5초 watchdog과 terminal-local/WebView-global orphan cap 6은 바꾸지 않는다. bridge가 실제로 죽었으면 5초마다 동일 identity만 재시도하고 orphan cap으로 유한하게 닫힌다. parsed ACK가 hard ceiling에서 전진하지 않는 parser/backpressure 실패도 기존 5초 `parsed_progress_expired`로 별도 감시한다. 즉 server delivery expiry 확대가 parser 정지나 무한 producer 대기를 숨기지 않는다.

## Alternatives Considered

- **5초를 유지하고 parser hidden share를 높인다.** receipt는 parser 완료 전 전송되며 share는 이미 실행 중인 main-thread task를 선점하지 못한다. active workspace 우선순위를 약화하면서 원인을 고치지 않아 기각했다.
- **server expiry를 15초로 둔다.** stall 5초·poll 3초·단일 control 5초·margin 2초만 합하면 충분해 보이지만, lost-event envelope가 opener와 closer를 함께 실으면 repair 뒤 `hold → close → receipt` 세 호출이 공유 FIFO에서 직렬화된다. 실제 최장 경로를 덮지 못하므로 기각했다.
- **모든 screenshot·reflow·parser task를 3초 미만으로 최적화한다.** issue #700과 이번 5.078초 측정처럼 현재 정상 경로가 이미 경계를 넘고, 장치·WebView·pane 수에 따라 단일 보편 상한을 보장할 수 없다. 성능 개선은 계속 필요하지만 transport 보존 안전 여유를 대신할 수 없어 기각했다.
- **frontend health report가 늦으면 backend expiry를 동적으로 연장한다.** delivery worker가 Automation/frontend-vitals 상태와 결합되고, 죽은 WebView와 장기 stall을 구분하는 새 상태 소유권이 생긴다. 고정된 유한 예산보다 복잡하고 expiry를 반복 연장할 위험이 있어 기각했다.
- **timeout 뒤 자동 reset/replay/re-attach한다.** 이미 적용된 byte와 authoritative ring 경계를 추측해 중복 또는 손실을 숨길 수 있어 ADR-0095의 fail-stop 원칙과 충돌한다. 명시적 close/recreate를 유지한다.
- **server expiry를 없앤다.** 죽은 WebView가 PTY read/credit waiter를 영구 정지시키므로 기각했다.

## Consequences

- 5초 안팎의 정상 main-thread stall과 뒤이은 bounded repair/control round가 frozen envelope 또는 grant를 조기 폐기하지 않는다.
- 실제로 죽은 WebView에서 backend fail-stop과 PTY waiter 해제는 기존보다 최대 25초 늦어진다. retained memory 상한과 generation당 unreceipted envelope 하나라는 공간 상한은 그대로다.
- frontend command timeout/orphan 진단과 hung emitter·worker shutdown 판정은 계속 5초부터 발생하므로 bridge/emitter 장애 관측과 terminal retirement가 30초까지 늦어지지 않는다.
- production timeout 배선 테스트는 receipt·continuation 30초와 emitter 호출·worker shutdown 5초를 함께 고정한다. exact repair가 생성 시 receipt deadline을 바꾸지 않는 행동 테스트와 `hold → close → receipt` 순서 테스트도 유지한다. 2/4/7/8-pane flood는 receipt/continuation/repair/fail-stop 0과 frontier 정합을 계속 검증한다.
- 재검토 조건은 WebView transport가 main thread와 독립적인 native receipt를 제공하거나, 정상 UI 작업의 strict upper bound를 플랫폼별로 증명할 수 있는 경우다.
