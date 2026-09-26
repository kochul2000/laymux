# 0266. Remote 파일 열기는 원본 바이트를 기기 뷰어에 전달한다

- Status: Proposed
- Date: 2026-09-26
- Source: 사용자 요구(PDF·HTML을 폰에서 연결 앱으로 열기), [ADR-0185](0185-remote-file-viewer-download.md), [ADR-0183](0183-remote-page-content-security-policy.md), [api-contracts.md §13.3.1](../architecture/api-contracts.md)
- 관계: ADR-0185의 원본 바이트 전달을 기기 열기로 확장한다.

## Context

Remote 미리보기와 다운로드만으로는 폰의 PDF 뷰어·HTML 처리 앱을 바로 사용할 수 없다. 원본 HTML과 미리보기 문서는 다르므로 다운로드의 원본 읽기 계약을 재사용해야 한다. 브라우저와 Android WebView는 파일을 여는 방법이 다르고, 호스트 HTML을 Remote origin에서 실행하면 인증 정보에 접근할 위험이 있다. 호스트 앱 실행, 디렉터리 전달, 대용량 스트리밍은 범위 밖이다.

## Decision

**파일 뷰어의 Download 옆 Open은 기존 인증된 원본 다운로드를 거쳐 Android 연결 앱 또는 브라우저 새 탭으로 파일을 연다.**

- 서버 route·lease·capability·전송 상한은 유지한다. 열기와 저장은 하나의 전송 중 상태를 공유하고, 파일 전환·lease 변경 이후 도착한 응답은 폐기한다.
- Android는 `LaymuxNative.openRemoteFile(name, mediaType, base64)`를 제공한다. 현재 문서 세대를 검사하고 기존 파일명 정규화·인코딩 전후 상한을 적용한다. 전용 private cache에 파일별 독립 경로로 저장하고 FileProvider의 `content:` URI와 임시 읽기 권한만 ACTION_VIEW로 전달한다. provider는 외부 공개하지 않으며 전용 하위 경로만 허용한다. 이전 파일은 이후 열기 시 24시간이 지난 것만 정리한다.
- 연결 앱 없음·잘못된 데이터·쓰기 실패는 메시지로 알린다. 구버전 APK는 업데이트 안내를 표시하고 다운로드로 조용히 대체하지 않는다. Downloads에 영구 사본을 만드는 동작은 기존 Download가 담당한다.
- 브라우저는 사용자 클릭 안에서 빈 탭을 먼저 열고 opener를 끊는다. PDF는 원본 Blob으로 이동하고, 표시 가능한 HTML·텍스트·JSON·XML·이미지는 새 탭의 sandbox iframe에서 표시한다. ZIP·일반 바이너리 등 지원 목록 밖의 MIME는 빈 탭을 닫고 Download 사용을 안내한다. sandbox는 스크립트·동일 origin 접근을 허용하지 않는다. frame-src에 blob:을 허용하되 다른 CSP 지시자는 유지한다. 실패·늦은 응답 시 빈 탭을 닫고 object URL은 지연 해제한다.

## Alternatives Considered

- 호스트 경로 URL을 외부 앱에 전달: 폰에는 그 경로가 없고 인증된 E2E 응답을 외부 앱이 읽을 수 없어 기각한다.
- Downloads 저장 후 열기: API 29 미만 제약과 매번 영구 사본을 남기는 비용 때문에 기각한다.
- HTML Blob으로 직접 top-level 이동: Remote origin 권한을 가진 활성 문서가 될 수 있어 기각한다. 브라우저의 스크립트 실행 제약을 수용한다.
- 별도 파일 공개 URL: 새로운 권한·노출 계약이 필요하므로 기존 바이트 경로를 선택한다.

## Consequences

폰의 설치 앱에 따라 열기 결과가 달라진다. HTML 상대 리소스는 함께 전송하지 않으므로 단일 파일 밖의 리소스는 보장하지 않는다. 브라우저 HTML 스크립트는 실행하지 않으며 완전한 웹사이트 호스팅이 아니다. 새 Android 브리지를 쓰려면 APK 업데이트가 필요하다. 임시 파일은 즉시 삭제하지 않아 외부 앱의 지연 읽기를 허용하지만 캐시 정리는 OS 또는 이후 열기에 의존한다. 전송·팝업·문서 변경 회귀와 좁은 화면 스크린샷, native URI 권한 검증이 필요하다.

FileProvider 구성은 [Android 공식 파일 공유 지침](https://developer.android.com/training/secure-file-sharing)을 따른다.
