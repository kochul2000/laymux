# 0022. Cloud Connection Foundation

- Status: Accepted
- Date: 2026-07-05
- Source: cloud connection foundation plan, docs/architecture/api-contracts.md §10

## Context

laymux는 기존 Direct Remote Mode를 유지하면서, 후속 PR에서 cloud relay pairing과 tunnel transport를 추가할 예정이다. 이번 foundation 단계에서는 pairing HTTP, OAuth callback, WSS tunnel 계약이 아직 확정되지 않았으므로 외부 네트워크 계약을 만들지 않는다.

그래도 UI와 backend가 이후 pairing/tunnel 구현을 받을 수 있도록 최소 상태와 저장 위치는 먼저 고정해야 한다. 특히 device token은 장기 인증 재료이므로 사용자가 편집/공유하는 `settings.json`에 저장하면 안 된다.

## Decision

Cloud 연결 상태는 `AppState.cloud`의 `CloudStatus { connected, instanceId, lastError }`로 둔다. Tauri command는 `get_cloud_status`와 `cloud_disconnect`만 제공한다. `cloud_connect_start`와 pairing/tunnel command는 서버 계약이 확정되는 다음 PR에서 추가한다.

Cloud 영속 설정은 `settings.remote`에 additive 필드로 둔다: `cloudEnabled`, `relayBaseUrl`, `cloudInstanceId`, `cloudAutoReconnect`. 기본값은 각각 `false`, `""`, `null`, `true`다. 기존 Direct Remote 설정과 마찬가지로 camelCase settings.json 계약을 따른다.

Device token은 OS keyring에 저장한다. service는 release 빌드에서 `laymux`, debug 빌드에서 `laymux-dev`, account는 `device-token`이다. `cloud_disconnect`는 keyring token을 삭제하고, `cloudEnabled=false`, `cloudInstanceId=null`을 저장하며, `AppState.cloud`를 기본 disconnected 상태로 되돌린다.

## Consequences

`settings.json`에는 cloud 연결 메타데이터와 relay override만 남고 인증 token은 남지 않는다. dev/release build의 keyring service가 분리되어 개발 중 token이 사용자 release 프로필과 섞이지 않는다.

이번 PR의 UI는 상태 표시, relay override 입력, 연결 해제만 제공한다. 로그인/연결 시작 버튼과 자동 재연결 동작은 pairing/tunnel 계약이 확정될 때 추가해야 한다.

keyring 접근은 동기 API이므로 Tauri command에서 blocking 작업을 UI thread 밖으로 보내야 한다. 테스트는 keyring mock credential store를 사용해 실제 OS 자격증명 저장소를 건드리지 않는다.
