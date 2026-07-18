# 0037. Remote lease는 이탈 시 beacon으로 반납하고, 같은 탭의 재접속은 자기 lease를 takeover한다

- Status: Proposed
- Date: 2026-07-18
- Source: 사용자 피드백(뒤로가기·브라우저 잠깐 닫기 후 재접속 시 `409` 빈발) · ADR-0013 · ADR-0027 · architecture/api-contracts.md §13.2

## Context

Remote page가 탭 닫기·뒤로가기·새로고침으로 사라질 때 lease를 반납하지 않았다. `beforeunload`는 heartbeat와 socket만 멈추고, `leaseId`는 페이지 런타임 변수에만 있어 navigation과 함께 사라졌다. 서버의 controller lease는 heartbeat timeout(기본 45초, 최소 30초 — ADR-0027) 동안 좀비로 남고, 같은 사용자가 곧바로 다시 접속해도 claim은 `lease.is_some()`에 걸려 `409`를 반환했다. 사용자 입장에서는 자기 자신이 방금 쓰던 제어권인데도 최대 45초 동안 재접속이 거부된다.

`409` claim 충돌 자체는 exclusive controller lease 계약(ADR-0013)의 의도된 동작이고, lease 상실이 서버에서 확정된 뒤 자동 재claim을 금지하는 규칙(ADR-0027)도 유지해야 한다. 이번 결정의 범위는 "아직 Active한 자기 lease" 회수 경로와 이탈 시 반납이며, 상실 확정 후 복구 정책이나 lease timeout 값 변경은 비목표다.

## Decision

같은 컨트롤러의 재접속은 heartbeat timeout을 기다리지 않는다. 두 경로로 보장한다.

1. **pagehide beacon release.** Remote page는 `pagehide`에서 `navigator.sendBeacon`(불가 시 `keepalive` fetch)으로 `/remote/v1/session/release`를 호출해 lease를 즉시 반납한다. beacon은 헤더를 실을 수 없으므로 인증은 기존에 지원되던 `token` query parameter를 사용한다. `beforeunload`가 아니라 `pagehide`를 쓰는 이유는 모바일 브라우저가 신뢰성 있게 발화하는 유일한 teardown 이벤트이고 bfcache 진입도 포함하기 때문이다.
2. **previousLeaseId takeover.** `POST /remote/v1/session/claim` body에 optional `previousLeaseId`를 추가한다. 서버는 기존 lease가 있어도 `previousLeaseId`가 **현재 Active lease의 id와 일치하고 owner transition이 진행 중이 아니면** claim을 통과시키고, 이후 기존 경로(reclaim lockout → input-busy reservation → owner epoch 전진 → lease 교체)를 그대로 따른다. 새 `leaseId`가 발급되고 옛 lease는 그 자리에서 대체된다.

불변식:

- Takeover는 **Active lease의 보유자만** 가능하다. Expiring lease, transition 진행 중, 다른 lease id는 모두 기존대로 `409`다. 만료가 관측된 lease가 부활하지 않는다는 ADR-0027의 sticky expiry와, 상실 확정 후 자동 재claim 금지는 그대로 유지된다.
- PC의 reclaim lockout은 takeover보다 우선한다. lockout 동안은 `previousLeaseId`가 있어도 `409`다.
- `previousLeaseId`의 SoT는 remote page의 `sessionStorage`(`laymux.remote.leaseId`)다. 탭 단위 저장이므로 같은 탭의 뒤로가기/새로고침만 자기 lease를 이어받을 수 있고, 다른 탭·다른 기기는 id를 알 수 없어 기존 `409` 계약이 유지된다. 서버가 lease 상실을 확정하면(heartbeat/action `401/403/409`) 클라이언트는 저장값을 지운다.
- beacon release가 유실되어도 안전하다: 좀비 lease는 다음 claim의 takeover로 교체되거나 heartbeat timeout으로 만료된다. 반납이 성공했으면 `previousLeaseId`는 어떤 lease와도 일치하지 않아 무시된다.

## Alternatives Considered

- **claim의 lease-exists `409`를 클라이언트가 timeout까지 backoff 재시도.** 서버 계약 변경은 없지만 사용자는 여전히 최대 45초를 기다리고, ADR-0027이 금지한 "409 자동 재claim"과 경계가 모호해진다. 기각.
- **클라이언트 신원(cookie/디바이스 id) 기반 서버측 세션 매칭.** 새 신원 체계와 저장이 필요하고, 인증 계층(ADR-0013의 token, ADR-0024의 tunnel)과 중복된다. lease id 자체가 이미 비밀이므로 보유 증명으로 충분하다. 기각.
- **`beforeunload`에서 동기 release fetch.** 모바일 브라우저에서 `beforeunload`는 발화가 보장되지 않고, unload 중 일반 fetch는 브라우저가 취소할 수 있다. `pagehide` + `sendBeacon`이 표준 권장 경로다. 기각.
- **heartbeat timeout 단축.** 짧은 무선 단절 흡수를 위해 45초로 늘린 ADR-0027과 정면 충돌. 기각.

## Consequences

- 뒤로가기·새로고침·탭 닫기 후 재접속이 heartbeat timeout을 기다리지 않고 즉시 성공한다. beacon이 유실된 경우에도 같은 탭이면 takeover로 즉시 회복된다.
- `sessionStorage` 사용은 surface-local UI 상태 저장 규칙(설정 vs 로컬 상태 분리)과 일치한다. 단, lease id는 UI 상태가 아니라 자격 증명이므로 탭 밖으로 새지 않는 sessionStorage만 허용한다(localStorage 금지).
- bfcache에서 복원된 페이지는 pagehide에서 이미 lease를 반납했으므로 stale lease로 heartbeat `409`를 받고 "Connect again" 안내로 수렴한다. 복원 시 자동 재연결(pageshow 처리)은 이번 결정의 범위 밖이며, 필요해지면 별도 ADR로 확장한다.
- release endpoint가 query token 인증으로도 호출됨이 계약에 명시된다(기존 지원의 문서화이지 신규 노출이 아니다 — WebSocket 경로와 동일).
- 테스트: 서버는 takeover 게이트 단위 테스트, 클라이언트는 Playwright로 beacon 발화·reload takeover·상실 시 저장값 삭제를 검증한다. living doc(api-contracts.md §13.2)을 같은 PR에서 갱신한다.
