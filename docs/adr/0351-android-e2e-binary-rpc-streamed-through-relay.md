# 0351. Android E2E RPC 요청은 binary envelope로 보내고 Cloud relay는 body를 버퍼하지 않고 흘려보낸다

- Status: Accepted (조기 거부 응답 조항은 [0352](0352-android-e2e-early-rejection-drains-body.md)가, relay 요청 상한 16 MiB는 [0353](0353-remote-attachment-16mib-default.md)이 정정)
- Date: 2026-10-21
- Source: 사용자 요구("Cloud를 거치면 첨부가 10 MiB가 아니라 1 MiB다", "스트리밍 하면 안돼?", "B로 가자") · [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md) · [ADR-0172](0172-android-e2e-compat-version-gate.md) · [ADR-0227](0227-remote-document-attachments.md) · laymux-server `app/routers/proxy.py`
- Extends: ADR-0146(요청 envelope wire 형식), ADR-0227(Cloud relay 경로의 Android 첨부 상한)

## Context

ADR-0227은 Remote 첨부 상한을 host settings에서 10 MiB까지 올릴 수 있게 했지만, Android 앱이 Cloud relay로 접속하면 실효 상한이 1 MiB로 묶인다. 원인은 relay의 `ANDROID_E2E_RPC_BODY_LIMIT`(2 MiB)다. Android E2E RPC 요청은 첨부를 base64로 담은 inner JSON을 AEAD로 봉인한 뒤 base64url로 한 번 더 감싸 JSON envelope(`{version, instanceId, sessionId, sequence, ciphertext}`)에 넣는다. base64가 두 겹이라 10 MiB 첨부는 약 17.8 MiB envelope가 되고, 2 MiB 안에는 1 MiB 첨부만 들어간다.

relay 상한을 그대로 올리면 비용이 아니라 메모리가 문제다. 브라우저 tunnel 경로는 body를 ASGI chunk 단위로 desktop에 흘려보내지만, Android E2E 경로는 라우팅·rate limit에 필요한 `instanceId`가 JSON body 안에 있어 body 전체를 `bytearray`로 받은 뒤 pydantic으로 검증하고 `model_dump`·`json.dumps`로 재직렬화한다. 요청 하나가 envelope의 약 3배를 순간 점유한다. relay는 1 GiB 인스턴스에서 Postgres와 함께 돌고, 기본 설정에서 proxy 동시 요청을 instance당 64개·IP당 128개까지 허용한다. 큰 첨부 몇 개가 겹치면 relay 전체가 OOM으로 죽는다. 반면 egress 비용은 첨부 한 건에 수십 MiB 수준이라 결정 요인이 아니다.

desktop은 원래 raw body를 받아 envelope를 직접 파싱하므로(`android_e2e_routes.rs`) relay의 재직렬화는 desktop에 필요한 일이 아니다. E2E 위협 모델에서 relay는 신뢰 대상이 아니며 실제 경계는 desktop의 AEAD 검증이다.

relay의 2 MiB 상한은 그동안 의도치 않은 방어선 두 개도 겸했다. (1) desktop tunnel은 stream마다 host 설정과 무관하게 16 MiB까지 body를 모은 뒤 route로 넘기므로, 세션 검증 전 버퍼를 host 상한으로 묶는다는 ADR-0227 Decision 5(a)는 relay 2 MiB 덕분에 Cloud Android 경로에서 사실상 지켜졌다. (2) relay는 body를 다 받은 뒤에 proxy capacity와 tunnel stream을 잡으므로 느린 body가 슬롯을 점유할 수 없었다. 스트리밍으로 바꾸면 두 방어선이 사라지므로 이 결정이 함께 대체해야 한다.

범위는 Android → desktop RPC **요청** 방향의 wire 형식, relay 처리, 그에 따른 desktop 수신 경계다. 응답 envelope(desktop → Android, relay 6 MiB 버퍼), output WebSocket(ADR-0159), handshake·pairing, inner plaintext 안 첨부의 base64 인코딩, 크기 은닉 padding은 비목표다.

## Decision

**Android E2E RPC 요청 body를 binary envelope로 바꾸고, relay가 알아야 하는 `instanceId`만 HTTP header로 올린다. relay는 header로 라우팅·rate limit을 끝낸 뒤 body를 파싱하지 않고 tunnel stream으로 흘려보내며, desktop은 세션 검증 전 버퍼를 host 상한으로 묶고 prefix로 조기 거부한다.**

