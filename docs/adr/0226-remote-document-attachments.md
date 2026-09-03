# 0226. Remote 첨부는 signature 확인된 문서를 받고, 크기 상한과 추가 허용 종류는 host settings가 정한다

- Status: Proposed
- Date: 2026-09-03
- Source: 사용자 요구(Remote에서 PDF·DOCX·PPTX 첨부, 허용 확장자 추가·전체 허용 옵션, 최대 상한 10 MiB를 settings로 조정), [ADR-0181](0181-remote-terminal-file-attachments.md) 확장

## Context

ADR-0181은 Remote 터미널 첨부를 signature가 확인되는 이미지와 NUL 없는 UTF-8 text로 한정하고, 상한을 1 MiB 상수로 두었으며 "임의 binary 업로드"를 비목표로 정했다. 1 MiB는 Android E2E RPC envelope 2 MiB 안에 base64 두 겹을 넣기 위한 값이었다.

사용자는 세 가지를 요구했다. (1) PDF·Word·PowerPoint 문서를 CLI 에이전트에 host path로 넘기고 싶다. (2) 기본 종류 밖의 확장자를 host가 스스로 더 열어 주거나 아예 모든 종류를 허용할 수 있어야 한다. (3) 1 MiB는 사진 한 장에도 모자라므로 상한을 settings에서 10 MiB로 올리고 싶다.

허용 판정의 문제는 binary에 대해서는 signature 외에 내용을 검증할 수단이 없다는 점이다. PDF는 고정 header가 있다. DOCX·PPTX는 ZIP 컨테이너라 ZIP header만으로는 임의 archive와 구분되지 않는다. 사용자가 직접 열어 주는 확장자는 정의상 내용 검사가 불가능하므로 정책의 소유자를 host settings로 명시해야 한다.

크기 상한의 문제는 1 MiB를 전제한 경계가 여러 층에 흩어져 있다는 점이다: 브라우저 page의 상수, 서버 route의 axum body limit(1.5 MiB), Android E2E RPC envelope(2 MiB)와 Android native bridge의 body 문자열 상한(1.5 MiB), Cloud tunnel의 stream pending 상한(4 MiB, 64 KiB frame × 64), 첨부 cache quota(64 MiB). 이 중 하나만 올리면 경로에 따라 다른 상한이 나타난다.

범위는 위 세 요구를 기존 attachments 계약(private cache directory, UUID 파일명, lease permit, structured path 입력, WSL path 변환)에 얹는 것이다. 첨부 내용을 서버가 파싱·변환·미리보기하는 것, 10 MiB를 넘는 chunked upload, Cloud relay 서버 자체의 요청 상한 변경은 비목표다.

## Decision

**PDF·DOCX·PPTX는 bytes의 signature로 판정하여 이미지와 같은 등급으로 받는다. 그 밖의 종류와 크기 상한은 `remote.attachmentMaxMib`·`remote.attachmentAllowAllExtensions`·`remote.attachmentExtraExtensions` 세 host settings가 정하고, 모든 transport 경계와 cache quota는 그 값에서 유도한다.**

