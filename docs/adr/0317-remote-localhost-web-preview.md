# 0317. Remote localhost 웹 프리뷰는 고정 origin의 읽기 세션과 격리된 실행 표면을 사용한다

- Status: Superseded by [0318](0318-revert-remote-localhost-preview.md)
- Date: 2026-10-11
- Source: 사용자 요구(`http://localhost:8765`의 Godot 게임을 Remote에서 실행), [api-contracts.md §13](../architecture/api-contracts.md), [ADR-0175](0175-remote-oauth-loopback-relay.md)
- Extends: ADR-0175의 loopback 중계. OAuth의 1회용 callback 계약은 유지한다.
- Extends: [ADR-0208](0208-android-e2e-file-viewer-typed-capability.md)의 비밀 capability·정확한 E2E 소유자·캐시 재전송 검증을 localhost 읽기에 적용한다.
- Applies: [ADR-0215](0215-remote-page-frames-only-the-desktop-app.md)의 앱 조상 allowlist를 직접 접속 프리뷰에 그대로 적용한다. Cloud는 기존 Remote origin의 같은-origin framing만 허용한다.

## Context

Remote에서 localhost 링크를 그대로 열면 원격 기기의 loopback에 접속한다. OAuth 중계는 GET 한 번과 64 KiB 응답을 위한 계약이므로, HTML·JavaScript·약 40 MB WASM·게임 데이터를 지속적으로 읽는 웹 프리뷰에는 사용할 수 없다. Cloud 및 Android E2E의 개별 응답 상한도 대형 게임 자산보다 작다.

임의 웹 앱을 Remote 셸 origin에서 실행하면 브라우저 저장소와 터미널 제어 권한에 접근할 수 있다. Android의 JavaScriptInterface는 하위 frame에서도 보이므로 iframe sandbox만으로 네이티브 브리지를 격리할 수 없다. 이번 범위는 단일 스레드 Godot를 포함한 HTTP 정적 웹 프리뷰이며, 임의 TCP·WebSocket·폼 쓰기·쿠키 로그인·Service Worker·멀티스레드 WASM은 포함하지 않는다.

## Decision

**명시적으로 연 localhost 링크의 HTTP origin 하나를 active lease에 묶어 읽고, 웹 앱은 Remote 권한을 갖지 않는 별도 표면에서 실행한다.**

- `begin/resource/close` POST는 기존 Remote 인증·active lease와 제어권 claim에서 발급한 비밀 FileViewer capability를 요구한다. 공개된 lease ID만으로는 접근할 수 없다. Android E2E는 암호화된 구조적 proof로 capability와 lease를 전달하고 정확한 instance/session·owner epoch·capability generation을 검사한다. 대상은 HTTP loopback의 1024 이상 포트이며 laymux의 19280/19281은 거부한다. 등록 후 host·port는 변경되지 않고 다른 origin으로 redirect하지 않는다. 프록시 환경변수·Remote 토큰·쿠키·인증 헤더를 upstream으로 전달하지 않는다.
- 세션은 AppState가 소유하는 단일 슬롯이며 새 begin은 이전 세션을 대체한다. lease id 변경·만료·Remote 비활성화 후에는 읽을 수 없다. 절대 수명은 30분이고 명시적 close는 캐시를 폐기한다.
- 비동기 슬롯은 Remote access/control 락보다 앞서는 predecessor다. 번호 락을 잡은 채 슬롯을 기다리지 않으며, 슬롯 획득 뒤와 다운로드 완료 뒤에 capability와 소유자를 재검증한다. E2E 캐시 재전송도 동일하게 검사하며, 응답의 비밀 아닌 receipt에 해당 프리뷰 슬롯의 약한 수명 참조·절대 만료 시각을 붙여 close·새 begin·수명 종료 후 이전 응답을 반환하지 않는다.
- upstream 파일은 한 번 읽어 세션 안에서 보관한다. 파일별 64 MiB·세션 합계 128 MiB·파일 수 128개를 상한으로 하고, 실제 스트림 수신 중 상한을 검사한다. resource는 최대 512 KiB씩 base64 JSON으로 반환하여 기존 Browser 및 Android E2E transport를 사용한다. 세션 슬롯의 비동기 직렬화로 겹치는 다운로드와 교체가 메모리 상한을 우회하지 못한다.
- 브라우저에서는 별도 bootstrap 문서의 opaque-origin sandbox 안에서 앱을 실행한다. 부모 Remote가 검증한 메시지만 읽기 API로 전달한다. bootstrap 문서만 inline script·WASM 실행을 허용하며 Remote 셸의 script 정책은 넓히지 않는다. Cloud는 셸 framing을 정확한 bootstrap URL과 기존 blob 파일 문서로 제한하고, 이 문서에만 별도 고정 sandbox 정책을 적용한다. Caddy의 상호 배타적 deferred 헤더로 upstream과의 중복 CSP/XFO를 방지한다.
- Android에서는 브리지 없는 별도 WebView가 전용 synthetic origin의 요청을 native에서 읽기 API로 변환한다. 원격 셸과 키·네트워크 권한을 공유하는 JavaScriptInterface를 설치하지 않는다. 기존 foreground/E2E 수명 정책을 유지한다.

## Alternatives Considered

- localhost URL의 host만 Remote host로 치환: loopback에만 bind한 서버에 도달하지 못하고 Cloud/E2E 연결도 지원하지 못한다.
- 기존 OAuth forward 재사용: 1회용·64 KiB 상한과 충돌하고 웹 자산의 반복 읽기를 지원하지 못한다.
- 셸과 같은 origin에서 reverse proxy: 앱 코드에 Remote 저장소·네이티브 브리지가 노출된다.
- 공개 터널 생성: 새 외부 서비스 의존성과 인증 없는 공개 노출이 생긴다.

## Consequences

- 실행 중인 정적 개발 웹 앱을 Remote에서 읽고 실행할 수 있으며 대형 WASM도 기존 암호화 연결을 유지한다.
- 자산은 세션 내 snapshot이므로 변경된 빌드를 보려면 프리뷰를 다시 연다. 메모리 비용은 제한되지만 PC의 최대 128 MiB와 클라이언트의 로딩 자산 메모리가 추가된다.
- POST·WebSocket·로그인 쿠키·Service Worker·멀티스레드 WASM 지원이 필요하면 별도 계약과 실행 origin 전략을 결정한다.
- 검증은 lease·origin·redirect·상한·chunk 경계의 Rust 회귀 테스트와 격리/실제 Godot 로딩의 브라우저 테스트, Android origin/수명 테스트로 나눈다. 기능 추가이므로 버전 영향은 minor다.
