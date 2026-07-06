# 0024. Cloud Native WSS Tunnel

- Status: Accepted
- Date: 2026-07-06
- Source: laymux-server `docs/tunnel-protocol.md`, docs/architecture/api-contracts.md

## Context

Cloud pairing은 desktop device token과 relay tunnel URL을 저장하지만, 브라우저 원격 접속 요청을 실제 laymux instance로 전달하는 transport는 별도 결정이 필요하다. 기존 Direct Remote Mode는 로컬 axum listener와 bearer/IP allowlist를 전제로 하며, Tailscale 직접 접속을 계속 지원해야 한다.

Cloud relay는 인증된 browser 요청을 WSS `/tunnel`의 M5 stream frame으로 desktop에 전달한다. Desktop은 새 inbound HTTP server를 열지 않고 outbound socket만 유지해야 하며, relay device token과 로컬 Direct Remote 인증/노출 정책의 보안 경계를 분리해야 한다.

## Decision

laymux desktop은 native Rust WSS client로 relay tunnel에 접속한다. 접속은 `settings.remote.cloudTunnelUrl`로 dial하고 keyring device token을 `Authorization: Bearer <device-token>`으로 보낸다. Relay가 `ready` 또는 `heartbeat.ack` frame으로 `{ instanceId }`를 보내면 `AppState.cloud.connected=true`와 instance id를 갱신한다. 연결 종료 뒤에는 `connected=false`로 전환하고 지수 backoff로 재접속한다. 단, relay가 4001 또는 401 계열 인증 실패 close를 보내거나 WSS handshake가 401로 실패하면 fatal auth error로 처리해 자동 재접속을 중단하고 재-pair가 필요한 `lastError`를 남긴다.

Tunnel transport는 M5 `stream.open`, `stream.data`, `stream.close`, `stream.error` JSON frame을 사용한다. HTTP request stream은 body를 bounded buffer로 조립한 뒤 기존 `remote_server::build_router(ServerState).with_state(ServerState)`를 `tower::ServiceExt::oneshot`으로 호출한다. 내부 request에는 `ConnectInfo(127.0.0.1:0)`와 크레이트 내부 전용 `TunnelAuthorized` request extension을 삽입한다.

Cloud pairing은 연결성을 부여하고, 실제 제어권은 사용자가 Direct Remote/Remote Access의 "원격 제어 허용" 토글을 켠 경우에만 부여한다. 따라서 `TunnelAuthorized`는 bearer token, IP allowlist, Origin 검사를 우회하지만 enabled gate는 우회하지 않는다. `remote_guard`와 미들웨어 밖의 `/remote`, `/remote/`, `/remote/vendor/*` page/vendor routes 모두 같은 원칙을 적용한다. 터널은 `set_remote_runtime_access`를 호출하지 않으므로 cloud 연결만으로 로컬 TCP `/remote` listener가 열리거나 persistent `settings.remote.authToken`이 재활성화되지 않는다.

외부 `Authorization` 및 hop-by-hop header는 내부 request/response에 전달하지 않는다. 응답은 `stream.open{kind:"http.response",status,headers}` + `stream.data` + `stream.close`로 relay에 돌려준다. HTTP stream은 request `stream.close` 이후에도 response `stream.close` 또는 `stream.error`가 끝날 때까지 active map에 `Responding` 상태로 남아 stream id, active stream slot, socket pending bytes를 예약한다. response task completion은 stream id와 response generation id가 현재 `Responding` entry와 모두 일치할 때만 stream을 정리하며, cancel 후 재open된 stream에 도착한 stale completion은 무시한다.

Terminal output WebSocket은 axum `WebSocketUpgrade`를 tunnel에서 직접 재현하지 않는다. 대신 기존 `/remote/v1/terminals/{id}/output`의 output buffer polling 규칙(recent snapshot, 50ms delta, 500ms lease check)을 cloud tunnel worker가 복제한다. Relay가 output bind를 완료할 수 있도록 desktop은 로컬 terminal snapshot에 성공한 직후, 어떤 `stream.data`보다 먼저 같은 `srv-*` stream id로 `stream.open{kind:"websocket.accept"}`를 1회 보낸다. 이후 output byte stream은 `stream.data` base64 frame으로 전송한다.

## Consequences

Cloud 연결은 inbound port 없이 동작한다. Automation API dev/release 고정 포트 정책은 그대로 유지되고, cloud relay의 device token 인증은 tunnel socket의 transport 인증 경계로만 사용된다. Remote UI의 실제 제어권은 기존 remote enabled gate와 controller lease 검사로 결정된다.

HTTP request body, active stream 수, socket 전체 pending body bytes, outbound tunnel queue는 bounded 처리한다. 한계를 넘는 stream은 `stream.error`로 종료한다. Malformed frame은 연결을 끊지 않고 stream id가 식별되면 해당 stream에 `stream.error`를 보내며, 식별할 수 없으면 경고 후 무시한다.

WebSocket output stream은 remote route 구현과 중복되는 polling logic을 갖는다. 이 경로는 axum WebSocket upgrade를 `oneshot` 내부에서 tunnel frame으로 직접 변환하기 어렵기 때문에 선택한 구현이며, polling 상수와 lease 검증 정책이 drift하지 않도록 living doc과 tests로 고정한다.
