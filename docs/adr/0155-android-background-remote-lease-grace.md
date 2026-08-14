# 0155. Android E2E Remote 백그라운드 lease 유예

- Status: Proposed
- Date: 2026-08-14
- Source: 사용자 요구, `docs/architecture/api-contracts.md` §13.2, ADR-0146, ADR-0037

## Context

Android 사용자가 GitHub 같은 외부 앱을 잠시 열면 WebView의 pagehide가 controller lease를 즉시 반납했다. E2E 세션 키는 15분 동안 보존되므로, 곧바로 돌아와도 lease reclaim과 409 충돌 메시지가 발생했다.

## Decision

Android E2E controller는 앱이 background로 전환될 때 인증된 `backgroundTransition` RPC 하나로 PC의 현재 `remote.androidBackgroundLeaseSeconds`를 읽고, 같은 처리에서 현재 lease를 연장하거나 `0`이면 즉시 voluntary release한다. 기본값과 상한은 900초다. pagehide는 캐시된 설정으로 lease를 판단하지 않는다. foreground heartbeat는 일반 heartbeat timeout으로 되돌아가며, 명시적 Exit와 PC reclaim은 즉시 lease를 해제한다.

## Alternatives Considered

pagehide release를 모든 Android 경우에 제거하는 방식은 앱을 사실상 떠난 controller가 무기한 입력을 막는다. 일반 remote heartbeat timeout을 전역으로 15분으로 늘리면 browser controller와 Local reclaim의 응답성도 나빠진다.

## Consequences

짧은 앱 전환은 reclaim 없이 복귀한다. 설정을 낮추면 다른 controller가 제어권을 얻기까지의 최대 대기 시간도 줄어든다. E2E session의 15분 key 만료와 lease 유예는 별개지만 동일한 900초 상한을 갖는다.
