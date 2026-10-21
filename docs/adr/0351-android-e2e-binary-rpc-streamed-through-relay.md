# 0351. Android E2E RPC 요청은 binary envelope로 보내고 Cloud relay는 body를 버퍼하지 않고 흘려보낸다

- Status: Proposed
- Date: 2026-10-21
- Source: 사용자 요구("Cloud를 거치면 첨부가 10 MiB가 아니라 1 MiB다", "스트리밍 하면 안돼?", "B로 가자") · [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md) · [ADR-0172](0172-android-e2e-compat-version-gate.md) · [ADR-0227](0227-remote-document-attachments.md) · laymux-server `app/routers/proxy.py`
- Extends: ADR-0146(요청 envelope wire 형식), ADR-0227(Cloud relay 경로의 Android 첨부 상한)

## Context

ADR-0227은 Remote 첨부 상한을 host settings에서 10 MiB까지 올릴 수 있게 했지만, Android 앱이 Cloud relay로 접속하면 실효 상한이 1 MiB로 묶인다. 원인은 relay의 `ANDROID_E2E_RPC_BODY_LIMIT`(2 MiB)다. Android E2E RPC 요청은 첨부를 base64로 담은 inner JSON을 AEAD로 봉인한 뒤 base64url로 한 번 더 감싸 JSON envelope(`{version, instanceId, sessionId, sequence, ciphertext}`)에 넣는다. base64가 두 겹이라 10 MiB 첨부는 약 17.8 MiB envelope가 되고, 2 MiB 안에는 1 MiB 첨부만 들어간다.

relay 상한을 그대로 올리면 비용이 아니라 메모리가 문제다. 브라우저 tunnel 경로는 body를 ASGI chunk 단위로 desktop에 흘려보내지만, Android E2E 경로는 라우팅·rate limit에 필요한 `instanceId`가 JSON body 안에 있어 body 전체를 `bytearray`로 받은 뒤 pydantic으로 검증하고 `model_dump`·`json.dumps`로 재직렬화한다. 요청 하나가 envelope의 몇 배를 순간 점유하고(17.8 MiB envelope에서 수십 MiB 단위), relay는 1 GiB 인스턴스에서 Postgres와 함께 돌며 사용자당 동시 요청을 64개까지 허용한다. 큰 첨부 몇 개가 겹치면 relay 전체가 OOM으로 죽는다. 반면 egress 비용은 첨부 한 건에 수십 MiB 수준이라 결정 요인이 아니다.

desktop은 원래 raw body를 받아 envelope를 직접 파싱하므로(`android_e2e_routes.rs`) relay의 재직렬화는 desktop에 필요한 일이 아니다. E2E 위협 모델에서 relay는 신뢰 대상이 아니며 실제 경계는 desktop의 AEAD 검증이다.

범위는 Android → desktop RPC **요청** 방향의 wire 형식과 relay 처리다. 응답 envelope(desktop → Android, relay 6 MiB 버퍼), output WebSocket(ADR-0159), handshake·pairing, inner plaintext 안 첨부의 base64 인코딩, 크기 은닉 padding은 비목표다.

## Decision

**Android E2E RPC 요청 body를 binary envelope로 바꾸고, relay가 알아야 하는 `instanceId`만 HTTP header로 올린다. relay는 header로 라우팅·rate limit을 끝낸 뒤 body를 파싱하지 않고 tunnel stream으로 그대로 흘려보낸다.**

- **요청 wire 형식** (`Content-Type: application/octet-stream`, Cloud·Tailscale Direct 공통):

  | offset | 길이 | 내용 |
  |---|---|---|
  | 0 | 1 | envelope 형식 번호 `2` |
  | 1 | 22 | `sessionId` (base64url ASCII, 기존과 같은 22자) |
  | 23 | 8 | `sequence` (u64 big-endian, 기존 범위 검증 유지) |
  | 31 | 나머지 | AES-256-GCM ciphertext‖tag (raw bytes, base64 없음) |

- **AEAD는 그대로다.** 키, sequence nonce, A2D AAD 도메인과 AAD 구성(`instanceId`·`sessionId`·`sequence` framing)을 바꾸지 않는다. 바뀌는 것은 ciphertext의 운반 인코딩뿐이다.
- **`instanceId`는 body에 없다.** Android는 `X-Laymux-E2e-Instance` header로 보낸다. relay는 이 값만 쓰고 desktop으로 넘기지 않는다. desktop은 `sessionId`로 세션을 찾고 AAD의 `instanceId`를 요청이 아닌 그 세션에 묶인 instance id로 채운다. relay가 다른 desktop으로 잘못 보내거나 header를 조작하면 desktop에서 AEAD 인증이 실패한다.
- **relay 계약**:
  - 새 public route에서 header의 `instanceId` 형식을 검증하고 IP·instance rate limit과 proxy capacity를 **body를 읽기 전에** 적용한다.
  - body는 브라우저 tunnel 경로와 같은 chunk 전달로 흘려보낸다. relay는 body를 버퍼·파싱·재직렬화하지 않고 바이트 수만 센다. 요청 하나가 relay에 남기는 메모리는 chunk 크기 수준이다.
  - 요청 상한은 `TUNNEL_HTTP_REQUEST_BYTES_LIMIT`(16 MiB)다. 초과하면 stream을 취소하고 413을 낸다.
  - 기존 JSON route(`/api/android/e2e/rpc`)와 2 MiB 상한은 구버전 앱 + 구버전 desktop 조합을 위해 유지하고, 그 조합이 사라지면 별도 변경으로 제거한다.
