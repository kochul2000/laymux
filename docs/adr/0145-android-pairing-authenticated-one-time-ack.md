# 0145. Android 페어링은 만료되는 QR v2와 상호 HMAC ACK로 확정한다

- Status: Accepted
- Date: 2026-08-12
- Source: 사용자 요구("서버를 거치는 E2E 암호화의 다음 구현", 실기기 없이 emulator 검증은 후속 허용) · [ADR-0024](0024-cloud-native-wss-tunnel.md) · [ADR-0030](0030-cloud-tunnel-follows-remote-control-gate.md) · [ADR-0144](0144-android-signed-hybrid-client-e2e-foundation.md) · [architecture/api-contracts.md §13](../architecture/api-contracts.md)
- Extends: ADR-0024, ADR-0030, ADR-0144

## Context

ADR-0144의 QR v1은 양 endpoint에 같은 32바이트 seed를 보관하지만, Android가 실제로 스캔했음을 데스크톱이 인증할 방법과 초대의 만료가 없다. 그러므로 화면을 촬영한 두 클라이언트가 같은 seed를 저장할 수 있고, 데스크톱 UI도 "키를 발급함"과 "Android가 키를 확인함"을 구분하지 못한다. 이후 terminal data plane의 방향별 키를 파생하려면 어느 Android client nonce가 이 pairing을 소유하는지도 먼저 하나로 고정해야 한다.

Android가 가진 `endpoint`는 cloud public origin이다. 기존 `/remote/*` relay는 브라우저용 HttpOnly relay cookie가 있어야 요청을 전달하지만 서명된 Android 로컬 앱은 그 쿠키를 갖지 않는다. QR seed를 브라우저 로그인이나 Remote bearer token으로 바꾸면 서로 다른 인증 경계를 합치게 된다. 반대로 relay가 seed를 받아 검증하면 relay가 E2E 인증 재료를 소유하게 된다. 따라서 relay는 고정된 ACK 경로와 bounded body만 해당 instance의 기존 WSS tunnel로 전달하고, proof의 권위는 양 endpoint에 남아야 한다.