### Wire 형식

`Content-Type: application/octet-stream`, Cloud·Tailscale Direct 공통:

| offset | 길이 | 내용 |
|---|---|---|
| 0 | 1 | 요청 envelope 형식 번호 `2` |
| 1 | 22 | `sessionId` (base64url ASCII, 기존과 같은 22자) |
| 23 | 8 | `sequence` (u64 big-endian, 기존 범위 검증 유지) |
| 31 | 나머지 | AES-256-GCM ciphertext‖tag (raw bytes, base64 없음) |

- 형식 번호는 새 상수(요청 envelope 형식)다. handshake·응답 envelope가 쓰는 `PROTOCOL_VERSION`(1)과 ADR-0172의 `COMPAT_VERSION`과 별개다. desktop 파서는 `2`만 받는다. 형식 번호는 AEAD 인증 대상이 아니지만, 단일 값만 허용하므로 조작해도 거부될 뿐이다.
- **AEAD는 그대로다.** 키, sequence nonce, A2D AAD 도메인, AAD의 version byte(1), `instanceId`·`sessionId`·`sequence` framing을 바꾸지 않는다. 바뀌는 것은 ciphertext의 운반 인코딩뿐이다.
- **`instanceId`는 body에 없다.** Android는 Cloud·Direct 모두 `X-Laymux-E2e-Instance` header로 보낸다. relay만 이 값을 쓰고 desktop으로 넘기지 않는다. desktop은 이 header를 무시한다. desktop은 `sessionId`로 세션을 찾고, AAD의 `instanceId`를 요청이 아닌 그 세션에 묶인 instance id로 채운다. relay가 다른 desktop으로 잘못 보내면 세션 조회에서, header나 body를 조작하면 AEAD 인증에서 실패한다.

### relay 계약 (laymux-server)

- 새 route는 `POST /api/android/e2e/rpc/binary`이고, desktop `POST /remote/v1/e2e/rpc`로 전달한다.
- body를 읽기 전에 처리하는 것:
  - header `instanceId` 형식 검증
  - IP·instance rate limit
  - 이 route 전용 동시 실행 상한. 브라우저·다른 Android 경로의 proxy capacity와 별도로 세며, instance당 64보다 작게 둔다.
  - `Content-Length`가 있으면 사전 검사
- body는 브라우저 tunnel 경로와 같은 chunk 전달로 흘려보낸다. relay는 body를 버퍼·파싱·재직렬화하지 않는다. 요청 하나가 relay에 남기는 메모리는 chunk 크기 수준이다.
- 바이트 상한은 `TUNNEL_HTTP_REQUEST_BYTES_LIMIT`(16 MiB)이고, `Content-Length` 유무나 chunked 전송과 무관하게 누적 바이트로 강제한다.
- body 수신에는 idle 시간과 총 시간 deadline을 둔다. 다음 경우에는 body 읽기를 중단하고 tunnel stream을 취소한 뒤 rate·capacity lease를 즉시 회수한다:
  - deadline 초과
  - 바이트 상한 초과 (413)
  - 클라이언트 연결 종료
  - desktop의 조기 거부
- desktop으로 여는 stream은 클라이언트 header를 전달하지 않는다. relay가 고정 header를 직접 구성한다: 요청 `Content-Type: application/octet-stream`, `Accept: application/json` (응답은 기존 JSON `CipherEnvelope`).
- 기존 JSON route(`/api/android/e2e/rpc`)와 2 MiB 상한은 구버전 앱 + 구버전 desktop 조합을 위해 유지하고, 그 조합이 사라지면 별도 변경으로 제거한다.

### desktop 계약

- `/remote/v1/e2e/rpc`는 binary envelope만 받는다.
- **세션 검증 전 버퍼는 host 상한으로 묶는다.**
  - Cloud tunnel: `/remote/v1/e2e/rpc` stream을 열 때 host `attachmentMaxMib`에서 계산한 Android E2E body 상한을 그 stream의 누적 상한으로 적용한다. 고정 16 MiB가 아니다.
  - Direct 경로: route의 body 상한을 같은 값으로 둔다.
  - 이것으로 ADR-0227 Decision 5(a)를 transport와 무관하게 다시 지킨다.
