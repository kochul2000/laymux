# 0160. Android E2E는 Tailscale Direct를 우선 전송 경로로 사용한다

- Status: Accepted
- Date: 2026-08-16
- Source: 사용자 요구("우선은 안드로이드에서 tailscale 지원하는 기능을 넣자") · [ADR-0139](0139-cloud-tunnel-tailscale-route-advertisement-and-direct-gate.md) · [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md) · [ADR-0159](0159-android-e2e-websocket-output-transport.md)
- Extends: ADR-0139, ADR-0146, ADR-0149, ADR-0159

## Context

Android 앱의 Remote 데이터 평면은 Cloud relay의 고정 HTTPS/WSS route를 통해서만 PC와 통신한다. pairing seed에서 파생한 방향별 AEAD key가 control/resource RPC와 terminal output을 종단 암호화하므로 relay는 plaintext를 볼 수 없지만, 앱과 PC가 같은 Tailnet에 있어도 모든 ciphertext가 relay를 왕복한다. 반면 기존 Tailscale Direct Remote는 브라우저가 PC의 HTTP/WebSocket API에 bearer token으로 접속하는 별도 평문 application 경로라 Android native key 경계와 E2E session을 재사용하지 않는다.

Cloud heartbeat는 이미 현재 PC의 Tailscale URL을 비영속 presence로 광고한다. 이 값은 relay가 전달하므로 신뢰할 capability나 PC 신원 증명이 될 수 없지만, Android가 연결을 시도할 routing hint로는 쓸 수 있다. 최종 PC 신원과 session 권한은 기존 pairing HMAC challenge/establish와 AEAD 검증이 증명해야 한다. Tailscale Direct listener는 TLS를 종단하지 않으므로 native HTTP/WebSocket은 cleartext application transport지만, 패킷 구간은 Tailscale WireGuard가 보호하고 Remote payload는 기존 AEAD가 별도로 종단 암호화한다.

범위는 이미 Cloud에서 확인된 Android pairing을 이용한 Tailscale Direct session·RPC·output과 Cloud fallback이다. 브라우저 Remote의 E2E 전환, LAN Direct, Tailscale 설치·로그인 자동화, MagicDNS/`tailscale cert`, Cloud 없이 새 pairing을 만드는 흐름은 비목표다.

## Decision

**Android 앱은 Cloud presence가 제공한 검증된 형식의 Tailscale URL이 있으면 기존 pairing 기반 E2E protocol을 PC의 고정 Direct route로 먼저 운반하고, 최초 연결 또는 열린 session의 Direct 네트워크가 실패할 때만 같은 pairing으로 새 Cloud E2E session을 연다.**

- Android의 pairing seed, HMAC challenge/establish, HKDF session key, 순차 AEAD RPC, stream별 AEAD output 계약은 transport와 무관한 단일 SoT다. Direct 시도와 Cloud fallback은 서로 다른 `clientSessionNonce`와 새 session을 사용하며 한 session을 두 transport에서 이어 쓰지 않는다.
- Cloud dashboard의 Android 연결 action은 `instanceId`와 현재 presence의 선택적 `tailscaleUrl`을 native bridge에 전달한다. URL은 capability가 아닌 비신뢰 routing hint다. Android는 scheme `http`, Tailscale IPv4 `100.64.0.0/10` 또는 IPv6 `fd7a:115c:a1e0::/48`, release/dev 고정 포트, exact `/remote/`, userinfo/query/fragment 부재를 모두 다시 검증한다. 빈 값은 hint 없음이지만, 비어 있지 않고 잘못된 값은 Cloud로 바꾸지 않고 PC 선택을 fail closed한다. handshake 응답의 기존 pairing proof와 instance echo가 최종 PC 신원을 인증한다.
- Desktop은 Tailscale source IP에서 Origin 없이 온 exact Android E2E route만 bearer token 없이 받는다: session challenge/establish/RPC와 encrypted output WebSocket. 기존 bearer가 있는 요청은 Direct 우회로 분류하지 않고 common enabled/IP/Origin/token gate를 계속 타므로 Python connector의 loopback HTTP 경로를 유지한다. Remote enabled gate, body/registry/stream 상한, pairing/session/AEAD 검증은 유지한다. 일반 `/remote/` 문서·자산·브라우저 API는 기존 allowed IP·Origin·bearer 정책을 그대로 사용한다.
- Android Direct control/resource는 `/remote/v1/e2e/session/{challenge,establish}`와 `/remote/v1/e2e/rpc`, output은 `/remote/v1/e2e/output`을 사용한다. Cloud transport는 기존 `/api/android/e2e/*` public route를 유지한다. Cloud account WebView는 native에 넘길 선택적 routing hint만 DOM에서 보지만, route 매핑과 endpoint 조립은 native transport adapter가 소유하고 secure Remote WebView에는 URL, key, ciphertext 또는 network authority를 노출하지 않는다.
- Android release는 native Tailscale E2E transport를 위해 cleartext HTTP/WebSocket을 허용한다. 앱 코드는 Tailscale literal IP와 고정 포트를 통과한 endpoint만 native transport에 전달하며 Cloud WebView와 secure WebView의 navigation allowlist는 HTTP navigation을 계속 거부한다. application payload의 기밀성·무결성은 TLS가 아니라 기존 AEAD가 보장한다.
- 자동 fallback은 연결 거부·도달 불가·literal-IP socket timeout 같은 Direct 네트워크 실패에만 허용한다. HTTP policy/auth 오류, instance/proof 불일치, malformed response, AEAD/sequence 오류에는 Cloud로 fallback하지 않고 fail closed한다. 최초 Direct 실패 중 cancel/background generation이 바뀌면 Cloud 요청을 시작하지 않는다. 열린 Direct session의 RPC 또는 output socket에 network failure가 나면 session·stream을 폐기하고 Cloud-only 재연결을 시작한다. pairing seed를 session 수명 동안 추가 보존하지 않으므로 새 handshake는 vault의 현재 보호 정책에 따라 생체 인증을 다시 요구할 수 있다. 성공하면 PC 문서와 output snapshot을 새로 적재한다.
- UI의 주 보안 표시는 두 경로 모두 `종단간 암호화`다. transport를 사용자가 고르거나 서로 다른 보안 등급으로 보이지 않으며, native `RemoteSession`은 운영 진단을 위해 실제 transport kind를 유지한다. Cloud의 `cloudAccessMode`는 계속 Cloud tunnel 입구만 제어하며 Tailscale Direct E2E에는 적용하지 않는다.

