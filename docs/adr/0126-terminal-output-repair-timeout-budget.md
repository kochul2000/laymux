# 0126. terminal output repair watchdog를 15초로 분리하고 server expiry를 40초로 둔다

- Status: Accepted
- Date: 2026-08-03
- Source: [issue #753](https://github.com/kochul2000/laymux/issues/753) 재발 보고 · 사용자 요구(우선 timeout 연장 및 두 시간값의 선언 상수 분리) · [architecture/data-flow.md §8.8](../architecture/data-flow.md) · [architecture/api-contracts.md §13](../architecture/api-contracts.md) · [ADR-0122](0122-terminal-output-server-delivery-expiry.md)
- Supersedes: ADR-0122의 5초 exact repair invoke 및 30초 server delivery expiry 예산. frontend control watchdog, bounded repair/identity/fail-stop 원칙은 유지한다.

## Context

ADR-0122는 정상 WebView main-thread stall을 terminal output data-plane 실패로 오판하지 않도록 backend receipt와 continuation grant의 보존 시간을 30초로 늘렸다. 그러나 production v3 exact repair invoke는 receipt·hold·close와 같은 5초 frontend control watchdog을 공유했다. issue #753에서 `repair:timeout` fail-stop이 다시 관측됐고, Remote 연결 직후 또는 workspace 복원·빠른 전환과의 상관관계가 보고됐다.

현재 관측만으로 Remote나 workspace 전환을 근본 원인으로 확정할 수는 없다. 다만 두 경로 모두 WebView main thread와 IPC 응답을 지연시킬 수 있고, `repair:timeout`은 backend가 frozen envelope를 잃었다는 뜻이 아니라 repair command Promise가 frontend 시간 안에 정산되지 않았다는 뜻이다. 따라서 정확성 계약을 바꾸지 않고 repair round-trip에만 더 긴 유예를 주는 완화가 필요하다.

repair timeout을 늘리면 최장 직렬 복구 경로도 10초 늘어난다. backend가 기존 30초에 envelope나 grant를 만료시키면 frontend repair가 살아 있는 동안 authoritative frozen state가 먼저 사라질 수 있으므로 server expiry 예산도 함께 다시 계산해야 한다. 범위는 desktop terminal-output v3와 staged v2 repair의 invoke watchdog 및 backend delivery 보존 시간이다. 자동 reset·replay·reattach, Remote/Cloud output 계약, 원인 확정은 비목표다.

## Decision

**frontend terminal-output repair invoke watchdog은 독립된 15초 상수로 두고, backend receipt·continuation grant server expiry는 독립된 40초 상수로 둔다.**

- receipt·hold·close와 continuation control의 frontend watchdog은 5초를 유지한다. repair transport만 15초 상수를 사용하며 일반 control timeout을 상속하지 않는다.
- backend receipt와 active continuation grant는 생성 시점부터 40초 동안 보존한다. exact repair는 이 절대 deadline을 갱신하지 않는다.
- 40초 예산은 WebView stall 5초 + repair poll 최대 3초 + repair invoke 15초 + 공유 delivery-control FIFO의 `hold → close → receipt` 15초 + scheduling margin 2초를 모두 덮는다.
- synchronous emitter call, delivery worker shutdown, parsed-progress expiry는 각각 5초를 유지한다.
- 15초와 40초는 각 소유 계층에서 의미가 드러나는 named declaration constant로 관리한다. 호출부에 숫자 literal을 중복하지 않는다.
- 15초 또는 40초가 끝나면 기존 typed fail-stop과 사용자 명시적 fresh-terminal restart 계약을 그대로 적용한다. timeout 연장은 자동 복구나 원인 해결로 간주하지 않는다.

## Alternatives Considered

- **모든 frontend control watchdog을 15초로 늘린다.** receipt·hold·close의 죽은 IPC 판정과 orphan 회수가 불필요하게 10초 늦어지고 공유 FIFO 정체가 커진다. 재발한 typed reason은 repair 경계이므로 기각한다.
- **repair만 15초로 늘리고 backend expiry는 30초로 유지한다.** 최장 직렬 복구 경로에서 backend가 frozen envelope/grant를 먼저 폐기할 수 있어 frontend 유예가 실효성을 잃으므로 기각한다.
- **server expiry만 늘린다.** `repair:timeout`은 frontend watchdog이 먼저 내리는 판정이므로 직접 완화하지 못해 기각한다.
- **timeout을 없애거나 매우 크게 둔다.** 죽은 WebView/IPC가 PTY delivery와 retained memory를 장기간 붙들 수 있어 bounded liveness와 fail-stop 원칙을 훼손하므로 기각한다.
- **timeout 때 자동 reset·reattach한다.** authoritative prefix의 중복·손실 여부를 증명하지 못한 채 화면을 재구성해 ADR-0095의 fail-stop 원칙과 충돌하므로 기각한다.

## Consequences

- 일시적인 WebView/IPC 지연이 5초를 넘더라도 15초 안에 repair가 정산되면 불필요한 `repair:timeout` fail-stop을 피한다.
- 실제로 죽은 repair IPC의 fail-stop 표시는 기존보다 최대 10초 늦어진다. backend frozen envelope와 grant도 기존보다 최대 10초 더 유지된다.
- receipt·hold·close, emitter, worker shutdown, parsed-progress의 장애 감지는 계속 5초이므로 repair 완화가 다른 control failure domain으로 번지지 않는다.
- 독립 timeout 적용 테스트와 production backend timeout 배선 테스트가 15초/40초 계약 및 5초 control 분리를 고정한다.
- issue #753의 근본 원인은 별도 측정으로 추적한다. Remote 연결이나 workspace 전환이 repair IPC를 실제로 지연시키지 않는 것으로 확인되거나 transport가 main thread 비의존 경로를 제공하면 이 예산을 재검토한다.