- **body 상한 산술**: 첨부 JSON cap + wrapper slack + tag + prefix다. base64 한 겹이 빠진 만큼 기존 `android_e2e_rpc_body_limit`보다 작다.
- **prefix 조기 거부**: 31 B prefix가 도착하면 body 전체를 받기 전에 다음을 확인하고, 아니면 stream을 거부한다.
  - 형식 번호가 `2`인지
  - `sessionId`의 세션이 존재하고 만료되지 않았는지
  - `sequence`가 허용 범위인지

  이 확인은 **인증이 아니다**. `sessionId`는 relay에도 보이므로 최종 인증은 AEAD 검증뿐이다. prefix 확인은 sequence를 소비하지 않고 세션 수명이나 lease를 갱신하지 않는다.
- desktop tunnel도 E2E rpc stream의 body 수신에 idle deadline을 둔다. relay가 오동작해도 stream 슬롯(`MAX_ACTIVE_STREAMS`)을 무기한 점유하지 않게 한다.
- AEAD는 single-shot이므로 desktop은 prefix 통과 후 body 전체를 받은 뒤 복호화한다.

### 상한 미러·호환·배포

- **relay 미러 상수**: Android E2E Cloud 경로의 relay 상한 미러를 16 MiB에서 유도한다. 16 MiB에서 prefix·tag·slack·base64 한 겹을 벗긴 계산값은 약 11.96 MiB이고, 기존 MiB 내림 정책에 따라 노출값은 11 MiB다. host 최대 10 MiB보다 커서 구속하지 않으므로, Android 앱도 Cloud 경로에서 host 설정 상한까지 첨부한다.
- **호환성**: wire 형식 변경은 ADR-0172의 비호환 변경이다. desktop `COMPAT_VERSION`과 앱 `E2eProtocol.COMPAT_VERSION`을 함께 2로 올린다. 한쪽만 업데이트된 조합은 challenge 단계에서 방향에 맞는 업데이트 안내로 거부된다. 게이트 이전 앱도 challenge 응답 검증에서 거부된다. 그러므로 desktop은 JSON envelope를 병행 지원하지 않는다.
- **배포 순서**: relay에 새 route를 먼저 배포한 뒤 desktop과 앱을 릴리스한다.
- **relay가 보는 정보**는 기존과 같다: `instanceId`·`sessionId`·`sequence`, body 크기, 요청 시각. 첨부 바이트·파일명·터미널 입력을 포함한 요청 내용은 계속 암호문이다.

## Alternatives Considered

- **JSON envelope를 유지하고 `instanceId`만 header로 올려 스트리밍(A안)**: 앱·relay 변경만으로 끝나지만, base64 두 겹 때문에 10 MiB 첨부가 약 17.8 MiB가 되어 relay·desktop tunnel의 16 MiB 상한을 둘 다 올려야 한다. 트래픽도 base64 한 겹만큼(약 33%) 크다. JSON에서는 `sessionId`가 body 어디에 올지 정해지지 않아 prefix 조기 거부도 할 수 없다.
- **relay 상한만 18 MiB로 올리기**: 구현은 상수 하나지만 위 메모리 증폭이 그대로 남아 1 GiB 인스턴스에서 OOM 위험을 만든다. 인스턴스를 키우는 것은 증상만 미룬다.
- **relay가 JSON을 incremental parse**: JSON 필드 순서가 보장되지 않아 `instanceId`가 끝에 오면 결국 버퍼해야 한다. 파서 복잡도에 비해 얻는 것이 없다.
- **`instanceId`도 binary prefix에 넣기**: header 없이 body 하나로 끝나지만 relay가 body 앞부분을 엿보고 다시 이어 붙여야 한다. header가 relay의 "body를 보지 않는다" 불변식을 단순하게 지킨다.
- **`sessionId`·`sequence`도 header로**: desktop tunnel은 E2E 경로의 header를 계약에 넣지 않고 relay도 넘기지 않는다. AAD 재구성과 조기 거부에 필요한 값은 body에 있어야 desktop이 transport와 무관하게 같은 방식으로 검증한다.
- **chunked upload**: 메모리 문제를 desktop까지 근본적으로 없애지만 재조립 상태·실패 cleanup·sequence 의미를 새로 설계해야 한다. 10 MiB는 단일 요청으로 충분하다(ADR-0227의 판단 유지).
- **desktop이 JSON·binary를 병행 수용**: 구 앱 지원 기간을 늘리지만 compat gate가 이미 불일치 조합을 명확히 거부하므로 두 파서를 유지할 이유가 없다.
- **relay가 body를 다 받은 뒤 capacity를 잡기**: 슬롯 점유 DoS는 없어지지만 그러려면 body를 버퍼해야 하므로 이 결정의 목적과 모순이다. 대신 전용 동시 실행 상한과 deadline으로 점유 시간과 개수를 묶는다.