1. 판정 순서는 image signature → document signature → text(declared MIME/확장자 + 유효 UTF-8) → host 허용 opaque → 거절이다. 이미지·문서는 caller의 확장자·MIME를 무시하고 bytes가 말하는 확장자로 저장한다.
2. PDF는 `%PDF-` header다. DOCX·PPTX는 ZIP local header(`PK\x03\x04`)에 더해 OOXML main part 이름이 bytes 안에 plain text로 존재해야 한다. ZIP central directory는 part 이름을 압축하지 않으므로 archive를 풀지 않고도 `word/document.xml`은 DOCX, `ppt/presentation.xml`은 PPTX로 확정한다. 둘 다 없는 ZIP은 확장자가 `.docx`여도 거절한다.
3. `attachmentExtraExtensions`(소문자, 점 없이, 영문·숫자 1~16자)에 든 확장자는 내용 검사 없이 그 확장자로 저장한다. `attachmentAllowAllExtensions=true`이면 모든 파일을 받되 확장자가 위 규칙에 맞지 않으면 `bin`으로 저장한다. 이때도 signature가 확인되는 이미지·문서는 여전히 signature 확장자로 저장해 저장 이름이 내용과 어긋나지 않게 한다. 이 두 설정은 host 사용자가 명시적으로 켠 정책이므로 ADR-0181의 "임의 binary 업로드" 비목표를 host opt-in으로 정정한다.
4. `attachmentMaxMib`는 1~10이며 기본 1이다. 서버는 이 값을 매 요청마다 읽어 decoded bytes, base64 `data` 길이, 요청 JSON body(base64 길이 + 16 KiB slack)를 검사한다. route의 axum 기본 body limit은 끄고 handler가 직접 body를 읽는다. cache quota는 상한의 64배(기본 64 MiB)로 유도해 "최대 크기 파일 64개"라는 비율을 유지한다.
5. 상한이 10 MiB인 이유는 Cloud tunnel의 HTTP 요청 상한 16 MiB다. 10 MiB의 base64 JSON은 약 13.4 MiB로 그 안에 들어간다. tunnel의 stream pending 상한은 16 MiB로, frame queue는 256개(64 KiB × 256)로, socket pending 상한은 32 MiB로 올린다. Android E2E RPC envelope 상한은 "10 MiB 첨부 JSON을 한 번 더 AEAD·base64url로 감싼 크기"에서 유도한 상수(약 18.7 MiB)이며 Android native bridge의 body 문자열 상한도 같은 식으로 맞춘다. Android E2E envelope는 paired device의 encrypted session이 있어야 열리므로 static 상한을 둔다.
6. **Cloud relay를 거친 요청은 relay의 payload 상한을 지킨다.** 요청이 어느 transport로 들어왔는지는 router extension `RemoteTransport`가 말한다: Cloud tunnel이 넘긴 브라우저 요청은 `CloudRelayBrowser`, Android E2E RPC envelope에서 풀어낸 내부 요청은 `AndroidE2e{via_cloud_relay}`(envelope 자체가 tunnel로 왔는지로 판정), Direct/Tailscale 브라우저 요청은 marker 없음. 정책의 실효 상한은 `min(host 설정, relay 상한)`이며 relay 상한은 laymux-server 상수를 미러한 값에서 유도한다 — 브라우저 경로는 `TUNNEL_HTTP_REQUEST_BYTES_LIMIT`(16 MiB)에서 base64·slack을 벗겨 약 11 MiB(host cap 10 MiB보다 크므로 구속하지 않음), Android E2E 경로는 `ANDROID_E2E_RPC_BODY_LIMIT`(2 MiB)에서 두 겹의 base64·slack을 벗겨 1 MiB다. relay 상한이 host 설정보다 작아 실제로 구속할 때 초과 요청은 "Cloud relay payload limit" 때문이라고 설명하고 Tailscale(direct Remote)로 접속하면 host 상한까지 쓸 수 있다고 안내한다. relay 상수가 바뀌면 desktop의 미러 상수를 함께 갱신한다.
7. 정책은 claim 응답과 `/session/status` 응답에 `attachments:{maxBytes,hostMaxBytes,relayMaxBytes,allowAllExtensions,extraExtensions}`로 실린다. `maxBytes`는 그 경로의 실효 상한, `hostMaxBytes`는 host 설정, `relayMaxBytes`는 relay 경로일 때만 값이 있다. page는 이 값으로 사전 크기 검사·오류 문구(relay가 구속하면 같은 Tailscale 안내)·`input[type=file]`의 `accept`를 맞춘다(allow-all이면 `accept`를 제거, extra는 `.ext`로 덧붙임). `accept`는 UX 필터일 뿐이며 서버 판정이 유일한 경계다. 서버는 settings 변경을 즉시 따르고, page의 사전 검사는 다음 claim부터 갱신된다.
8. `describe_settings`/schema metadata는 세 키를 `NextUse`로 노출한다. semantic validation은 범위 밖 MiB와 규칙에 맞지 않는 확장자를 issue로 보고하고, 서버 정책은 범위를 clamp하며 잘못된 확장자는 무시한다.

