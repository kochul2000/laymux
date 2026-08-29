# 0214. Remote 셸은 데스크톱 앱 origin 에만 프레임을 허용하고, 모바일 모드 탈출구는 호스트가 소유한다

- Status: Proposed
- Date: 2026-08-29
- Source: issue [#955](https://github.com/kochul2000/laymux/issues/955)(모바일 모드 전환 시 빈 오버레이에 갇힘), [ADR-0041](0041-remote-served-file-viewer.md)(viewer 문서 CSP), [api-contracts.md §7·§13](../architecture/api-contracts.md)
- Amends: [ADR-0183](0183-remote-page-content-security-policy.md) Decision 6 의 `frame-ancestors 'none'` 결정

## Context

데스크톱 앱의 **모바일 모드**는 같은 프로세스가 서빙하는 Remote 셸(`/remote/?localApp=1`)을 앱 WebView 안 iframe 으로 띄우는 뷰다. 즉 Remote 셸에는 성격이 다른 두 소비자가 있다 — 네트워크 너머의 브라우저·폰(top-level 문서)과, 앱 자신(임베드된 문서).

ADR-0183 은 셸에 CSP 를 도입하면서 `frame-ancestors 'none'` 으로 clickjacking 경로를 닫았다. 그 directive 는 소비자를 구분하지 않는다. 결과적으로 앱이 자기 자신의 뷰를 임베드하는 경로까지 함께 막혔고, 모바일 모드는 도입 시점(#890)부터 빈 프레임만 남았다.

빈 프레임에 그치지 않고 **앱 전체가 갇힌** 것이 이 결정을 부른 실제 force 다. 오버레이의 유일한 탈출 경로가 임베드된 페이지가 보내는 `postMessage` 였기 때문이다. 페이지가 뜨지 못하면 그 메시지도 없고, 호스트에는 ESC 도 버튼도 없어 프로세스를 죽이는 것 외에 방법이 없었다. 임베드 실패는 조용하다 — 프레임이 거부돼도 iframe 의 `load` 는 그대로 발생하므로, 호스트는 "로드됐는지" 를 자기 힘으로 알 수 없다.

제약은 셋이다.

- **임베더 origin 은 remote origin 이 아니다.** 셸은 `http://127.0.0.1:<port>` 에서 오고 임베더는 앱 WebView origin 이므로 `frame-ancestors 'self'` 로는 풀리지 않는다.
- **앱 origin 은 빌드마다 다르다.** Tauri WebView 는 Linux/macOS 에서 `tauri://localhost`, Windows/Android 에서 `http://tauri.localhost` 이고, dev 는 Vite 의 `http://localhost:1420` 이다.
- **clickjacking 방어는 유지해야 한다.** 셸은 터미널 제어권과 lease 자격 증명을 쥐고 있으므로 임의 웹 페이지의 프레임은 계속 거부돼야 한다.

범위는 `/remote/` 셸 문서의 `frame-ancestors` 와 모바일 모드 오버레이의 종료 경로다. viewer 문서 정책(ADR-0041), Android app-mode 문서 정책(ADR-0149), cloud relay 가 자기 origin 에서 더하는 정책은 대상이 아니다.

## Decision

**`/remote/` 셸은 데스크톱 앱 WebView origin 만 `frame-ancestors` 에 허용하고, 모바일 모드 오버레이의 종료 경로는 임베드 성공 여부와 무관하게 호스트가 소유한다.**

1. `frame-ancestors` 는 닫힌 허용목록이다. 값은 `page-csp.txt` 의 `__APP_FRAME_ANCESTORS__` 자리에 Rust 가 채워 넣으며, 목록은 `tauri://localhost` 와 `http://tauri.localhost` 두 WebView origin 이다. 와일드카드·scheme 전체 허용·`https:` 는 어느 시점에도 넣지 않는다. `'self'` 는 임베더가 remote origin 이 아니므로 답이 아니다.
2. **Vite dev origin(`http://localhost:1420`)은 debug 빌드에만 컴파일된다.** 릴리스 바이너리는 1420 포트에 무엇이 응답하든 신뢰하지 않는다. 정책은 요청에서 읽은 값이 아니라 빌드에 고정된 상수이므로, 클라이언트가 제어하는 입력(`Host`, 쿼리 파라미터 `localApp=1`)이 프레임 허용목록을 넓히는 경로는 없다.
3. **호스트는 임베드가 실제로 떴는지를 명시적 인사로만 판단한다.** `localApp=1` 로 부팅한 셸은 `laymux:mobile-mode-ready` 를 부모에게 보낸다. 거부된 프레임도 `load` 를 발생시키므로 `load` 는 신호로 쓰지 않는다.
4. **호스트는 임베드가 인사하지 않아도 빠져나갈 수 있다.** 인사가 타임아웃 안에 오지 않으면 오버레이가 자기 마크업으로 "PC 모드로 돌아가기" 를 그린다. ESC 는 **인사가 오기 전까지** 오버레이를 닫는다 — 인사한 뒤의 ESC 는 살아 있는 모바일 뷰가 자기 drawer·오버레이용으로 갖는다. 임베드 안쪽에 종료 경로의 단일 의존을 두지 않는 것이 이 조항의 요지다.
5. **오버레이의 `postMessage` 수신은 임베드 origin 으로 제한하고, 비교할 origin 이 없으면 받지 않는다.** 셸은 호스트 파일을 자기 sandbox iframe 안에서 렌더하므로 그 중첩 문서가 `window.top` 을 통해 데스크톱 레이아웃을 바꾸는 경로를 열어 두지 않는다. URL 에서 origin 을 얻지 못하는 경우도 fail-closed 로 처리한다 — 탈출구가 ESC 와 타임아웃 카드에 따로 있으므로 거부해도 갇히지 않는다.
6. **인사·타임아웃 판정은 URL 이 아니라 진입 회차로 키잉한다.** 같은 port·token 은 매번 같은 URL 문자열을 만들고 오버레이 컴포넌트는 언마운트되지 않으므로, URL 로 키잉하면 두 번째 진입이 첫 번째의 판정을 물려받아 4 조항의 보장이 무너진다.

## Alternatives Considered

- **`localApp=1` 요청에만 다른 `frame-ancestors` 를 응답**: 정책이 top-level 소비자에게는 `'none'` 그대로 남아 가장 좁아 보인다. 그러나 분기의 근거가 클라이언트가 정하는 쿼리 파라미터이므로, 외부 사이트도 `?localApp=1` 로 같은 응답을 받는다 — 실제 경계는 어느 쪽이든 origin 허용목록이고, 분기는 그 사실을 가린 채 캐시·프록시 계층에 응답 변주만 늘린다.
- **`frame-ancestors 'self'` 로 완화**: 한 줄이면 끝난다. 그러나 임베더는 앱 origin 이고 문서는 remote origin 이라 프레임이 여전히 거부된다. 증상을 안 고치면서 정책만 넓히는 선택이다.
- **`frame-ancestors` 를 지우고 X-Frame-Options 도 두지 않음**: 모바일 모드는 살아나지만 임의 웹 페이지가 터미널 제어 문서를 프레임할 수 있게 된다. ADR-0183 이 닫은 경로를 되열므로 기각한다.
- **iframe 대신 별도 앱 창(WebviewWindow)으로 모바일 모드를 띄움**: CSP 문제 자체가 사라진다. 그러나 모바일 모드는 "지금 이 창이 폰처럼 보인다" 는 뷰 전환이고, 창을 나누면 포커스·항상 위·닫기 처리를 새로 정의해야 한다. 프레임 경계 하나를 고치는 것보다 비용이 크다.
- **릴리스에도 dev origin 을 허용목록에 유지**: 상수 하나로 끝나고 빌드별 분기가 없다. 그러나 사용자 머신의 1420 포트에 응답하는 무엇이든 터미널 제어 문서를 프레임할 수 있게 된다. 보수적으로 좁히는 쪽을 기본값으로 한다.
- **호스트 탈출구 없이 CSP 만 수정**: 지금 증상은 사라진다. 그러나 임베드가 실패할 이유는 CSP 말고도 있다(서버 미기동, 포트 변경, 토큰 없음). 탈출구가 임베드 안에만 있는 구조가 남는 한 다음 실패에서 다시 갇힌다 — 그래서 두 조항을 한 결정으로 묶는다.

## Consequences

- 정책이 빌드 타입에 따라 달라진다. `page-csp.txt` 만 읽어서는 서빙되는 정책 전체를 알 수 없고, 값은 `page.rs` 의 상수와 함께 봐야 한다. Playwright 헬퍼는 같은 자리를 `'none'` 으로 치환한다 — 목록을 TS 로 복제하면 `page-csp.txt` 가 없애려던 cross-language drift 가 그 자리에 되살아나고, 스펙은 top-level 문서로 돌아 이 directive 를 건드리지 않기 때문이다.
- 앱 WebView origin 이 바뀌면(Tauri 업그레이드, 새 플랫폼 추가) 모바일 모드가 조용히 빈 프레임으로 되돌아간다. 이 상수는 Tauri WebView origin 계약에 묶인 부채이고, 호스트 탈출구가 그 실패를 "앱이 죽는 사고" 대신 "돌아가기 버튼이 뜨는 상태" 로 낮춘다.
- `laymux:mobile-mode-ready` 는 셸과 데스크톱 오버레이 사이의 계약이 된다. `laymux:desktop-mode` 와 함께 두 메시지가 이 경계의 전부이며, 둘 다 임베드 origin 에서 온 것만 받는다. 인사는 파라미터 파싱 직후 무조건 보낸다 — 토큰이 없거나 연결에 실패해도 "문서는 떴다" 는 사실은 참이고, 그 상태에서는 셸 자신의 PC 모드 버튼이 탈출구가 된다.
- 인사 타임아웃은 오탐이 가능하다(느린 부팅). 오탐의 결과는 잘 뜬 화면 위에 카드가 한 장 뜨는 것이고, 카드는 프레임을 덮지 않으며 사용자는 무시할 수 있다. 반대 방향 오류(갇힘)의 비용이 비대칭적으로 크므로 이 방향으로 기울인다.
- 테스트는 Rust 단위(허용목록 구성, dev origin 이 debug 빌드에만 존재, 셸이 인사를 보냄)와 UI 단위(타임아웃 뒤 호스트 버튼 노출, 인사 후 미노출, 인사 전 ESC 종료, 타 origin 메시지 무시, 재진입 시 판정 초기화)로 나눈다. 실제 WebView 에서 프레임이 뜨는지는 자동 검증 대상이 아니다 — release WebView origin 은 dev 실행으로 재현되지 않으므로, 릴리스 빌드에서 모바일 모드를 한 번 눈으로 확인한 뒤 배포한다.