## Consequences

- Android 앱이 Cloud relay로 접속해도 host가 정한 첨부 상한(최대 10 MiB)을 쓸 수 있다. Tailscale 안내는 relay가 실제로 구속할 때만 남는다.
- relay의 Android E2E 요청 메모리가 envelope 크기에 비례하지 않게 된다. relay 인스턴스 크기를 이 기능 때문에 키우지 않는다.
- 같은 첨부의 요청 body가 약 25% 작아져 relay egress와 모바일 업로드가 줄어든다. desktop은 base64 decode 복사본이 없어진다.
- relay는 Android E2E 요청 body의 스키마 검증을 하지 않는다. 잘못된 body는 desktop이 prefix 검증과 AEAD에서 거부한다. relay에 남는 방어선은 header 형식, rate limit, 전용 동시 실행 상한, deadline, 바이트 상한이다.
- 미인증 호출자가 desktop에 쌓을 수 있는 양은 stream당 host 상한으로 묶인다. 살아 있는 `sessionId`를 모르면 31 B에서 거부된다. 느린 body는 relay·desktop deadline과 전용 동시 실행 상한 안에서만 슬롯을 점유한다.
- compat 번호가 2로 오르므로 desktop과 앱 중 하나만 업데이트한 사용자는 연결 시 업데이트 안내를 받는다.
- relay는 구 JSON route를 한동안 유지한다. 제거 시점은 구버전 앱·desktop 비중을 보고 정한다.
- 구현 시 함께 바꿀 것:
  - laymux-server: 새 proxy route·전용 capacity·deadline, `docs/tunnel-protocol.md`
  - desktop:
    - `android_e2e` 요청 envelope 파서와 prefix 조기 검증
    - tunnel의 E2E rpc stream 상한·idle deadline
    - `android_e2e_rpc_body_limit`, `CLOUD_RELAY_ANDROID_E2E_RPC_BODY_LIMIT` 미러, `COMPAT_VERSION`
  - Android:
    - `E2eProtocol`의 요청 envelope 생성(문자열 → 바이트)과 `COMPAT_VERSION`
    - `E2eRemoteClient`의 문자열·`application/json` 고정 전송과 재시도 경로
    - native bridge body 상한은 이미 10 MiB 기준이라 바꾸지 않는다.
  - `docs/architecture/api-contracts.md`:
    - Android E2E RPC 절과 route 표
    - "compatVersion 현재 1"류 문구. FileViewer 설명은 1→2 치환이 아니라 "이 기능 자체는 compat 증가를 요구하지 않는다"로 고쳐 과거 결정의 이유를 보존한다.
    - 현재값 설명은 구현 PR에서 바꾼다.
- 테스트:
  - prefix 경계: 짧은 body, 형식 번호 ≠ 2, `sessionId` 길이·미존재·만료
  - prefix 거부가 sequence·세션 수명을 건드리지 않음
  - instance id를 바꾼 AAD 실패
  - 최대 첨부가 desktop body 상한과 relay 16 MiB 안에 드는지의 산술
  - desktop tunnel이 host 상한을 넘는 E2E stream을 끊음
  - relay가 body를 읽기 전에 rate limit·전용 capacity로 거부함
  - `Content-Length` 없는 chunked 요청의 누적 상한, 상한 초과·deadline·클라이언트 종료 시 stream 취소와 lease 회수
  - compat 불일치 안내
- 재검토 조건: 응답 방향에도 큰 payload가 생기거나 첨부 상한을 relay 16 MiB 너머로 올리려 할 때는 chunked 전송을 새 ADR로 검토한다.