HMAC은 [RFC 2104](https://datatracker.ietf.org/doc/html/rfc2104)의 HMAC-SHA-256을 사용하고 binary 값은 [RFC 4648 §5](https://datatracker.ietf.org/doc/html/rfc4648#section-5)의 padding 없는 base64url로 표현한다. 이 단계의 범위는 QR 초대 수명, Android↔desktop 상호 seed 소유 증명, 재시도와 일회성 확정, 양 앱의 상태 표시, relay의 최소 전달 경계다. terminal API payload 암호화, 방향별 data key 파생, frame nonce·replay window·rotation은 비목표다.

## Decision

**Android pairing은 5분 뒤 만료되는 QR v2로 발급하고, relay가 내용을 해석하지 않는 고정 ACK 전달 경로에서 Android와 desktop이 상호 HMAC proof를 검증한 첫 client nonce 하나로 확정한다.**

- QR 계약은 `laymux://pair/v2?endpoint=<origin>&instance=<id>&pairing=<base64url-16-byte-id>&expires=<unix-seconds>&secret=<base64url-32-byte-seed>&label=<optional>`이다. `pairing`은 seed와 독립된 OS CSPRNG 16바이트 식별자고 `expires`는 발급 시점에서 300초 뒤의 Unix epoch seconds다. 필드 누락·중복·미등록 필드·v1을 포함한 다른 버전은 fail closed한다.
- desktop keyring record의 SoT 상태는 `pending` 또는 `confirmed`다. pending record는 pairing id, endpoint, instance, seed, expiry를 가지며 `now >= expires`이면 ACK와 상태 조회에서 권위를 잃고 삭제된다. confirmed record는 처음 수락한 client nonce와 confirmed-at을 추가로 가지며 QR 초대 expiry 뒤에도 후속 E2E seed로 남는다. 새 QR, 명시적 revoke, cloud identity 교체·disconnect는 pending/confirmed 모두 교체 또는 삭제한다.
- Android는 QR seed를 승인된 Keystore wrapping cipher로 저장하는 같은 사용자 작업 안에서 OS CSPRNG client nonce 16바이트를 만들고 ACK request proof를 계산한다. client nonce는 비밀이 아닌 encrypted-envelope metadata로 보관해 네트워크 실패나 앱 재시작 뒤에도 같은 요청을 재구성한다. 저장된 seed로 재시도할 때는 기존 정책대로 매번 강한 생체 인증을 다시 요구하며 명시적 `keystoreOnly` opt-out만 예외다.
- Android는 QR `endpoint`의 `POST /api/android/pair/ack`로 다음 camelCase JSON을 보낸다: `{ version: 1, instanceId, pairingId, clientNonce, clientProof }`. relay는 public origin에서만 이 route를 받고, exact schema·작은 body·IP와 instance별 rate/concurrency limit를 적용한 뒤 온라인인 `instanceId`의 tunnel에 고정된 `POST /remote/v1/e2e/pair/ack`로 전달한다. 임의 target path, request header, query, cookie, Remote token은 Android가 정하지 못한다. relay는 seed를 받거나 proof를 검증·영속·로그하지 않는다.
- request proof는 `HMAC-SHA-256(seed, domain || frame(pairingId) || frame(instanceId) || frame(clientNonce))`다. domain은 UTF-8 `laymux.android-pair.request.v1`, `frame(value)`는 `u32` big-endian UTF-8 byte length 뒤에 value bytes를 붙인 값이다. pairing id와 client nonce는 padding 없는 base64url 16바이트, proof는 padding 없는 base64url 32바이트만 받는다.
- desktop은 lifecycle mutex 안에서 record를 읽고 instance·pairing id·expiry와 request proof를 검증한다. 첫 유효 client nonce를 `confirmed`로 원자적으로 저장한다. 이미 confirmed면 같은 client nonce와 유효 proof는 응답 유실 복구를 위해 같은 confirmed-at으로 성공을 재현하지만, 다른 nonce는 `409`로 거부한다. 없는/불일치 record와 잘못된 proof는 seed 존재 여부를 구분하지 않는 `401`, 일치하지만 만료된 pending record는 삭제 후 `410`이다.
- 성공 응답은 `{ version: 1, instanceId, pairingId, clientNonce, confirmedAt, serverProof }`다. server proof는 request와 같은 framing으로 `HMAC-SHA-256(seed, "laymux.android-pair.response.v1" || frame(pairingId) || frame(instanceId) || frame(clientNonce) || frame(decimal-confirmedAt))`를 계산한다. Android는 모든 echo field와 server proof를 검증한 뒤에만 local metadata를 confirmed로 표시한다. relay는 ACK 성공을 위조할 수 없고 지연·삭제·재전송만 할 수 있다.
- ACK는 기존 cloud tunnel을 재사용하므로 ADR-0030의 Remote enabled gate를 바꾸지 않는다. desktop의 원격 제어가 꺼져 tunnel이 없으면 Android는 pending 상태와 같은 client nonce를 보존하고, 사용자가 원격 제어를 켠 뒤 생체 인증을 거쳐 재시도한다. pending QR의 5분이 지나면 다시 스캔해야 한다.
- desktop UI는 `none`/`pending`/`confirmed`를 구분하고 pending 동안 expiry를 표시하며 backend status를 bounded 간격으로 조회해 ACK 또는 만료를 반영한다. QR SVG는 confirmed·expired·revoke 시 즉시 화면에서 제거한다. Android UI도 key 저장과 desktop confirmation을 구분하고 pending에 명시적 재시도 동작을 제공한다.
- 이 ACK는 seed 소유를 상호 인증할 뿐 terminal traffic을 암호화하지 않는다. 양 UI와 문서는 confirmed를 "E2E 연결 완료"가 아니라 "페어링 확인 완료"로만 표시한다.

## Alternatives Considered

- **기존 browser relay cookie를 Android WebView에서 발급받는다.** Google login과 cross-origin cookie를 앱에 추가해야 하고 QR seed 인증을 사용자 account 세션에 불필요하게 결합한다. 서명된 로컬 앱의 좁은 native transport 경계도 커진다.
- **relay가 seed 또는 seed hash를 저장하고 ACK를 판정한다.** 라우팅은 쉬워지지만 relay 침해자가 새 client를 인증하거나 offline guessing 자료를 얻어 E2E trust boundary가 무너진다.
- **Android가 기존 `/remote/*`를 Remote bearer token으로 호출한다.** QR seed와 local Direct Remote token은 권한과 폐기 주기가 다르다. controller API token을 QR에 추가하면 공격면과 유출 피해가 커진다.
- **ACK 없이 timestamp만 QR에 넣는다.** 정상 앱은 오래된 화면을 거부할 수 있지만 desktop이 실제 사용 여부와 승자를 알지 못한다. QR bearer를 얻은 공격자는 Android-side timestamp 검사도 우회할 수 있어 authoritative expiry와 one-time claim이 되지 않는다.
- **성공 즉시 desktop에서 seed를 삭제한다.** 후속 E2E data key를 양 endpoint가 다시 파생할 입력이 사라진다. 초대만 소비하고 confirmed record의 seed는 명시적 revoke/identity 교체까지 보존한다.
- **confirmed 뒤 모든 유효 nonce의 재확정을 허용한다.** 응답 유실 복구는 쉽지만 QR을 본 여러 클라이언트가 차례로 owner가 될 수 있다. 첫 nonce만 고정하고 같은 nonce의 idempotent replay만 허용한다.
- **단일 HMAC을 request와 response에 재사용한다.** relay가 request proof를 response로 반사할 여지를 만들고 메시지 역할이 불명확하다. domain separation과 response의 confirmed-at binding으로 방향을 분리한다.

## Consequences

- QR screenshot의 유효 시간과 first-winner가 desktop에서 권위 있게 제한되고, Android는 relay 응답이 실제 seed 보유 desktop에서 왔음을 확인한다. relay는 payload를 읽고 재전송할 수 있지만 proof를 위조하거나 다른 instance/pairing/nonce로 바꿀 수 없다.
- QR을 같은 5분 안에 본 공격자는 정당한 사용자보다 먼저 claim할 수 있다. QR은 여전히 out-of-band bearer secret이므로 화면 노출 통제와 짧은 수명이 필요하며, 사람이 두 endpoint fingerprint를 대조하는 별도 UX는 이번 범위가 아니다.
- remote control이 꺼졌거나 PC가 offline이면 최초 ACK가 실패한다. Android는 같은 nonce를 저장하고 재시도하지만 5분이 지나기 전에 desktop tunnel이 살아나지 않으면 새 QR이 필요하다.
- server에는 인증 쿠키 없는 공개 route가 하나 생긴다. exact schema/route, bounded body, rate·concurrency limit, 온라인 registry lookup만 허용하고 desktop HMAC 검증 전에는 어떤 권한도 부여하지 않는다. 다중 노드의 shared rate limit은 기존 server 한계와 함께 후속 운영 과제다.
- 기존 QR v1과 Android envelope/desktop record는 내부 개발 단계의 비호환 데이터로 취급하며 마이그레이션하지 않는다. 사용자는 update 뒤 새 QR로 다시 pairing한다.
- 자동 검증은 공통 HMAC test vector, Rust expiry·first-winner·idempotent replay, Android QR/parser·response proof·metadata 상태, relay cookie 없는 fixed-path round trip과 body/rate limit을 포함한다. emulator/실기기의 Google Code Scanner·BiometricPrompt·Keystore instrumentation과 실제 배포 origin round trip은 장비가 준비될 때 수행한다.
- 재검토 조건은 terminal data plane key schedule/AEAD frame 결정, 다중 Android 기기, human-verifiable fingerprint, QR TTL 조정, 다중-node relay shared limiter다.
