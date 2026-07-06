# 0023. Cloud Pairing Loopback OAuth

- Status: Accepted
- Date: 2026-07-05
- Source: cloud pairing server contract, docs/architecture/api-contracts.md

## Context

Cloud 연결 foundation은 device token 저장 위치와 런타임 상태만 고정했다. 서버 pairing 계약이 확정되면서 desktop 앱이 browser 기반 인증을 시작하고, relay가 발급한 device token을 OS keyring에 저장하는 경계가 필요해졌다.

이 pairing 단계는 WSS tunnel을 아직 열지 않는다. 따라서 성공 후 `CloudStatus.connected` 를 `true` 로 만들면 실제 relay 연결과 사용자 표시가 어긋난다.

## Decision

Desktop pairing은 loopback OAuth 흐름으로 구현한다. 앱은 `127.0.0.1:0`에 임시 HTTP listener를 열고 redirect URI를 `http://127.0.0.1:<port>/pair/callback` 으로 고정한다. listener는 `GET /pair/callback` 만 처리하고 다른 path는 `404`로 응답한다. callback은 `code`, `error`, `state` query를 해석하며 state는 앱이 생성한 random 값과 정확히 일치해야 한다.

앱은 `{relayBaseUrl}/pair/desktop?redirect_uri=&state=&name=` 을 시스템 브라우저로 열고, callback에서 받은 code를 `{relayBaseUrl}/api/desktop/pair/complete` 에 POST한다. complete 응답의 `deviceToken` 은 keyring service `laymux` 또는 dev 빌드의 `laymux-dev`, account `device-token` 에 저장한다. `settings.remote` 에는 `cloudEnabled=true`, `cloudInstanceId`, `cloudTunnelUrl`, `cloudServerBaseUrl`, `relayBaseUrl` 만 저장한다.

`relayBaseUrl` 기본값은 빈 문자열이 아니라 placeholder `https://cloud.laymux.example` 이다. 개발 relay는 Settings의 override로 `http://127.0.0.1:8000` 같은 값을 저장한다.

`cloud_connect_start` 는 async Tauri command로 노출하고, 성공 또는 실패 결과를 `CloudStatus` 로 반영해 반환한다. pairing 성공 후에도 WSS tunnel PR 전까지 `connected=false`, `instanceId=<issued id>`, `lastError=null` 상태를 사용한다.

## Consequences

Device token은 `settings.json` 에 나타나지 않고 OS credential store에만 남는다. settings에는 다음 PR의 tunnel dial에 필요한 URL과 instance metadata만 남는다.

브라우저 redirect는 loopback HTTP에 제한되므로 relay가 임의 scheme, userinfo, fragment, 외부 host callback으로 desktop token을 넘기지 않는다. 앱은 callback listener를 pairing 동안만 유지하며 전체 pairing은 timeout으로 끝난다.

UI는 pairing 성공을 “페어링됨 (연결 대기)”로 표시해야 한다. 실제 “연결됨” 표시는 WSS tunnel worker가 `CloudStatus.connected=true` 로 전환하는 다음 PR의 책임이다.
