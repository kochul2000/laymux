# 0208. Android E2E FileViewer는 타입화 capability와 claim binding을 함께 검증한다

- Status: Proposed
- Date: 2026-08-27
- Source: 사용자 요구("헤더를 주입하지 않는 설계", Android FileViewer 403 수정) · [api-contracts.md §13.0, §13.3.1](../architecture/api-contracts.md) · [ADR-0042](0042-remote-file-viewer-secret-capability.md) · [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md) · [ADR-0170](0170-android-e2e-lease-dies-with-its-session.md)
- Extends: ADR-0042, ADR-0146, ADR-0170
- Corrects assumptions in: ADR-0184, ADR-0198

## Context

Remote FileViewer는 공개 `leaseId`만 아는 observer가 호스트 파일을 읽지 못하도록 claim 성공자 전용 `fileViewerToken`을 별도 capability로 요구한다. 일반 browser Remote는 active lease와 이 capability를 두 전용 헤더로 제시한다.

Android E2E의 서명된 native bridge는 범용 인증 프록시가 되지 않도록 caller header·cookie·Remote bearer token을 받지 않고, 암호화된 `kind=http`의 exact method/path/body만 데스크톱 router에 재주입한다. 그러나 PC가 제공하는 Remote 문서는 browser와 같은 FileViewer 헤더를 만들고 Android adapter는 그 헤더를 의도적으로 버린다. 그 결과 Android의 FileViewer endpoint는 allowlist에는 있으나 항상 capability `403`으로 실패한다. ADR-0184와 ADR-0198은 같은 Remote 문서를 사용하면 인증 표면도 같다고 가정했지만, native E2E bridge의 credential 경계는 browser fetch와 다르다.

헤더 전달을 복구하면 브리지의 권한이 FileViewer를 넘어 `Authorization`·`Cookie`를 포함한 범용 credential injection으로 넓어진다. 반대로 E2E session 자체만 파일 권한으로 쓰면 native bridge를 호출할 수 있는 모든 frame에 ambient host-file-read 권한을 준다. 별도 FileViewer capability와 exact E2E claim 신원을 모두 요구해 두 위험을 함께 막아야 한다.

또한 순차 AEAD RPC는 응답 유실을 복구하려고 직전 exact ciphertext 요청의 암호화 응답을 cache한다. FileViewer 성공 응답도 권한 전환 뒤 검증 없이 재전송하면 capability 즉시 revoke 불변식을 우회한다. 기존 내부 HTTP 응답 한도 1 MiB와 FileViewer 원문 한도 8 MiB도 맞지 않아 인증을 고친 뒤 큰 preview/download가 뒤늦게 실패한다.

범위는 Android E2E FileViewer 권한 증명, claim binding, 민감 응답의 exact-retry 정책과 Android 전용 크기 계약이다. browser FileViewer 헤더 계약, Android APK bridge arity, outer `PlainRequest::Http` wire, 일반 Remote controller 권한은 바꾸지 않는다. 대용량 streaming과 임의 헤더 전달은 비목표다.

## Decision

**Android E2E FileViewer는 암호화된 요청 body의 목적 한정 capability를 내부 타입으로 변환하고, 현재 E2E session이 claim한 exact lease binding과 함께 bridge 전후 및 cached retry 직전에 검증한다.**

