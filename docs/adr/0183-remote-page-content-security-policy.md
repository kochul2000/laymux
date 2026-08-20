# 0183. Remote 셸 문서에도 CSP 를 적용하고 WebSocket source 는 검증된 Host 만 반영한다

- Status: Proposed
- Date: 2026-08-20
- Source: 사용자 요구(Remote FileViewer 를 새 탭에서 인페이지 오버레이로 옮기기 전 보안 선행 조건), [api-contracts.md §13](../architecture/api-contracts.md), [ADR-0041](0041-remote-served-file-viewer.md)·[ADR-0044](0044-remote-file-viewer-explicit-host-path.md)(viewer 문서 CSP), [ADR-0169](0169-remote-client-hashed-immutable-assets-and-gzip.md)(해시 자산 분리)

## Context

Remote 표면에는 문서가 둘 있다. `/remote/`(셸)과 `/remote/viewer/`(FileViewer bootstrap)이다. ADR-0041 이 viewer 문서에는 `default-src 'none'` 기반 CSP 를 걸었지만, 셸 문서는 `Cache-Control`·`Content-Type`·`Vary` 만 보내고 **CSP 가 없다**. 즉 지금은 "호스트 파일 내용을 보는 문서에는 정책이 있고, 터미널 제어권과 lease 자격 증명을 들고 있는 문서에는 정책이 없다"는 비대칭 상태다.

이 비대칭이 곧 문제가 된다. FileViewer 를 새 탭에서 셸 안 오버레이로 옮기는 후속 결정을 검토하는 중인데, 그 이동은 파일 바이트를 정책 있는 문서에서 정책 없는 문서로 옮기는 것이 되어 실질적 후퇴가 된다. 오버레이 결정을 내리기 전에 셸 문서의 기준선을 먼저 올려야 한다.

셸은 이 정책을 받을 준비가 이미 되어 있다. ADR-0169 가 앱 번들과 스타일을 해시 자산으로 분리한 뒤 `page.html` 에는 inline `<script>`, inline `<style>`, inline event handler, `style=` 속성이 하나도 없고 클라이언트 코드에 `eval`/`new Function` 도 없다.

제약은 셋이다.

- **xterm 은 `<style>` 을 주입한다.** DOM 렌더러가 셀 크기·테마·decoration 을 위해 생성한 `<style>` 요소를 붙인다. `style-src` 를 조이면 터미널이 렌더되지 않는다.
- **`'self'` 와 WebSocket.** CSP3 는 same-origin `ws:`/`wss:` 를 `'self'` 가 포함한다고 규정하지만 Safari 는 그렇지 않게 동작한 릴리스를 출시한 이력이 있다. output socket 은 이 제품의 본체이므로 브라우저 해석에 걸 수 없다.
- **`Host` 는 클라이언트가 정한다.** WebSocket source 를 요청 Host 로 만들면 헤더에 directive 를 실어 정책을 넓히는 CSP injection 경로가 열린다.

범위는 `/remote/` 셸 문서의 응답 헤더다. viewer 문서 정책(ADR-0041), cloud relay 가 자기 origin 에서 추가하는 정책, 해시 자산·폰트·PWA 아이콘 route 의 헤더는 이 결정의 대상이 아니다.

## Decision

**`/remote/` 셸 문서는 `default-src 'none'` 기반 CSP 와 `Referrer-Policy: no-referrer`·`X-Content-Type-Options: nosniff` 를 함께 보내고, `connect-src` 의 WebSocket source 는 `host[:port]` 문법을 통과한 요청 `Host` 만 반영한다.**

1. 정책 본문은 `src-tauri/src/remote_server/page-csp.txt` 한 파일이 소유한다. Rust route 가 `include_str!` 로 컴파일 내장하고, Playwright 헬퍼가 같은 파일을 읽어 mock 응답에 실어 서빙되는 정책 그대로 스위트를 돌린다. 정책을 두 언어에 중복 기술하지 않는다.
2. `script-src 'self'` 가 이 결정의 실질 경계다. 셸에는 inline script·inline handler·`eval` 이 없으므로 `'unsafe-inline'`/`'unsafe-eval'` 은 어느 시점에도 추가하지 않는다. 추가가 필요해 보이면 정책을 넓히는 대신 그 코드를 해시 자산으로 옮긴다.
3. `style-src` 는 `'self' 'unsafe-inline'` 을 유지한다. xterm DOM 렌더러의 `<style>` 주입이 이유이며, 이는 의도적 예외로 고정한다. CSS-only 주입에는 HTML sink 가 필요하고 셸은 렌더한 파일을 항상 sandbox iframe 안에만 넣으므로 그 sink 가 없다.
4. `manifest-src 'self'` 와 `img-src 'self' data:` 를 명시한다. 설치형 클라이언트(ADR-0091)의 manifest·아이콘이 정책에 막히면 설치가 조용히 깨지므로 이 두 directive 는 정책의 필수 구성이다.
5. `connect-src` 는 `'self'` 에 더해 검증된 Host 로부터 만든 `ws://<authority>` 와 `wss://<authority>` 를 갖는다. 검증은 bare authority 문법(`host[:port]`, IPv6 는 대괄호 유지, port 는 최대 5자리 숫자)이며, 통과하지 못하면 WebSocket source 를 **생략**한다. 검증 실패는 정책을 넓히는 대신 좁히는 방향으로만 처리한다.
6. `frame-ancestors 'none'`·`base-uri 'none'`·`form-action 'none'`·`object-src 'none'` 로 clickjacking·base 하이재킹·폼 유출·플러그인 경로를 닫는다.

