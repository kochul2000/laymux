# 0042. Remote FileViewer는 lease-bound 비밀 capability로 호스트 파일을 읽는다

- Status: Accepted
- Date: 2026-07-20
- Source: PR #489 review, [api-contracts.md §13.3.1](../architecture/api-contracts.md), [ADR-0037](0037-remote-lease-takeover-and-pagehide-release.md), [ADR-0041](0041-remote-served-file-viewer.md) 권한·응답 계약 정정

## Context

ADR-0041은 Remote FileViewer의 status/render API가 active controller lease를 요구한다고 결정했다. 그러나 `leaseId`는 controller 충돌 상태를 표현하기 위해 `/remote/v1/session/status`와 claim의 `409` 응답에도 나타나는 공개 식별자다. 같은 bearer token을 가진 observer는 이 값을 복사할 수 있으므로, `leaseId`의 active 여부만 검사하면 claim에 성공하지 않고도 `source="path"`로 임의 호스트 파일을 읽을 수 있다. 이는 token-only observer에게 파일과 경로를 공개하지 않는 ADR-0041의 보안 경계를 깨뜨린다.

또한 HTML/Markdown render 응답은 최대 8 MiB 원문 `content`와 그 원문에서 만든 `previewDocument`를 함께 반환했다. Cloud tunnel의 HTTP response 한도는 16 MiB이므로 최대 크기 부근에서 JSON 오버헤드까지 더해 전송이 실패할 수 있다. Preview가 잘린 경우에도 child renderer가 안내 없이 먼저 반환해 불완전한 내용을 전체 문서처럼 표시했다.

범위는 Remote FileViewer의 읽기 권한 증명, preview 응답 스키마, 잘림 표시다. 일반 terminal/navigation controller action의 공개 `leaseId` 계약과 source 상한 8 MiB 자체는 바꾸지 않는다.

## Decision

**Remote FileViewer는 claim 성공자에게만 발급하는 별도 `fileViewerToken`을 active lease에 결합해 검증하고, preview 응답은 sanitized document만 전송한다.**

1. 성공한 `/remote/v1/session/claim`은 기존 `leaseId`·`resumeToken`과 별도로 process-random `fileViewerToken`을 반환한다. status·claim 충돌 응답에는 이 값을 포함하지 않는다.
2. 서버는 `fileViewerToken` 원문을 저장하지 않고 process-random 키의 이중 SipHash digest와 발급 대상 `leaseId`만 저장한다. 새 claim은 capability를 회전시키고, expiry·reclaim·disable·자발적 release를 포함한 모든 owner transition은 FileViewer capability를 즉시 revoke한다. Resume handoff와 달리 FileViewer 권한은 transition을 통과해 보존하지 않는다. 진행 중인 FileViewer bridge 작업도 owner transition을 넘지 않도록, 서버는 bridge 완료 뒤 응답 직전에 요청 때 보관한 동일한 lease/capability 조합을 다시 검증하고 무효하면 결과를 폐기한다.
3. `/remote/v1/file-viewer/status`와 `/remote/v1/file-viewer/render`는 bearer token/IP/Origin gate에 더해 active `leaseId`와 `X-Laymux-Remote-File-Viewer: <fileViewerToken>`이 모두 일치해야 한다. 누락·오류·다른 lease에 발급된 capability는 동일한 `403`으로 거절한다. 경로·파일 payload와 권한 전환 전의 stale 결과가 브라우저 캐시에 남지 않도록 bridge 이후의 성공·실패 응답에는 `Cache-Control: no-store`를 적용한다.
4. Remote main page는 `fileViewerToken`을 문서 메모리에만 보관한다. 새 탭 handshake는 기존 token·lease·source/path와 함께 capability를 exact-origin `postMessage`로 한 번 전달하고, child는 render 요청 header에 이를 보낸다. URL과 storage에는 기록하지 않는다.
5. 일반 text 응답은 기존 `{path,kind:"text",content,truncated}`를 유지한다. HTML/Markdown preview 응답은 원문 `content`를 중복하지 않고 `{path,kind:"text",truncated,previewKind,previewDocument}`만 반환한다. child는 `truncated=true`이면 preview iframe을 표시하면서 Remote viewer limit 경고도 함께 표시한다.

## Alternatives Considered

- **공개 `leaseId`만 계속 사용**: terminal 제어 action과 형식은 같지만 observer가 status/충돌 응답에서 값을 얻을 수 있어 파일 권한 증명이 되지 않는다.
- **기존 `resumeToken`을 FileViewer에도 사용**: claim 성공자 binding은 충족하지만 takeover와 호스트 파일 읽기라는 서로 다른 권한이 하나의 secret에 결합된다. child에 전달할 최소 권한이 커지고 한 기능의 노출이 다른 기능까지 확대되므로 별도 capability를 선택했다.
- **bearer token과 remote address를 lease에 결합**: 같은 token을 공유하는 observer를 구분하지 못하고 NAT/proxy/tunnel 환경에서는 주소도 안정적인 client identity가 아니다.
- **원문과 preview를 유지하고 source 상한만 낮춤**: 일반 문서의 사용 가능한 크기를 불필요하게 줄이며 직렬화 expansion에 따른 실제 response 크기를 직접 제거하지 못한다. Preview tab은 source toggle이 없으므로 중복 원문을 제거한다.

## Consequences

- 공개 `leaseId`와 bearer token만 가진 observer는 desktop viewer 경로나 임의 호스트 파일을 읽을 수 없다. FileViewer 권한은 현재 claim 성공 문서와 그 문서가 명시적으로 연 child에만 전달된다.
- bridge 실행 중 capability가 폐기되면 이전 controller에게 경로나 파일 payload를 반환하지 않는다. 이는 bridge 비용이 이미 발생했더라도 응답 경계에서 fail closed하는 비용을 수반한다.
- claim 응답과 FileViewer request header에 새 외부 필드가 추가된다. Remote main page와 child는 같은 배포 artifact이므로 별도 호환 migration은 제공하지 않고 capability가 없으면 fail closed한다.
- Preview payload는 원문 중복을 제거해 8 MiB 부근 문서가 Cloud 16 MiB response 한도를 넘는 주된 경로를 없앤다. 향후 sanitizer expansion 하나만으로 한도에 접근하는 사례가 관측되면 직렬화된 response 크기 기준의 추가 절단 또는 streaming/blob ticket을 새 결정으로 검토한다.
- HTML/Markdown preview에는 source 내용이 없으므로 child에서 source toggle을 추가하려면 별도 요청이나 response 계약을 다시 설계해야 한다.
- 테스트는 공개 lease 거절·lease-bound capability 회전, claim 응답 비밀 필드, 새 탭 header 전달, preview 원문 비중복·잘림 경고를 검증한다.
