# 0037. Remote lease는 이탈 시 beacon으로 반납하고, 재접속은 비밀 resume capability로 이어받는다

- Status: Accepted
- Date: 2026-07-18
- Source: 사용자 피드백(뒤로가기·브라우저 잠깐 닫기 후 재접속 시 `409` 빈발) · PR #471 리뷰(공개 lease id 증명 불가·release drain 경합·탭 복제) · ADR-0013 · ADR-0027 · architecture/api-contracts.md §13.2

## Context

Remote page가 탭 닫기·뒤로가기·새로고침으로 사라질 때 lease를 반납하지 않았다. `beforeunload`는 heartbeat와 socket만 멈추고, `leaseId`는 페이지 런타임 변수에만 있어 navigation과 함께 사라졌다. 서버의 controller lease는 heartbeat timeout(기본 45초, 최소 30초 — ADR-0027) 동안 좀비로 남고, 같은 사용자가 곧바로 다시 접속해도 claim은 `lease.is_some()`에 걸려 `409`를 반환했다. 사용자 입장에서는 자기 자신이 방금 쓰던 제어권인데도 최대 45초 동안 재접속이 거부된다.

재접속 증명 설계에는 세 가지 제약이 있다.

1. **lease id는 비밀이 아니다.** `/remote/v1/session/status`와 claim 충돌 `409` 응답 body가 현재 `leaseId`를 노출하므로, 같은 remote token을 가진 어떤 클라이언트든 이 값을 읽을 수 있다. 공개 값을 takeover 증명으로 쓰면 exclusive lease가 우회된다.
2. **release와 재접속은 경합한다.** pagehide beacon release가 기존 PTY 작업 drain을 기다리며 `transitioning=true`인 동안 후속 문서의 claim이 도착하면 일반 `409`가 나고, 클라이언트는 `input_busy` 외 `409`를 재시도하지 않으므로 reload가 실패한다.
3. **웹 저장소는 탭 복제로 새어 나간다.** `window.open` 탭과 Duplicate Tab은 opener/원본의 sessionStorage 복사본으로 시작하므로, 저장소에 상시 보관된 자격은 복제 탭이 그대로 제시해 원본을 끊을 수 있다.

`409` claim 충돌 자체는 exclusive controller lease 계약(ADR-0013)의 의도된 동작이고, lease 상실이 서버에서 확정된 뒤 자동 재claim을 금지하는 규칙(ADR-0027)도 유지해야 한다. 이번 결정의 범위는 "아직 유효한 자기 lease"의 회수 경로와 이탈 시 반납이며, 상실 확정 후 복구 정책이나 lease timeout 값 변경은 비목표다.

## Decision

같은 컨트롤러의 재접속은 heartbeat timeout을 기다리지 않는다. 증명은 공개 lease id가 아니라 **비밀 resume capability**다.

1. **resume capability 발급.** `POST /remote/v1/session/claim` 성공 응답에만 `resumeToken`(UUID)을 포함한다. 서버는 토큰 원문을 보관하지 않고 process-random 키의 이중 SipHash digest만 lease 옆에 저장한다(기존 claim reservation 토큰과 동일 기법). status·충돌 응답 어디에도 이 값은 나타나지 않는다.
2. **takeover.** claim body의 optional `resumeToken`이 현재 Active lease와 함께 발급된 capability와 일치하면(그리고 owner transition이 진행 중이 아니면) claim이 통과하고, 이후 기존 경로(reclaim lockout → input-busy reservation → owner epoch 전진 → lease 교체)를 그대로 따른다. 새 lease id와 새 resumeToken이 발급되며 옛 capability는 그 즉시 무효가 된다.
3. **pagehide beacon release + handoff drain.** Remote page는 `pagehide`에서 `navigator.sendBeacon`(불가 시 `keepalive` fetch)으로 `/remote/v1/session/release`를 호출한다. beacon은 헤더를 실을 수 없으므로 인증은 기존에 지원되던 `token` query parameter를 사용한다. **자발적 release**의 owner transition은 만료·reclaim·disable 전환과 달리 resume capability를 revoke하지 않고 drain 동안 유지한다. drain 중 도착한 claim이 이 capability를 제시하면 서버는 bounded transition budget 안에서 drain 완료를 기다린 뒤 claim을 이어서 처리한다(handoff). capability가 없거나 틀리면 기존대로 일반 `409`다.
4. **탭 복제 방어(consume-on-load).** 클라이언트에서 resumeToken은 문서가 살아 있는 동안 메모리에만 존재한다. sessionStorage(`laymux.remote.resumeToken`)에는 `pagehide` 시점에만 stash하고, 문서 load(및 bfcache 복원 `pageshow`)에서 즉시 consume(get+remove)한다. Duplicate Tab/`window.open`은 **살아 있는** 원본의 저장소 — 항상 비어 있음 — 를 복제하므로 어떤 복제 탭도 capability를 제시할 수 없다.