## Alternatives Considered

- **Android WebView가 기존 browser Direct URL과 bearer token을 연다.** 구현은 작지만 Remote plaintext와 장기 bearer를 앱에 추가하고 native Keystore/E2E 경계를 우회하므로 기각했다.
- **Tailscale URL을 QR과 pairing vault에 영속한다.** Cloud 없이도 후보를 얻지만 Tailscale 주소 변경 뒤 stale route가 남고 비밀 pairing record와 일시적 presence를 결합하므로 기각했다.
- **Direct에도 HTTPS를 강제한다.** 명확한 secure-context를 주지만 MagicDNS, 인증서 발급·갱신, Rust TLS 종단과 이름 검증을 함께 도입해야 한다. E2E payload 기밀성에 필수는 아니므로 후속 결정으로 남긴다.
- **어떤 Direct 실패에도 조용히 Cloud로 fallback한다.** 공격·설정 오류·protocol drift를 네트워크 장애처럼 숨겨 fail-open 진단이 되므로 네트워크 실패만 허용한다.
- **사용자가 연결할 때마다 Direct/Cloud를 고른다.** 전송 경로가 보안 수준 선택처럼 보이고 일상 연결을 복잡하게 하므로 자동 Direct 우선을 택한다.

## Consequences

- 같은 Tailnet에서는 terminal ciphertext가 relay를 우회해 지연·relay 대역폭을 줄이고, 실패 시 기존 Cloud E2E 가용성을 유지한다. 두 경로의 WebView UI와 application protocol은 동일하다.
- Cloud dashboard/Android bridge와 desktop/Android route mapping을 함께 배포해야 한다. 구버전 Cloud는 Tailscale hint를 생략해 기존 Cloud E2E로 동작하고, 구버전 Android는 새 bridge action을 모르므로 Cloud JavaScript가 기존 `selectInstance`로 fallback해야 한다.
- bearer 없는 Direct challenge route가 Tailnet peer에 노출되지만 challenge registry·body 상한이 bounded이고 session 생성·데이터 접근에는 pairing proof가 필요하다. 실제 운용에서 인증 시도 부하가 관측되면 source별 rate limiter를 후속으로 추가한다.
- release manifest가 cleartext native socket을 허용하므로 모든 endpoint 생성은 중앙 validator를 거쳐야 하고 WebView navigation 정책의 HTTP 거부 회귀 테스트를 유지한다.
- 자동 검증은 Tailscale URL/CIDR/포트/path 검증, 빈 hint와 invalid hint 구분, exact Direct route gate, 일반 browser·Python connector bearer 회귀, transport별 HTTP/WS URL, cancel 후 Cloud 요청 금지, 네트워크 실패에만 최초·열린 session fallback, 새 session nonce, E2E tamper fail-closed를 포함한다. 실기기에서는 같은 Tailnet의 dev PC로 Direct 연결·입력·출력 후 Tailscale을 끈 Cloud fallback을 검증한다.