- **desktop 계약**: `/remote/v1/e2e/rpc`는 binary envelope만 받는다. body 상한은 host `attachmentMaxMib`에서 매 요청 계산하는 방식(ADR-0227)을 유지하되, base64 한 겹이 빠진 산술(첨부 JSON cap + wrapper slack + tag + prefix)로 줄인다. AEAD는 single-shot이므로 desktop은 계속 body 전체를 받은 뒤 복호화한다.
- **relay 미러 상수**: Android E2E Cloud 경로의 relay 상한 미러를 16 MiB에서 유도한다. 16 MiB에서 prefix·tag·slack·base64 한 겹을 벗기면 약 11.9 MiB로 host 최대 10 MiB보다 커서 구속하지 않는다. Android 앱도 Cloud 경로에서 host 설정 상한까지 첨부한다.
- **호환성**: wire 형식 변경은 ADR-0172의 비호환 변경이다. desktop `COMPAT_VERSION`과 앱 `E2eProtocol.COMPAT_VERSION`을 함께 2로 올린다. 한쪽만 업데이트된 조합은 challenge 단계에서 방향에 맞는 업데이트 안내로 거부되므로 desktop은 JSON envelope를 병행 지원하지 않는다.
- **배포 순서**: relay에 새 route를 먼저 배포한 뒤 desktop과 앱을 릴리스한다.
- **relay가 보는 정보**는 기존과 같다: `instanceId`·`sessionId`·`sequence`, body 크기, 요청 시각. 첨부 바이트·파일명·터미널 입력을 포함한 요청 내용은 계속 암호문이다.

## Alternatives Considered

- **JSON envelope를 유지하고 `instanceId`만 header로 올려 스트리밍(A안)**: 앱·relay 변경만으로 끝나지만, base64 두 겹 때문에 10 MiB 첨부가 약 17.8 MiB가 되어 relay·desktop tunnel의 16 MiB 상한을 둘 다 올려야 한다. 트래픽도 base64 한 겹만큼(약 33%) 크다.
- **relay 상한만 18 MiB로 올리기**: 구현은 상수 하나지만 위 메모리 증폭이 그대로 남아 1 GiB 인스턴스에서 OOM 위험을 만든다. 인스턴스를 키우는 것은 증상만 미룬다.
- **relay가 JSON을 incremental parse**: JSON 필드 순서가 보장되지 않아 `instanceId`가 끝에 오면 결국 버퍼해야 한다. 파서 복잡도에 비해 얻는 것이 없다.
- **`instanceId`도 binary prefix에 넣기**: header 없이 body 하나로 끝나지만 relay가 body 앞부분을 엿보고 다시 이어 붙여야 한다. header가 relay의 "body를 보지 않는다" 불변식을 단순하게 지킨다.
- **`sessionId`·`sequence`도 header로**: desktop tunnel은 E2E 경로의 header를 계약에 넣지 않고 relay도 넘기지 않는다. AAD 재구성에 필요한 값은 body에 있어야 desktop이 transport와 무관하게 같은 방식으로 검증한다.
- **chunked upload**: 메모리 문제를 desktop까지 근본적으로 없애지만 재조립 상태·실패 cleanup·sequence 의미를 새로 설계해야 한다. 10 MiB는 단일 요청으로 충분하다(ADR-0227의 판단 유지).
- **desktop이 JSON·binary를 병행 수용**: 구 앱 지원 기간을 늘리지만 compat gate가 이미 불일치 조합을 명확히 거부하므로 두 파서를 유지할 이유가 없다.

## Consequences

- Android 앱이 Cloud relay로 접속해도 host가 정한 첨부 상한(최대 10 MiB)을 쓸 수 있다. Tailscale 안내는 relay가 실제로 구속할 때만 남는다.
- relay의 Android E2E 요청 메모리가 envelope 크기에 비례하지 않게 된다. relay 인스턴스 크기를 이 기능 때문에 키우지 않는다.
- 같은 첨부의 요청 body가 약 25% 작아져 relay egress와 모바일 업로드가 줄어든다. desktop은 base64 decode 복사본이 없어진다.
- relay는 Android E2E 요청 body의 스키마 검증을 하지 않는다. 잘못된 body는 desktop이 prefix 검증과 AEAD에서 거부한다. relay에 남는 방어선은 header 형식, rate limit, capacity, 바이트 상한이다.
- compat 번호가 2로 오르므로 desktop과 앱 중 하나만 업데이트한 사용자는 연결 시 업데이트 안내를 받는다.
- relay는 구 JSON route를 한동안 유지한다. 제거 시점은 구버전 앱·desktop 비중을 보고 정한다.
- 구현 시 함께 바꿀 것: laymux-server proxy route·`docs/tunnel-protocol.md`, desktop `android_e2e` envelope 파서·`android_e2e_rpc_body_limit`·`CLOUD_RELAY_ANDROID_E2E_RPC_BODY_LIMIT` 미러, Android `E2eTransport`·native bridge body 상한, `docs/architecture/api-contracts.md`의 Android E2E RPC 절.
- 테스트: prefix 경계(짧은 body, 잘못된 형식 번호·sessionId 길이), instance id를 바꾼 AAD 실패, 최대 첨부가 desktop body 상한과 relay 16 MiB 안에 드는지의 산술, relay가 body를 읽기 전에 rate limit으로 거부하는지, 상한 초과 시 stream 취소와 413, compat 불일치 안내.
- 재검토 조건: 응답 방향에도 큰 payload가 생기거나 첨부 상한을 relay 16 MiB 너머로 올리려 할 때는 chunked 전송을 새 ADR로 검토한다.