## Alternatives Considered

- **확장자·MIME만으로 DOCX/PPTX 허용**: 임의 ZIP을 `.docx`로 이름만 바꿔 host cache에 넣을 수 있어 signature 확인 원칙을 깬다. 사용자가 원하면 `attachmentExtraExtensions`로 같은 결과를 명시적으로 얻을 수 있으므로 기본 종류에서는 signature를 요구한다.
- **ZIP을 실제로 열어 `[Content_Types].xml` 파싱**: 정확하지만 zip 의존성·decompress 비용·zip bomb 방어가 필요하다. 10 MiB 이내 bytes에 대한 plain-text part 이름 검색이 같은 판정을 훨씬 싸게 준다.
- **상한을 상수로 10 MiB로 올리기**: 모든 host에 큰 요청 body 허용을 강제한다. host가 정하는 settings로 두면 기본은 1 MiB로 보수적이고, 올린 host만 큰 경계를 감수한다.
- **상한을 무제한·chunked upload로**: Cloud relay·E2E envelope·재조립 상태·실패 cleanup을 새로 설계해야 한다. 10 MiB는 기존 단일 요청 계약 안에서 tunnel 상한만으로 해결된다.
- **Android E2E RPC envelope 상한도 settings에서 동적으로**: 정확하지만 envelope 해석 전에 settings를 읽는 경로가 필요하다. encrypted session이 전제된 경로라 static 상한으로 충분하다.

## Consequences

- Remote에서 PDF·DOCX·PPTX와 host가 허용한 확장자를 CLI 에이전트에 host path로 넘길 수 있고, 상한을 10 MiB까지 올릴 수 있다.
- allow-all과 extra extension은 host cache에 임의 binary가 남는다는 뜻이다. 파일은 여전히 private directory·UUID 이름·quota·7일 cleanup 아래에 있고 host가 열지 않는다. 이 위험은 host 사용자가 켠 정책의 명시적 비용이다.
- 상한을 올린 host는 그 크기의 요청 body를 lease 보유자에게서 받을 수 있다. desktop의 tunnel·E2E 경계는 상한에 맞춰 커진다. Cloud relay 자체의 상한은 이 저장소 밖이므로 desktop이 미러 상수로 지킨다: 브라우저 경로는 10 MiB까지 그대로 통과하고, Android 앱이 Cloud로 접속하면 1 MiB에서 막히며 Tailscale 안내를 받는다. relay 상한이 바뀌면 미러 상수만 갱신하면 되고, relay가 미러보다 낮아지면 relay 쪽 413이 먼저 나타난다.
- Android native bridge 상한은 앱 업데이트가 있어야 반영된다. 구버전 앱은 1.5 MiB를 넘는 첨부를 bridge에서 거절한다. Cloud 경로에서는 page의 사전 검사가 1 MiB에서 먼저 막으므로 bridge 상한은 Tailscale Direct 경로에서만 의미가 있다.
- DOCX/PPTX 판정은 두 번의 substring 검색이다. DOCM·PPTM 같은 macro 변형은 같은 main part 이름을 가지므로 `.docx`/`.pptx`로 저장된다. CLI가 host path로 읽는 용도에서는 문제가 없다.
- 테스트는 PDF header, DOCX/PPTX part 이름 판정, `.docx` 이름의 임의 ZIP 거절, extra extension·allow-all의 opaque 저장, settings clamp·필터, transport 상한이 최대 첨부를 덮는지를 단위 테스트로 고정한다.
