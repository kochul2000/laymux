# 0175. Remote OAuth loopback relay — 폰에서 연 설치형 OAuth 로그인을 PC 리스너로 중계

- Status: Accepted
- Date: 2026-08-18
- Source: 사용자 요구("이 링크를 리모트로 접속한 laymux 앱에서는 동작이 되지를 않아 … 이 방법을 laymux 안드로이드 앱이 가능하게 만들 수는 없는 거니?") · [architecture/api-contracts.md §13](../architecture/api-contracts.md)
- Extends: ADR-0015(원격 상태 소유권/lease), ADR-0162(외부 링크는 OS 브라우저), ADR-0170(Android E2E allowlist)

## Context

데스크톱에서 도는 CLI(gcloud, clasp, Google Workspace 계열 등)는 OAuth "installed app" 플로우를 쓴다: PC의 `http://localhost:{ephemeral port}` 에 리스너를 열고 인증 URL 을 터미널에 출력한다. Remote 클라이언트(폰 브라우저·Android 앱)에서 그 링크를 열면 동의 후 provider 가 **폰의** localhost 로 redirect 하므로 authorization code 가 PC 리스너에 도달하지 못하고 플로우가 죽는다. Google 은 수동 복붙용 OOB(`urn:ietf:wg:oauth:2.0:oob`) 플로우를 2023년에 완전히 차단했으므로 "코드를 보여주고 사용자가 붙여넣는" 우회는 provider 측에 존재하지 않는다. redirect 는 반드시 loopback HTTP 로 온다 — 어느 기기의 loopback 인지가 문제의 전부다.

동시에, "원격에서 시킨 경로+쿼리를 PC 의 임의 localhost 포트로 요청"하는 범용 엔드포인트는 그대로 SSRF 프리미티브다. PC 에는 automation 포트(19280/19281)를 비롯한 다른 로컬 서비스가 있다.

## Decision

**Remote 가 열려는 auth URL 의 `redirect_uri` 에서 파싱한 단 하나의 loopback 포트·경로만, 짧은 TTL 의 1회용 세션으로 등록해 GET 한 번을 중계한다.**

- 데스크톱: `POST /remote/v1/oauth-relay/begin` — body `{authUrl, leaseId}`. auth URL 은 https 필수, `redirect_uri` 는 `http://localhost|127.0.0.1|[::1]:{port≥1024}` 만 수용. 포트·경로를 단일 슬롯 세션(uuid, TTL 10분)으로 저장하고 `{sessionId, port, expiresInSeconds}` 반환. 새 begin 은 이전 세션을 대체한다.
- 데스크톱: `POST /remote/v1/oauth-relay/forward` — body `{sessionId, pathAndQuery, leaseId}`. 세션을 **요청 전에 소비**(1회용)하고, pathAndQuery 가 등록된 callback 경로와 정확히 일치(+선택적 `?query`)할 때만 `http://127.0.0.1:{port}{pathAndQuery}` 로 redirect 미추적 GET(connect 3s/total 10s, 응답 64KB 캡)을 보내 `{status, contentType, body}` 를 돌려준다.
- 두 라우트 모두 기존 remote guard(토큰/IP/Origin 또는 릴레이 `TunnelAuthorized`) 뒤 + **active controller lease** 필수. Android E2E exact allowlist 에도 이 두 POST 만 추가.
- Remote 페이지: 터미널 링크가 loopback `redirect_uri` 를 가진 https OAuth URL 이고 lease 를 쥐고 있으면 일반 열기 대신 릴레이 플로우로 진입한다.
  - Android 앱: 네이티브 `beginOauthRelay(sessionId, port, expectedPath, authUrl)` 가 폰의 `127.0.0.1:{port}` 에 1회용 리스너(수명 10분, loopback 바인딩)를 열고 OS 브라우저로 auth URL 을 연다. redirect 가 도착하면 경로가 등록 경로와 일치하는 첫 요청만 WebView JS 로 전달하고(그 외는 로컬 404/409), JS 가 `forward` 로 PC 에 중계한 뒤 응답을 네이티브로 되돌려 브라우저에 그대로 서빙하고 리스너를 닫는다. Content-Type 은 `type/subtype` 토큰으로 정규화해 헤더 주입을 차단한다.
  - 일반 브라우저 remote: 폰 localhost 에 리스너를 둘 수 없으므로, 로그인 후 주소창에 남은 `http://localhost:{port}/...` 전체를 붙여넣는 수동 폴백 모달을 띄워 같은 `forward` 를 태운다.

## Alternatives Considered

- **provider 측 수동 코드(OOB)**: Google 이 폐지. 존재하지 않는 선택지.
- **범용 localhost 프록시 라우트**: 구현은 단순하나 원격 클라이언트에 PC 내부 전 포트를 여는 SSRF. 기각.
- **WebView 내 로그인 후 URL 가로채기**: Google 이 embedded WebView UA 를 차단(`disallowed_useragent`). OS 브라우저 필수라 기각.
- **redirect_uri 재작성(릴레이 도메인으로)**: installed-app client 의 redirect 검증 규칙 밖이고 CLI 리스너도 자기 포트만 기다린다. 기각.

## Consequences

- gcloud/clasp 류 loopback OAuth 를 폰(Android 앱 자동, 브라우저는 URL 복붙 1회)에서 완주할 수 있다.
- authorization code 는 remote 인증 채널(직결 TLS 없음 주의: 직결 HTTP 모드에서는 기존 remote 트래픽과 동일 노출 수준, 릴레이 경유 시 WSS)을 지나 PC 로 간다. code 는 단수명·1회용이고 PKCE 클라이언트면 가로채기 무용. 릴레이 사업자 신뢰 수준은 기존 BrowserAndE2e 모드의 나머지 트래픽과 동일하다.
- forward 는 lease 소유 컨트롤러의 명시적 행위로만 발생하며, 공격 표면은 "사용자가 방금 열려던 auth URL 이 지정한 포트 1개 × GET 1회 × 10분"으로 고정된다.
- 폰 쪽 리스너는 loopback 전용·1회용·10분 수명이라 상시 열린 포트가 생기지 않는다.
- 세션 저장은 데스크톱 프로세스 메모리 단일 슬롯이다. 동시 OAuth 플로우 2개는 지원하지 않는다(마지막 begin 승리) — 단일 사용자 도구 특성상 의도된 제약.
