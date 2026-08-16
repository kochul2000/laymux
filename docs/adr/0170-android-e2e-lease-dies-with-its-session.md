# 0170. Android E2E 세션으로 claim 한 controller lease 는 그 세션과 함께 죽는다

- Status: Proposed
- Date: 2026-08-17
- Source: 실기기 재현("잠깐 연결되고 409, 재접속해도 계속 409") · [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md) · [ADR-0037](0037-remote-lease-takeover-and-pagehide-release.md) 계열 lease 의미론
- Extends: ADR-0146

## Context

controller lease 의 수명은 heartbeat timeout(기본 30~45초)뿐이다. Android E2E 경로에서 세션이 죽으면(데스크톱 재시작, transport 실패, 새 establish 의 단일 활성 세션 교체) 앱은 로컬 세션·lease 핸들을 버리고 새 세션으로 재접속하지만, 데스크톱에는 이전 lease 가 heartbeat timeout 까지 살아남는다. 재접속한 페이지의 claim 은 그 죽은 lease 와 충돌해 409 를 받고, 사용자는 기다리는 대신 재시도를 반복하므로 매 시도가 다시 409 를 만난다 — 실기기에서 "재접속해봤자 계속 409" 로 재현됐다.

데스크톱은 어느 lease 가 어느 E2E 세션의 것인지 몰랐다. claim 은 세션 안의 `kind=http` RPC 로 내부 재주입되는데, 재주입 요청에는 `TunnelAuthorized` 외에 호출 주체 식별이 없었기 때문이다. 범위는 desktop 내부의 lease-세션 결합이며, RPC wire 계약·relay·기존 browser lease 의미론은 바꾸지 않는다.

## Decision

**E2E RPC 로 들어온 claim 은 granted lease 를 그 세션의 `(instanceId, sessionId)` 로 태깅하고, 이후 claim 처리 직전에 태그된 세션이 죽었으면(revoke·만료·pairing revision 변경) 그 lease 를 만료와 같은 owner transition 으로 즉시 해제한다.**

- rpc 핸들러는 내부 재주입 요청에 crate 내부 extension(`AndroidE2eClaimContext`)으로 세션 신원을 싣는다. wire 로 위조할 수 없고 plaintext 계약(caller 헤더 금지)은 그대로다.
- 태그는 `lease_id` 가 현재 활성 lease 와 일치할 때만 유효하다. lease 가 교체되면 태그는 자동 무효(새 lease 는 unbound 로 시작).
- claim 전처리: 활성 lease 가 태깅돼 있고 그 세션이 registry 에서 살아있지 않으면 — 새 establish 가 revoke 했든, 15분 비활성으로 만료됐든, pairing 이 교체됐든 — lease 를 해제한다. 해제는 heartbeat 만료와 동일한 owner transition 경로(capability 폐기, drain barrier)를 탄다.
- registry 조회는 controller lock 밖에서 수행하고 해제는 lock 아래에서 태그를 재검증한다(락 순서 규칙 준수). registry lock poison 시에는 lease 를 유지하는 쪽으로 fail 한다 — 경합 중인 claim 이 살아있는 세션의 제어권을 빼앗으면 안 된다.
- browser claim(태그 없음)과 두 클라이언트 간 충돌 의미론은 불변: 살아있는 세션의 lease 는 절대 이 경로로 해제되지 않는다. 단일 활성 세션 규칙(ADR-0146)상 같은 pairing 의 새 세션이 claim 할 때 이전 세션은 항상 이미 revoke 돼 있으므로, 이 결정은 "자기 자신의 시체와 싸우는" 경우만 제거한다.

## Alternatives Considered

- **세션 revoke 시점(establish)에서 lease 를 즉시 해제.** establish 는 android_e2e registry lock 안에서 일어나 remote_control lock 과의 순서 결합이 생기고, lease 를 쓰지 않은 세션에도 비용이 붙는다. claim 시점의 lazy 해제는 필요할 때만 실행되고 락을 겹쳐 잡지 않는다.
- **클라이언트(페이지)가 409 를 받으면 heartbeat timeout 까지 대기/재시도.** 이미 autoConnectWhenFree 가 owner 해제를 기다리지만, 죽은 lease 는 heartbeat 가 없어도 timeout 까지 "owner 있음" 으로 보인다. 30~45초의 불응답은 UX 로 수용 불가.
- **heartbeat timeout 을 짧게.** 정상 세션의 일시적 네트워크 흔들림에 lease 를 잃게 만들어 다른 문제를 산다.
- **plaintext 계약에 세션 신원 필드 추가.** wire 계약 확장이 필요 없고(내부 extension 으로 충분), caller 가 신원을 위조할 수 있게 되는 방향이라 기각.

## Consequences

- E2E 재접속 claim 은 죽은 lease 에 막히지 않는다. 데스크톱 재시작·세션 만료 후 첫 재접속이 즉시 성공한다.
- lease 상태에 `android_e2e_lease` 태그가 추가되지만 상태 소유권·직렬화 표면(status 응답)은 불변이다.
- 검증: lease 태깅/해제/재설치 unbound 단위 테스트, 세션 교체·만료 후 `session_is_active` 판정 테스트. 실기기에서는 데스크톱 재시작 후 재접속이 409 없이 붙는지 수동 확인한다.
- 남은 결함 창: 세션이 살아있는 동안 페이지 문서만 lease 를 잃는 경우(기존 heartbeat 409 → loseRemoteControl → 재claim 경로)가 계속 담당한다.
