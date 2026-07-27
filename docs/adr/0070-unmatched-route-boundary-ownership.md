# 0070. 미등록 경로 응답과 라우트 경계 소유권

- Status: Accepted
- Date: 2026-07-27
- Source: issue #591, PR #593 리뷰, [architecture/api-contracts.md §12.6](../architecture/api-contracts.md), [ADR-0002](0002-automation-api-fixed-port-ip-allowlist.md), AGENTS.md ADR 게이트

## Context

Automation API와 Remote API는 같은 axum 서버에서 각각 라우터를 만든 뒤 합성한다. axum의 `Router::layer`는 등록된 라우트뿐 아니라 그 라우터의 fallback도 감싸며, `merge`는 한쪽 fallback을 합성 결과로 넘길 수 있다. 이 때문에 Remote 인증 가드를 라우터 전체 레이어로 붙이면 어느 표면에도 등록되지 않은 경로까지 Remote 인증 실패인 401로 답해 경로 오타와 인증 실패를 구분할 수 없었다.

합성 뒤 명시적 404 fallback을 추가하면 응답 의미는 바로잡을 수 있지만, 각 하위 라우터에 CORS를 적용한 다음 fallback을 추가하는 순서에서는 그 fallback이 CORS 레이어 밖에 놓인다. 브라우저와 WebView는 404 또는 IP allowlist의 403 JSON 본문 대신 CORS 오류만 보게 된다. 따라서 fallback, 네트워크 경계, 라우트 인증, 응답 장식의 소유권과 적용 순서를 하나의 계약으로 고정해야 한다.

이 결정은 같은 프로세스에서 합성되는 Automation/Remote HTTP 표면의 미등록 경로 처리만 다룬다. 등록된 엔드포인트의 응답 스키마, Remote 토큰 계약, IP allowlist 허용 대역은 바꾸지 않는다.

## Decision

**합성 라우터가 유일한 미등록 경로 fallback과 최외곽 CORS를 소유하고, 네트워크 경계는 fallback까지, 라우트 인증은 등록된 라우트에만 적용한다.**

- Automation 라우터와 Remote 라우터를 합친 뒤 서버 전체에 명시적 fallback 하나를 등록한다. 허용된 peer의 미등록 경로는 404와 `{ "error": "no such route: <METHOD> <path>", "method", "path", "docs": "/api/v1/docs" }`를 반환한다.
- IP allowlist는 라우트 인증이 아니라 서버의 네트워크 경계다. 따라서 Automation 라우트와 공용 fallback 모두에 적용하며, 허용 밖 peer의 미등록 경로는 관측한 `clientIp`를 포함한 403을 반환한다.
- `remote_guard` 같은 표면별 인증은 `route_layer`로 등록된 Remote 라우트에만 붙인다. 어떤 인증 가드도 공용 fallback의 응답을 대신 결정하지 않는다.
- `CorsLayer`는 합성과 fallback 등록을 마친 라우터의 최외곽에 적용한다. 그 결과 등록 라우트의 성공·실패 응답뿐 아니라 공용 404와 allowlist 403도 브라우저가 읽을 수 있다. Remote 라우터처럼 별도로 서빙될 수 있는 하위 표면은 자체 CORS를 유지할 수 있지만, 합성 서버의 계약은 최외곽 레이어가 보장한다.
- 이 소유권과 순서는 `automation_server::surface_router`가 한 곳에서 구현하고 테스트한다.

## Alternatives Considered

1. **Remote 인증 가드를 라우터 전체 `layer`로 유지한다.** 등록 여부를 판단하기 전에 401을 내므로 경로 오타를 인증 실패로 오진하게 하고, 라우터 합성 순서에 따라 다른 표면까지 가로챌 수 있어 기각했다.
2. **공용 fallback에는 IP allowlist를 적용하지 않는다.** 허용 밖 peer가 404와 401 차이를 이용해 서버 라우트를 탐색할 수 있어 ADR-0002의 네트워크 경계를 약화하므로 기각했다.
3. **각 하위 라우터의 CORS만 유지한다.** 합성 뒤 추가되는 fallback이 어느 CORS 레이어에도 감싸이지 않아 브라우저 계약이 깨지므로 기각했다.
4. **각 표면이 자체 fallback을 소유한다.** `merge` 순서에 따라 최종 fallback 소유자가 달라지고 서버 전체의 미등록 경로 계약이 분산되므로 기각했다.

## Consequences

- 경로 오타는 인증 상태와 무관하게 일관된 404 JSON으로 진단할 수 있고, 브라우저·WebView도 CORS에 막히지 않고 그 본문을 읽는다.
- 허용 밖 peer는 미등록 경로에서도 계속 403을 받아 라우트 존재 여부를 탐색할 수 없다.
- 합성 경계 코드와 관련 회귀 테스트가 별도 모듈에 모여 `automation_server/mod.rs`는 서버 시작과 Automation 라우트 등록 책임에 집중한다.
- 별도 서빙을 지원하는 Remote 라우터의 자체 CORS와 합성 서버의 최외곽 CORS가 함께 존재할 수 있다. 합성 서버에서는 최외곽 레이어가 최종 응답 계약의 SoT다.
- 404/403 상태·JSON·CORS 헤더와 등록 Remote 라우트의 인증 유지 여부를 단위 테스트로 고정한다. 설정·데이터 마이그레이션은 없다.
- 다른 HTTP 표면을 합성할 때 공용 fallback보다 바깥에 인증 가드를 추가해야 할 요구가 생기면 이 결정을 재검토한다.
