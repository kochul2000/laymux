# 0150. Cloud Remote 접속 정책은 PC Laymux가 소유하고 터널 입구에서 강제한다

- Status: Accepted
- Date: 2026-08-12
- Source: 사용자 요구("세팅에서 앱을 통한 종단 암호화만 허용할지, 단순 등록도 허용할지 사용자가 정한다", "laymux-server cloud는 철저히 중계만") · [ADR-0024](0024-cloud-native-wss-tunnel.md) · [ADR-0139](0139-cloud-tunnel-tailscale-route-advertisement-and-direct-gate.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)
- Extends: [ADR-0024](0024-cloud-native-wss-tunnel.md), [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)

## Context

기존 Cloud Remote는 로그인한 브라우저가 relay cookie로 PC의 WSS tunnel에 평문 Remote HTTP/WebSocket stream을 연다. Android wrapper는 같은 Cloud 계정과 PC presence를 사용하지만 terminal 데이터는 QR로 합의한 키와 생체 승인 session으로 E2E 암호화한다. 두 경로를 항상 함께 허용하면 사용자가 Android E2E만 신뢰하고 싶어도 일반 Cloud 브라우저 경로가 계속 열린다.

Cloud 서버는 사용자 PC가 선택한 정책을 대시보드에 표시하고 불필요한 연결을 일찍 거절할 수 있지만, terminal plaintext의 최종 권한 경계가 될 수 없다. 서버가 오래되거나 잘못 동작하거나 침해되어도 PC가 허용하지 않은 평문 stream을 열 수 없어야 한다. 반대로 PC에 직접 도달하는 Local/Tailscale Remote는 Cloud relay 경로와 인증 경계가 다르므로 이번 선택에 묶지 않는다.

범위는 계정에 등록된 한 PC의 Cloud WSS tunnel을 통한 일반 브라우저 Remote와 Android E2E route다. Cloud 로그인·PC 등록·presence, QR pairing, Android E2E session, Local/Tailscale Direct Remote는 유지한다. 브라우저 자체의 E2E 전환과 계정 단위 중앙 정책은 비목표다.

## Decision

**`settings.json`의 PC별 `cloudAccessMode`를 정책의 진실원으로 두고, `androidE2eOnly`에서는 PC Laymux가 Cloud tunnel의 고정 Android E2E HTTP 경로 네 개만 허용하며 일반 HTTP/WebSocket stream을 거부한다.**

- `settings.remote.cloudAccessMode`는 `browserAndE2e`와 `androidE2eOnly` 두 값을 가진다. 기존 설정 파일에 필드가 없을 때의 기본값은 호환 모드인 `browserAndE2e`다.
- `androidE2eOnly`의 tunnel allowlist는 빈 query를 가진 `POST /remote/v1/e2e/pair/ack`, `POST /remote/v1/e2e/session/challenge`, `POST /remote/v1/e2e/session/establish`, `POST /remote/v1/e2e/rpc`의 exact match뿐이다. 모든 WebSocket, 일반 Remote 문서·자산·API, 다른 method/path/query는 PC에서 non-retryable policy error로 거절한다.
- 설정 저장으로 mode가 바뀌면 실행 중인 Cloud tunnel을 즉시 끊고 같은 pairing credential로 다시 연결한다. 따라서 이미 열린 일반 HTTP/WebSocket stream과 controller lease heartbeat도 종료되고, 새 연결의 첫 heartbeat가 새 mode를 광고한다. 실행 중인 tunnel이 없으면 설정 저장이 임의로 Cloud 연결을 시작하지 않는다.
- heartbeat payload는 `cloudAccessMode`를 보낸다. relay registry는 현재 connection에만 이 값을 보관하며 DB나 계정 정책으로 영속하지 않는다. 새 값이 오기 전에는 브라우저 Remote를 허용하지 않고, 구버전 desktop의 heartbeat에 필드가 없을 때만 `browserAndE2e`로 해석한다. 알 수 없는 명시 값은 fail closed한다.
- Cloud dashboard는 일반 브라우저에서 `androidE2eOnly`인 online PC의 relay Connect를 제공하지 않고 정책 안내를 표시한다. Android app-mode dashboard의 native PC 선택은 계속 제공한다. Tailscale Direct 버튼도 계속 제공한다.
- Cloud의 `/app/connect`, 기존 active browser session, relay credential은 요청마다 live registry mode를 다시 확인해 `androidE2eOnly`를 거부한다. 이는 UX와 부수 방어이며, 보안 권위는 PC tunnel 입구의 exact allowlist다.
- Cloud 로그인·기기 등록·online 표시와 Android public E2E relay route에는 이 브라우저 정책을 적용하지 않는다. relay는 E2E ciphertext를 해석하거나 key를 소유하지 않는다.

## Alternatives Considered

- **Cloud 서버 설정만으로 차단한다.** 대시보드 UX는 단순하지만 신뢰하지 않는 relay가 정책을 우회하면 평문 stream이 PC까지 도달하므로 기각했다.
- **Cloud tunnel 자체를 끈다.** 일반 브라우저는 막히지만 같은 tunnel이 운반하는 Android pairing ACK와 E2E ciphertext도 끊겨 목적을 달성하지 못한다.
- **모든 원격 접속을 Android E2E 전용으로 고정한다.** 가장 좁지만 기존 Cloud 브라우저 Remote 사용자를 깨뜨리고 사용자가 선택한다는 요구를 없애므로 기본값으로 선택하지 않았다.
- **Local/Tailscale Direct Remote도 함께 차단한다.** Cloud 중계 신뢰 선택과 사용자가 직접 관리하는 네트워크·token 경계를 섞으므로 이번 정책에서 제외했다.
- **기존 stream은 두고 새 stream만 막는다.** 설정을 바꾼 뒤 이미 열린 브라우저 WebSocket이 계속 terminal output과 입력을 운반할 수 있어 즉시 적용이라는 사용자 기대와 맞지 않으므로 tunnel을 재연결한다.

## Consequences

- 사용자는 PC별로 기존 Cloud 브라우저 편의와 Android E2E 전용 경계 중 하나를 선택할 수 있다. 기본값은 기존 동작을 보존한다.
- mode 변경 순간 실행 중인 Cloud Remote가 끊긴다. Android도 현재 tunnel transport가 잠깐 끊길 수 있지만 재연결 뒤 pairing을 다시 스캔하지 않고 새 E2E session을 열 수 있다.
- desktop과 relay가 공유하는 heartbeat 계약, dashboard 표시, browser credential 검사가 함께 배포되어야 한다. 배포 순서가 엇갈려도 desktop exact allowlist가 최종 차단을 보장하며, 구버전 desktop은 기존 browser 허용으로 동작한다.
- 자동 검증은 설정 기본값/직렬화, exact method·path·query allowlist, mode 변경 시 tunnel 재시작, heartbeat 광고, dashboard의 browser/Android/Tailscale 분기, connect와 기존 credential의 live 재검사를 포함한다.
- 향후 browser E2E가 도입되거나 여러 Android pairing을 지원할 때 allowlist와 mode enum을 새 ADR로 확장한다.