1. Android Remote 문서는 FileViewer 요청에만 `fileViewerAuthorization: { leaseId, fileViewerToken }`을 business body와 함께 넣는다. Android adapter는 기존 4인자 `requestRemoteHttp(requestId, method, path, body)`를 그대로 사용한다. caller header map, cookie, Remote bearer token, 새 native credential cache는 추가하지 않는다.
2. 데스크톱 E2E dispatcher는 exact FileViewer method/path에서만 이 객체를 엄격한 schema로 파싱하고 body에서 제거한 뒤, AEAD·sequence·session 검증 후에만 생성 가능한 crate-private request extension으로 바꾼다. 다른 route의 예약 필드, 누락·빈 값·잘못된 shape, header proof와의 혼합은 동일한 `403`으로 거부한다. 일반 browser/Cloud 요청은 기존 lease+capability header만 사용하며 body proof를 인정하지 않는다.
3. FileViewer status의 browser `GET`은 유지하고 Android E2E에는 내부 proof를 받는 exact `POST` alias만 연다. public POST 호출은 내부 E2E extension이 없으므로 fail closed한다. render/download/path-link/list의 기존 POST 계약은 유지한다.
4. Android request context는 E2E session 객체만 발급할 수 있는 opaque 값이다. 권한 검사는 registry의 현재 session entry와 exact 객체 identity, revoke·expiry·pairing revision을 fail closed로 확인한다. cleanup용으로 lock 오류 때 lease를 보존하는 `session_is_active` 판정은 권한 검사에 사용하지 않는다.
5. Android claim은 현재 pairing revision/session 확인부터 lease·binding 설치까지 하나의 authorization commit으로 직렬화한다. 이 짧은 구간은 `pairing lifecycle → E2E session registry → remote_access → remote_control` 순서로 락을 잡고, owner lock 안에서 `{leaseId, ownerEpoch, instanceId, sessionId}` binding을 기록한다. pairing create/revoke도 revision 변경과 registry clear를 같은 lifecycle 구간에 두며, challenge/establish는 material load 뒤 lifecycle을 다시 획득해 current revision을 확인한 상태에서만 registry를 변경한다. 따라서 revoke/새 establish가 확인과 설치 사이에 끼어 stale lease나 stale session 성공을 남길 수 없다. FileViewer proof는 active/non-transitioning lease, capability digest, current owner epoch, exact binding과 request context가 모두 일치해야 한다. 하나라도 실패하면 browser proof로 fallback하지 않는다.
6. handler는 검증된 receipt를 bridge 전 얻고, bridge 완료 뒤 payload를 반환하기 직전에 같은 receipt를 다시 검증한다. 최종 owner-state 검증을 응답 authorization commit 지점으로 삼고 결과에는 `Cache-Control: no-store`를 적용한다. 느린 파일 read를 owner-transition barrier로 등록해 reclaim을 막지는 않는다.
7. 성공한 Android FileViewer 응답에는 원문 token이 아닌 `{leaseId, ownerEpoch, capabilityGeneration, instanceId, sessionId}` replay guard를 내부 metadata로 붙인다. 순차 AEAD cache는 guard를 함께 저장한다. exact ciphertext retry는 요청을 다시 복호화해 현재 typed proof와 guard를 재검증한 뒤에만 기존 ciphertext 응답을 반환한다. 실패하면 session을 revoke하고 outer E2E 오류로 끝내며, 같은 key/nonce/sequence에 다른 오류 평문을 암호화하지 않는다.
8. Android E2E FileViewer의 원문 read 상한은 2 MiB, inner FileViewer JSON 응답 상한은 3 MiB로 고정한다. frontend는 JSON escape와 UTF-8 바이트를 payload 문자열 생성 없이 먼저 계산해 Tauri IPC 이전에 거부하고, Rust dispatcher가 같은 3 MiB를 다시 강제한다. 일반 inner HTTP 응답의 1 MiB 한도는 유지한다. archive는 compressed source와 gzip inflate를 각각 원문 상한으로 제한한다. bounded ZIP은 최종 EOCD가 선언한 중앙 디렉터리를 CDFH 단위로 무할당 선검사해 5,000개를 넘으면 entry allocation 전에 거부한다. 이후에도 전체 source를 복구형 ZIP parser에 넘기지 않고 그 exact 중앙 디렉터리만 직접 읽으며, raw 파일명은 UTF-8 flag 또는 CP437 표를 직접 적용해 선형 시간으로 디코딩한다. 따라서 parser가 더 앞의 미검증 EOCD로 backtrack할 입력 자체가 없다. directory list는 Rust가 표시 상한+1개까지만 열거·metadata 조회한다. Android native save는 decoded 2 MiB 상한에 대응하는 padded base64 문자 수를 `Base64.decode` 전에 검사하고, 디코딩 뒤 byte 상한도 다시 검사한다. FileViewer 응답이 전용 한도를 넘으면 작은 구조화 `413`을 반환해 4 MiB 복호 평문 및 6 MiB public RPC envelope 안에 머문다. 더 큰 파일은 향후 별도 chunked encrypted transfer 결정 없이는 Android에서 preview/download하지 않는다.
9. token은 Remote 문서 메모리, 한 요청의 body string/JSONObject, AEAD plaintext와 request-local proof에서만 일시적으로 존재한다. URL·storage·로그·오류·Android 장기 필드·디스크·응답 cache에는 기록하지 않는다. 외부 wire와 APK bridge가 그대로이므로 Android E2E `COMPAT_VERSION`은 1을 유지한다.

