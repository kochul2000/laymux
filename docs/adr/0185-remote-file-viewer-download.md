# 0185. Remote FileViewer 다운로드는 전용 bytes 엔드포인트로 받고 안드로이드는 네이티브가 저장한다

- Status: Proposed
- Date: 2026-08-20
- Source: 사용자 요구(리모트 뷰어에서 줌과 다운로드), [ADR-0184](0184-remote-file-viewer-in-page-overlay.md), [ADR-0041](0041-remote-served-file-viewer.md)·[ADR-0042](0042-remote-file-viewer-secret-capability.md)(lease-gated 파일 읽기), [ADR-0109](0109-file-viewer-typed-preview-renderers.md), [api-contracts.md §13.3.1](../architecture/api-contracts.md)

## Context

Remote 에는 파일 저장 기능이 없었다. 데스크톱 FileViewer 에도 없다. 그런데 Remote 는 폰에서 호스트를 보는 표면이고, 스크린샷·로그·PDF 를 기기로 가져오려는 요구가 자연스럽게 생긴다.

표시용 payload 를 그대로 저장하면 틀린 파일이 저장된다.

- `render` 는 HTML/Markdown 을 원문 대신 **sanitize 된 preview document** 로 내려준다(응답 크기 때문에 원문을 함께 보내지 않는다, ADR-0041/0109). 그 payload 를 저장하면 사용자가 요청한 파일이 아니라 뷰어가 만든 문서가 저장된다.
- `binary` 는 `{size}` 만, `archive` 는 entry 목록만 내려온다. 바이트가 아예 없다.
- 즉 오버레이가 들고 있는 것으로 저장할 수 있는 것은 text·image·pdf 뿐이고, 그중 document 계열은 내용이 다르다.

표면별 저장 경로도 갈린다. 브라우저는 `Blob` + `<a download>` 로 저장되지만, 안드로이드 래퍼의 secure WebView 에는 `DownloadListener` 가 없어 같은 코드가 **조용히 아무 일도 하지 않는다**. 실패조차 보이지 않는 것이 가장 나쁜 결과다.

범위는 Remote FileViewer 가 보고 있는 단일 호스트 파일을 사용자 기기에 저장하는 것이다. 디렉터리 다운로드, 여러 파일 묶음, 업로드(호스트로 쓰기), 데스크톱 FileViewer 의 저장 기능은 비목표다. 8 MiB Remote 전송 상한(`MAX_REMOTE_FILE_VIEWER_BYTES`)은 그대로 적용한다.

## Decision

**다운로드는 표시 payload 를 재사용하지 않고 `POST /remote/v1/file-viewer/download` 로 원본 바이트를 받으며, 브라우저는 `Blob` 로 저장하고 안드로이드는 네이티브 브리지가 공용 Downloads 컬렉션에 쓴다.**

1. 새 데스크톱 커맨드 `read_file_for_download` 이 파일 전체를 `{name, mediaType, base64, size}` 로 돌려준다. `FileViewerContent` 에 variant 를 추가하지 않는다 — 분류는 "무엇으로 그릴지"를 정하는 축이고 다운로드는 그 축과 무관하며, 표시 경로에 "원시 바이트도 함께" 분기가 자라는 것을 막는다.
2. 응답의 `name` 은 **파일 이름만** 이다. 호스트 경로는 요청에만 존재하고 저장 대화상자나 기기 파일 시스템으로 넘어가지 않는다.
3. 상한을 넘으면 **잘린 본문이 아니라 에러**다. 잘린 다운로드는 손상된 파일이므로 부분 저장을 성공으로 보이게 하지 않는다.
4. Remote route 는 render/status/path-link 와 같은 active lease + 비밀 capability 게이트(ADR-0042)를 쓰고 같은 8 MiB 상한을 서버가 정해 bridge 에 넘긴다. 클라이언트가 상한을 고르지 못한다.
5. 브라우저는 `Blob` + `<a download>` + object URL 로 저장한다. object URL 은 지연 해제한다 — 클릭 직후 동기 해제는 방금 시작된 저장을 취소할 수 있다.
6. 안드로이드 래퍼에서는 `LaymuxNative.saveRemoteFile(name, mediaType, base64)` 로 네이티브가 저장한다. 브리지 메서드가 없는 구버전 APK 에서는 조용히 실패하는 대신 앱 업데이트를 요구하는 메시지를 표시한다.
7. 네이티브 저장은 `MediaStore.Downloads` 를 쓴다. 런타임 권한이 필요 없고, `IS_PENDING` 으로 바이트를 다 쓴 뒤에만 다른 앱에 보이게 해 실패가 잘린 파일을 남기지 않는다. `MediaStore.Downloads` 는 Android 10 부터이므로 그 이하에서는 저장을 지원하지 않는다고 알린다.
8. 저장할 이름은 호스트가 정한 값이므로 네이티브가 신뢰하지 않고 다시 만든다(`RemoteDownloadPolicy`). 경로 구분자·제어문자·예약문자는 치환하고, 디렉터리를 가리키는 이름은 대체 이름으로 바꾸며, 길이는 확장자를 보존하며 자른다. 거부보다 치환을 택한 이유는 이름이 조금 달라진 저장이 실패한 저장보다 사용자에게 낫기 때문이다. 바이트 수는 저장 전에 같은 상한으로 다시 확인한다.