## Alternatives Considered

- **`connect-src 'self'` 만 두고 CSP3 해석에 의존**: 정책이 가장 단순하고 Host 를 전혀 읽지 않아도 된다. 그러나 Safari 에서 output socket 이 막히면 제품이 동작하지 않는 회귀이고, 그 실패는 특정 브라우저 버전에서만 나타나 발견이 늦다. 기능 정지 위험이 Host 검증 비용보다 크다고 판단해 기각한다.
- **`connect-src 'self' ws: wss:`**: Host 를 읽지 않으면서 Safari 문제를 피한다. 그러나 임의 host 로의 WebSocket 을 허용해 CSP 가 막아야 할 exfiltration 경로를 스스로 열어 둔다. scheme 전체 허용은 이 정책의 목적과 정면으로 어긋난다.
- **Host 검증 없이 그대로 echo**: 구현이 가장 짧지만 `Host: evil.example; script-src *` 같은 헤더가 정책 자체를 재작성한다. CSP 를 도입하면서 CSP injection 을 만드는 선택이라 기각한다.
- **`style-src` 에서 `'unsafe-inline'` 제거 + nonce 전파**: 정책은 가장 강해지지만 vendored xterm 을 패치해 nonce 를 주입해야 한다(리포는 이미 `ui/scripts/patch-xterm-reflow.mjs` 로 xterm 을 패치하므로 불가능하지는 않다). 이번 결정의 목적은 셸의 기준선을 세우는 것이고, script 경계는 이미 엄격하므로 vendor 패치 부채를 지금 지지 않는다. 재검토 조건은 Consequences 에 남긴다.
- **정책을 Rust 상수로만 두고 e2e 에는 복붙**: 파일 하나를 더 만들지 않아도 된다. 그러나 두 언어에 같은 문자열이 생기는 순간 드리프트가 시작되고, 드리프트는 "서빙되는 정책은 막는데 테스트는 통과하는" 형태로 나타나 가장 늦게 발견된다.

## Consequences

- 셸 문서가 viewer 문서와 같은 등급의 정책을 갖게 되어, FileViewer 를 셸 안 오버레이로 옮기는 후속 결정이 "정책 있는 문서 → 정책 없는 문서" 이동이 아니게 된다. 그 이동 자체는 별도 ADR 에서 결정한다.
- `page-csp.txt` 는 서빙 계약이다. directive 를 추가·삭제하면 Rust 단위 테스트와 Playwright 스위트가 함께 움직이며, 셸에 inline script 나 외부 origin 자산을 새로 넣는 변경은 정책 수정 없이는 통과하지 못한다. 이는 의도된 마찰이다.
- Android 앱 경로는 자동으로 같은 정책을 받는다. resource RPC 가 `Content-Security-Policy`·`X-Content-Type-Options`·`Referrer-Policy` 를 이미 전달하기 때문이다. 앱 문서는 WebSocket 대신 네이티브 transport 를 쓰고 RPC 요청에 `Host` 가 없어 WebSocket source 는 생략된다 — 앱에는 필요가 없으므로 정상이다.
- Cloud relay 를 경유하면 브라우저가 relay 정책과 이 정책을 **교집합**으로 적용한다. relay 가 셸 자산을 같은 origin 에서 서빙하는 현재 구성에서는 좁혀지는 directive 가 없어야 하지만, relay 정책은 이 리포 밖에 있으므로 실 cloud 경로에서 터미널 연결·설치·폰트 적재를 한 번 확인한 뒤 머지한다.
- `style-src` 의 `'unsafe-inline'` 은 남는 부채다. xterm 이 nonce 또는 CSSOM 기반 스타일 주입을 지원하거나, 리포의 xterm 패치 파이프라인에 nonce 주입을 추가할 여력이 생기면 이 directive 를 조이는 별도 ADR 로 재검토한다.
- 테스트는 Rust 단위(정책 구성, 검증된 Host 반영, IPv6 authority, 조작된 Host 에서 socket source 생략, hardening 헤더)와 Playwright(전체 Remote 스위트를 서빙 정책 아래 실행)로 나눈다. `page.setContent` 기반 스펙은 헤더가 없는 경로라 정책을 검증하지 않는다 — 그 스펙들은 xterm 없이 마크업만 확인하는 계층이므로 의도된 공백이다.