불변식:

- takeover/handoff는 **비밀 capability 보유자만** 가능하다. 공개 lease id·빈 토큰·다른 토큰은 모두 기존대로 `409`다.
- 만료가 관측된 lease는 부활하지 않고(sticky expiry), 만료·reclaim·disable로 시작된 transition은 capability를 즉시 revoke한다 — 상실 확정 후 자동 재claim 금지(ADR-0027)는 그대로다. handoff는 **자발적 release의 drain 창**에만 존재한다.
- PC의 reclaim lockout은 takeover/handoff보다 우선한다.
- 서버가 상실을 확정하면(`401/403/409`) 클라이언트는 메모리와 저장소의 capability를 모두 폐기한다.
- beacon 유실은 안전하다: 좀비 lease는 capability takeover로 교체되거나 heartbeat timeout으로 만료된다. release가 도착했다면 capability는 drain handoff에 쓰이거나, drain 종료 후에는 lease가 없으므로 일반 claim이 진행된다.

## Alternatives Considered

- **공개 `leaseId`를 `previousLeaseId`로 제시(초안).** status/충돌 응답에 노출되는 값이라 같은 remote token의 두 번째 클라이언트가 활성 컨트롤러를 즉시 교체할 수 있다. 기각.
- **claim의 lease-exists `409`를 클라이언트가 timeout까지 backoff 재시도.** 사용자는 여전히 최대 45초를 기다리고, ADR-0027이 금지한 "409 자동 재claim"과 경계가 모호해진다. 기각.
- **클라이언트 신원(cookie/디바이스 id) 기반 서버측 세션 매칭.** 새 신원 체계가 필요하고 인증 계층과 중복되며, 탭 단위 소유권(같은 기기의 다른 탭은 다른 컨트롤러)을 표현하지 못한다. 기각.
- **resumeToken을 localStorage/상시 sessionStorage에 보관.** 탭 복제·동일 origin의 다른 탭이 자격을 승계해 원본을 끊는다. unload 경계에서만 저장소를 스치는 consume-on-load 모델로 대체. 기각.
- **release drain 중 claim을 클라이언트 재시도로 처리.** `input_busy`와 달리 서버가 재시도 계약(`retryAfterMs` 등)을 새로 노출해야 하고, drain은 이미 bounded(750ms)라 서버가 기다렸다 이어주는 편이 왕복 없이 결정적이다. 기각.
- **heartbeat timeout 단축.** 짧은 무선 단절 흡수를 위해 45초로 늘린 ADR-0027과 정면 충돌. 기각.

## Consequences

- 뒤로가기·새로고침·탭 닫기 후 재접속이 heartbeat timeout을 기다리지 않는다. beacon이 유실돼도 같은 탭이면 takeover로 즉시 회복되고, beacon과 재접속이 겹치면 서버가 drain을 이어서 처리한다.
- 자격 증명이 응답 한 곳(claim 성공)에만 나타나고 서버는 digest만 보관하므로, 로그·status 구독자·충돌 응답을 통한 유출 면이 없다.
- 탭을 복제한 사용자는 복제 탭에서 즉시 제어권을 가져올 수 없고 기존 `409` 경로로 안내된다(원본 탭이 계속 컨트롤러). 이는 의도된 동작이다.
- bfcache에서 복원된 페이지는 stash를 다시 consume해 capability를 회수하지만, pagehide에서 이미 release beacon을 보냈으므로 stale lease로 heartbeat `409`를 받으면 "Connect again" 안내로 수렴한다. 복원 시 자동 재연결은 범위 밖이며, 필요해지면 별도 ADR로 확장한다.
- 크래시처럼 pagehide가 발화하지 않는 이탈은 stash도 beacon도 없다 — 기존과 동일하게 heartbeat timeout으로 수렴한다.
- 테스트: 서버는 capability 발급/회전·공개 id 거부·voluntary drain handoff·만료/reclaim revoke를 서버 상태 테스트로, 클라이언트는 Playwright로 beacon 발화·reload takeover·duplicate-tab 거부·상실 시 폐기를 검증한다. living doc(api-contracts.md §13.2)을 같은 PR에서 갱신한다.