## Alternatives Considered

- **오버레이가 이미 받은 payload 로 저장**: 새 엔드포인트가 필요 없다. 기각. document 계열은 sanitize 된 preview 가 저장되어 사용자가 요청한 파일이 아니고, binary·archive 는 바이트가 없어 애초에 불가능하다. "일부 종류만 되는 다운로드"는 계약으로 설명하기 어렵다.
- **`render` 응답에 원문 바이트를 함께 실어 보내기**: 엔드포인트가 늘지 않는다. 기각. 모든 열기가 두 배 이상의 본문을 옮기게 되고, ADR-0041 이 응답 크기 때문에 일부러 제거한 원문 중복을 되살린다. 다운로드는 드문 동작이므로 비용을 그 동작에만 둔다.
- **`FileViewerContent` 에 `Download` variant 추가**: 커맨드가 하나로 유지된다. 기각. 분류 열거형은 "무엇으로 그릴지"의 SoT 이고, 그리지 않는 값이 섞이면 데스크톱 렌더러와 Remote 렌더러 모두 다뤄야 할 죽은 분기를 얻는다.
- **안드로이드에 `setDownloadListener` 추가**: 브라우저 코드 한 벌로 끝난다. 기각. 앱은 Remote 를 HTTP origin 으로 띄우지 않고 RPC 로 문서를 설치하므로 `blob:` 다운로드가 리스너에 도달하는 경로 자체가 다르고, 다운로드 URL 을 다시 네트워크로 받는 구조는 이미 손에 있는 바이트를 한 번 더 옮긴다.
- **SAF(`ACTION_CREATE_DOCUMENT`)로 사용자가 위치 선택**: API 19 부터 되고 저장 위치를 사용자가 고른다. 기각(이번에는). activity result 왕복 동안 바이트를 들고 있어야 하고, 저장 위치 선택은 Downloads 폴더 기본 동작보다 단계가 늘어난다. Android 9 이하 지원이나 위치 선택 요구가 실제로 생기면 이 대안으로 되돌아온다.
- **호스트에서 임시 URL 발급 후 브라우저 다운로드**: 대용량에 유리하다. 기각. 자격 증명 없는 URL 을 새로 만드는 계약이 필요하고, ADR-0041 이 URL 에 권한을 싣지 않기로 한 결정과 충돌한다.

## Consequences

- 저장되는 것은 항상 호스트가 가진 바이트다. HTML·Markdown 을 저장해도 sanitize 된 preview 가 아니라 원문이 저장되고, binary·archive·PDF 도 저장 가능해진다 — 렌더는 못 해도(ADR-0109) 기기로 가져올 수는 있다.
- 다운로드가 두 번째 파일 읽기 경로를 만든다. `read_file_for_download` 도 lease 와 capability 뒤에 있고 같은 상한을 쓰지만, 앞으로 파일 읽기 정책을 바꿀 때 손댈 곳이 두 곳이 된다.
- Android 9 이하에서는 저장이 불가능하다. 이는 문서화된 제약이며, 사용자에게 조용한 실패가 아니라 메시지로 전달된다.
- 8 MiB 를 넘는 파일은 Remote 로 저장할 수 없다. 상한을 올리는 것은 터널 응답 비용과 함께 결정할 문제이므로 이 ADR 에서 바꾸지 않는다. 필요해지면 streaming/ticket 계약을 별도 ADR 로 검토한다.
- `name` 정규화 규칙이 새로운 계약 표면이다. 규칙이 바뀌면 저장되는 파일 이름이 바뀌므로 유닛 테스트가 그 규칙을 고정한다.
- 테스트는 Rust 단위(전체 바이트·이름만 반환·binary 도 바이트를 받음·상한 초과 시 거부·media type 표), 브리지 유닛(다운로드가 viewer 분류기를 호출하지 않음, 경로/상한 검증, 실패 전달), Kotlin 유닛(이름 정규화와 상한), Playwright(브라우저 다운로드 이벤트와 요청 본문, 실패가 오버레이를 닫지 않음, 안드로이드 래퍼에서 네이티브 저장이 호출되고 브라우저 다운로드는 0건)로 나눈다.
