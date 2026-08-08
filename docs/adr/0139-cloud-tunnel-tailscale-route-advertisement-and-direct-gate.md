# 0139. 클라우드 터널은 Tailscale 직접 경로를 광고하고 Direct Remote는 Tailscale 전용 게이트를 제공한다

- Status: Accepted
- Date: 2026-08-08
- Source: 사용자 요구 · issue #689 · architecture/api-contracts.md §10 Direct Remote Mode · ADR-0013 · ADR-0021 · ADR-0024
- Extends: ADR-0013, ADR-0021, ADR-0024

## Context

클라우드 대시보드는 인스턴스의 relay tunnel online 여부만 알아서 모든 접속을 `laymux-server` 데이터 평면으로 보낸다. 데스크톱과 브라우저가 같은 Tailnet에 있어도 이미 존재하는 Direct Remote 경로를 대시보드에서 선택할 수 없고, 사용자가 Tailscale 주소를 별도로 기억해야 한다.

Direct Remote에는 bearer token과 IP allowlist가 있지만, allowlist가 LAN과 Tailscale 대역을 함께 포함할 때 Tailscale이 아닌 경로를 한 번에 거절하는 독립 정책은 없다. 사용자는 기존 세부 allowlist를 유지하면서도 Direct Remote transport를 Tailscale peer로 제한할 수 있어야 한다.

서버가 데스크톱의 Direct Remote bearer token을 알게 하면 Tailscale 직접 경로가 relay 침해의 탈출구가 되지 못한다. 서버가 임의 URL을 대시보드에 반영하는 것도 인증된 데스크톱이 소유자 브라우저를 악성 주소로 유도할 수 있으므로 URL 형태를 좁게 검증해야 한다.

범위는 Tailscale IP 기반 Direct Remote 진입 경로의 광고와 수신 정책이다. MagicDNS, `tailscale cert`, HTTPS 종단, Tailscale reachability probe, relay 자동 fallback은 비목표다.

## Decision

**laymux 데스크톱은 cloud heartbeat에 비밀 없는 Tailscale Direct Remote URL을 광고하고, laymux-server는 이를 현재 tunnel presence에만 보관해 인스턴스 카드의 별도 버튼으로 노출하며, Direct Remote는 선택적인 Tailscale source-IP 추가 게이트를 제공한다.**

- 데스크톱은 기존 `get_remote_host_candidates` 감지 결과 중 첫 `kind=tailscale` IP와 현재 automation port로 `http://<tailscale-ip>:<19280|19281>/remote/`를 만든다. IPv6 authority는 bracket 처리한다. 외부 `tailscale ip` probe는 family별 2초 안에 종료·kill하며 tunnel reader/writer와 독립된 task에서 heartbeat 주기마다 갱신한다.
- tunnel `heartbeat` payload의 선택 필드 `tailscaleUrl`만 서버에 전송한다. Direct Remote bearer token, allowlist, Tailnet 식별자와 기기 비밀은 전송하지 않는다.
- 서버는 URL의 scheme이 `http`, host가 Tailscale IPv4 `100.64.0.0/10` 또는 IPv6 `fd7a:115c:a1e0::/48`, port가 laymux release/dev 고정 포트, path가 정확히 `/remote/`이고 userinfo/query/fragment가 없을 때만 수락한다.
- 광고는 DB에 영속하지 않고 현재 `RegisteredTunnel` generation에만 둔다. tunnel이 사라지거나 새 heartbeat에서 필드가 빠지면 카드의 직접 경로도 사라진다. Tailscale 시작·종료·IP 변경은 tunnel 재연결 없이 다음 bounded refresh가 반영하며 값이 바뀌면 정규 heartbeat를 기다리지 않고 갱신 frame을 보낸다.
- 온라인 카드의 기존 relay 연결과 Tailscale 직접 연결은 서로 다른 명시적 버튼이다. 자동 redirect나 무음 fallback은 하지 않는다.
- `settings.remote.tailscaleOnly` 기본값은 `false`다. `true`이면 TCP Direct Remote 요청의 관측 source IP가 위 Tailscale 대역에 포함되어야 하며, 기존 `allowedIps`, bearer token, Origin 검사는 추가로 모두 통과해야 한다.
- `TunnelAuthorized` cloud 요청은 WSS device credential로 transport 인증을 마쳤으므로 `tailscaleOnly`를 우회하고 기존 remote enabled gate만 따른다.
- Settings UI에서 Tailscale 전용을 켤 때 표준 Tailscale CIDR preset을 `allowedIps`에 중복 없이 추가한다. 끌 때는 사용자가 관리하는 allowlist를 임의로 삭제하지 않는다.

## Alternatives Considered

- **서버가 Tailscale 주소를 능동 probe한다.** 서버는 사용자의 Tailnet에 속하지 않으므로 일반적으로 직접 주소에 도달할 수 없고, 판정 결과도 실제 브라우저의 reachability를 대변하지 못해 기각했다.
- **Direct Remote token을 서버에 보내 원클릭 인증한다.** relay 침해가 Direct 경로의 인증까지 획득하고 장기 비밀이 서버에 노출되므로 기각했다.
- **Tailscale 경로를 자동 우선하고 실패하면 relay로 fallback한다.** 브라우저의 사설 HTTP reachability를 신뢰성 있게 사전 판정하기 어렵고 접속 경로와 보안 속성이 사용자에게 숨겨지므로 이번 범위에서는 기각했다.
- **`tailscaleOnly`가 `allowedIps`를 대체한다.** 특정 Tailnet peer만 허용하는 기존의 더 좁은 정책을 잃으므로, 두 조건의 교집합을 사용한다.
- **광고 URL을 instance DB에 저장한다.** 오프라인 이후 stale 주소가 남고 네트워크 식별 정보의 불필요한 영속이 생기므로 current tunnel presence에만 둔다.

## Consequences

- 같은 Tailnet의 사용자는 클라우드 대시보드에서 relay와 Tailscale 경로를 명시적으로 선택할 수 있다.
- relay는 Direct Remote token을 알지 못하므로 Tailscale 버튼을 처음 쓰는 브라우저는 기존 Direct Remote 인증 절차를 거쳐야 한다.
- `tailscaleOnly=true`는 Tailscale 대역 조건과 `allowedIps`의 교집합이므로, MCP나 파일 편집으로 설정할 때도 적절한 Tailnet CIDR/peer를 allowlist에 포함해야 한다. Settings UI는 표준 범위를 자동 추가한다.
- IP 대역 판정은 Tailscale의 현재 주소 계약에 의존한다. Tailscale 주소 체계나 laymux 고정 포트가 바뀌면 데스크톱 생성과 서버 검증을 같은 변경으로 갱신해야 한다.
- MagicDNS+HTTPS가 도입되기 전 Direct URL은 평문 HTTP다. WireGuard transport 격리와 bearer token은 유지되지만 secure-context 기능/PWA 설치는 제공하지 않는다.
- 테스트는 설정 round-trip, source-IP 게이트, IPv4/IPv6 URL 생성, 서버 URL 검증, heartbeat presence 갱신, 카드 조건부 렌더링을 고정한다.