## Alternatives Considered

- **caller header allowlist/주입**: FileViewer 한 건을 고치기 위해 native bridge를 범용 credential proxy로 확장하고 `Authorization`·`Cookie`와의 경계를 계속 관리해야 하므로 기각한다.
- **E2E session과 lease tag만 권한으로 사용**: secret을 운반하지 않지만 bridge 호출 가능성이 곧 host-file-read 권한이 된다. 현재 native bridge의 frame 경계보다 권한이 넓어 별도 capability를 유지한다.
- **전용 FileViewer native RPC와 origin-scoped message bridge**: 가장 명시적인 장기 경계지만 Kotlin/APK와 compat version을 함께 바꿔야 한다. 이번 호환 수정 이후의 hardening 후보로 남긴다.
- **1회용 path/download ticket 또는 chunked stream**: 대용량 전송과 더 좁은 경로 권한에는 유리하지만 추가 상태·왕복·취소·재시도 protocol이 필요하다. 이번에는 bounded preview/download로 제한한다.
- **cached 응답은 이미 commit됐으므로 revoke 뒤에도 재현**: relay가 이미 받은 ciphertext의 지연 전달과 유사하지만, 서버가 revoke 뒤 새로 재전송하는 동작은 FileViewer의 즉시 폐기 기대와 충돌한다. route-scoped guard 재검증을 선택한다.
- **FileViewer 때문에 모든 inner HTTP 응답 한도를 상향**: capability가 필요 없는 여러 route의 메모리·DoS 표면까지 넓히므로 전용 상한을 선택한다.

## Consequences

- Android는 caller header를 전달하지 않고도 browser와 동일한 별도 FileViewer capability 보안 경계를 얻는다. 공개 lease, 다른 E2E session, 이전 owner epoch, 다른 frame의 capability 없는 bridge 호출은 파일을 읽지 못한다.
- PC가 제공하는 새 Remote asset과 Rust backend만 배포하면 기존 4인자 APK가 동작한다. 구 PC는 자기 구 asset/backend를 제공하므로 기존 FileViewer 제한이 남지만 protocol incompatibility는 아니다.
- FileViewer handler, E2E session cache와 claim 설치가 같은 authorization receipt/replay guard 개념을 공유하므로 내부 타입과 테스트 비용이 늘어난다. raw token은 guard에 저장하지 않는다.
- Android의 preview/download는 2 MiB로 browser의 8 MiB보다 작다. UI는 기존 truncated/too-large 오류를 명확히 표시하며, 2 MiB를 넘는 Android 다운로드가 필요해지면 전용 chunked transfer ADR을 작성한다.
- 검증은 body proof strict parsing/제거, browser header 회귀, exact session 객체/lease/epoch/capability-generation binding, claim-vs-pairing lifecycle 경쟁, stale pairing material establish 거부, bridge 도중 revoke, cached retry 전환, mixed proof 거부, route별 크기 상한, 구 APK 4인자 bridge를 포함한다. living doc의 Android E2E와 Remote FileViewer 계약 및 생성된 Remote page bundle을 같은 PR에서 갱신한다.
