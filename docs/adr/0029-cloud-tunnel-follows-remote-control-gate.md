# 0029. 클라우드 터널 연결은 원격 제어 게이트를 따른다

- Status: Accepted
- Date: 2026-07-13
- Source: "원격이 비활성화된 상태면 클라우드에 아무 액션도 하지 않아야 한다" 사용자 보안 요구
- Amends: [ADR-0024](0024-cloud-native-wss-tunnel.md) 의 "연결성 부여" 조항

## Context

[ADR-0024](0024-cloud-native-wss-tunnel.md)는 "cloud pairing은 연결성(online)을 부여하고, 실제 제어권은 `settings.remote.enabled || runtimeRemoteAccess.enabled` 토글이 켜졌을 때만 부여한다"로 정했다. 이 모델에서 desktop은 pairing 이후 `cloudAutoReconnect=true`이면 원격 제어 토글과 무관하게 WSS 터널을 유지했다. `TunnelAuthorized` 요청은 enabled gate를 그대로 통과하지 못하므로 제어 자체는 막혔지만, 터널 socket이 살아 있어 relay는 인스턴스를 **online**으로 표시했다.

결과적으로 원격 제어가 꺼진 인스턴스도 웹 대시보드 목록에 online으로 노출됐고, 사용자가 연결을 시도하면 desktop이 403(제어 게이트)로 거절해 오류 메시지만 떴다. 원격 제어를 끈 사용자 입장에서는 "끈 상태인데 클라우드에는 계속 접속해 있고, 목록에도 뜨고, 연결 시도 시 오류가 난다"는 것이 보안·기대 위반이다. 원격 제어 OFF는 "이 데스크톱은 지금 원격에 관여하지 않는다"는 의사표시이므로, 그 상태에서는 클라우드에 어떠한 네트워크 활동(pairing, 터널 dial, online 표시)도 없어야 한다.

## Decision

클라우드 터널의 **연결 수명주기** 자체를 원격 제어 게이트(`settings.remote.enabled || runtimeRemoteAccess.enabled`)에 종속시킨다. 이는 개별 요청을 검사하던 게이트를 연결 성립 단계로 끌어올리는 것으로, ADR-0024의 "pairing = 연결성"만 부여한다는 조항을 정정한다.

- **시작 시 자동 재접속**(`start_auto_reconnect`)과 **터널 기동**(`start_tunnel_from_settings` → `build_tunnel_config`)은 `effective_remote_settings`(persistent OR runtime 병합)로 게이트를 평가한다. 실효 enabled가 false면 터널을 열지 않는다 — relay에 online을 보고하지 않는다.
- **런타임 토글 변화 시 재조정**: `set_remote_runtime_access` 가 게이트를 바꾸면 `reconcile_cloud_tunnel_for_access` 가 호출된다. 게이트 OFF → 살아 있는 터널을 즉시 종료하고 `AppState.cloud.connected=false`로 전환한다(instance id는 유지 = "paired but offline"). 게이트 ON → paired + `cloudAutoReconnect`인 인스턴스를 재접속한다.
- **pairing/connect 거절**: `cloud_connect_start` 는 실효 enabled가 false면 브라우저를 열거나 relay에 접속하기 **전에** 거절하고 `lastError`를 남긴다. 원격 제어가 꺼진 채로는 pairing 조차 클라우드에 접촉하지 않는다.

pairing 자격증명(keyring device token, `settings.remote` cloud 필드)은 게이트 OFF에서도 디스크에 남는다. 게이트를 다시 켜면 별도 재-pair 없이 재접속한다. `TunnelAuthorized` 요청이 여전히 enabled gate를 요구한다는 ADR-0024·0016의 per-request 정책은 그대로 유효하다 — 본 ADR은 그 요청이 도달하기 전 단계(터널 성립)까지 게이트를 확장할 뿐이다.

## Consequences

- 원격 제어 OFF 상태의 데스크톱은 클라우드에 online으로 나타나지 않는다. 웹 대시보드에 노출되지 않으므로 "목록에는 보이지만 연결하면 오류"가 사라진다.
- `cloudAutoReconnect`의 의미가 "토큰이 있으면 시작 시 자동 재접속"에서 "**원격 제어가 켜져 있고** 토큰이 있으면 시작 시 자동 재접속"으로 좁아진다. 시작 시 자동으로 클라우드에 붙으려면 `settings.remote.enabled`(시작 시 자동 허용)도 켜져 있어야 한다.
- 원격 제어 런타임 토글은 이제 로컬 Direct Remote 표면뿐 아니라 클라우드 터널의 online 여부까지 좌우한다. 토글을 끄면 두 transport 모두 즉시 내려간다.
- 터널 연결 수명주기가 `AppState` 런타임 상태(remote_access)에 의존하므로, cloud tunnel worker는 설정 파일만이 아니라 실효 원격 설정을 참조한다.
