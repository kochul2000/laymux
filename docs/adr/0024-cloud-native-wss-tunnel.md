# 0024. Cloud Native WSS Tunnel

- Status: Accepted
- Date: 2026-07-06
- Source: laymux-server `docs/tunnel-protocol.md`, docs/architecture/api-contracts.md

## Context

Cloud pairing은 desktop device token과 relay tunnel URL을 확보하지만, 브라우저 원격 접속 요청을 실제 laymux instance로 전달하는 transport는 별도 결정이 필요하다. 기존 Direct Remote Mode는 로컬 axum listener와 bearer/IP allowlist를 전제로 하며, Tailscale 직접 접속을 계속 지원해야 한다.

Cloud relay는 인증된 browser 요청을 WSS `/tunnel`의 M5 stream frame으로 desktop에 전달한다. Desktop은 새 HTTP server를 열지 않고 outbound socket만 유지해야 하며, relay device token과 로컬 Direct Remote 인증/노출 정책의 보안 경계를 섞으면 안 된다.

## Decision

laymux desktop은 native Rust WSS client로 relay tunnel에 접속한다. 접속은 `settings.remote.cloudTunnelUrl`로 dial하고 keyring device token을 `Authorization: Bearer <device-token>`에 넣는다. Relay의 `ready` 또는 `heartbeat.ack` frame이 `instanceId`를 주면 `AppState.cloud.connected=true`와 instance id를 갱신한다. 연결 종료 후에는 `connected=false`로 전환하고 지수 backoff로 재접속한다.

Tunnel transport는 M5 `stream.open`, `stream.data`, `stream.close`, `stream.error` JSON frame을 사용한다. HTTP request stream은 body를 bounded buffer로 조립한 뒤 기존 `remote_server::build_router(ServerState).with_state(ServerState)`를 `tower::ServiceExt::oneshot`으로 호출한다. 내부 request에는 `ConnectInfo(127.0.0.1:0)`와 크레이트 내부 전용 `TunnelAuthorized` request extension을 삽입한다. `remote_guard`는 이 marker가 있을 때 Direct Remote의 enabled/token/IP/Origin gate를 건너뛰며, marker는 wire로 주입할 수 없다. Hop-by-hop header와 외부 `Authorization` header는 터널 내부 request/response에서 전달하지 않는다. HTTP stream은 request close 이후에도 response close/error 완료 전까지 `Responding` 상태로 active map에 남아 stream id, active stream slot, socket pending bytes를 예약한다. response task completion은 stream id와 response generation id가 현재 `Responding` entry와 일치할 때만 active entry를 정리해 stale completion이 재open된 stream을 제거하지 못하게 한다.

Terminal output WebSocket은 axum `WebSocketUpgrade`를 터널에서 직접 재현하지 않는다. 대신 기존 `/remote/v1/terminals/{id}/output`의 output buffer polling 규칙(recent snapshot, 50ms delta, 500ms lease check)을 cloud tunnel worker가 복제해 `stream.data` base64 frame으로 보낸다.

Cloud tunnel은 runtime Direct Remote access를 켜지 않는다. 따라서 cloud 연결만으로 로컬 TCP `/remote` listener가 열리거나 persistent `settings.remote.authToken`이 다시 활성화되지 않는다. Persistent Direct Remote 설정과 Tailscale 직접 접속 계약은 변경하지 않는다.

## Consequences

Cloud 연결은 inbound port 없이 동작한다. Automation API dev/release 고정 포트 정책은 그대로 유지되고, cloud relay는 device token 인증을 맡으며 desktop 내부 dispatch는 Direct Remote의 base gate 대신 내부 marker를 사용한다. Controller lease 검증은 기존 remote handler 내부 로직을 그대로 재사용한다.

HTTP request body, active stream 수, socket 전체 pending body bytes, outbound tunnel queue는 bounded 처리한다. 한계를 넘는 stream은 `stream.error`로 종료한다. 인증 실패 close code(4001 및 401 계열)는 fatal로 처리해 자동 재접속을 중단하고 재-pair가 필요한 last error를 남긴다. malformed frame은 연결을 끊지 않고 stream id가 식별되면 해당 stream에 `stream.error`를 보내며, 식별할 수 없으면 경고 후 무시한다. 실제 relay 통합 E2E는 relay dev server가 필요하므로 이 ADR의 코드 검증 범위는 frame codec, request/response mapping, ready status update, reconnect backoff, fatal auth close, malformed frame handling, backpressure boundary 단위 테스트에 둔다.

WebSocket output stream은 remote route 구현과 중복되는 polling logic을 갖는다. 이는 axum WebSocket upgrade를 `oneshot` 내부에서 터널 frame으로 직접 변환하기 어렵기 때문이며, 두 경로의 polling 상수와 lease 검증 정책이 drift하지 않도록 living doc과 테스트로 고정한다.
