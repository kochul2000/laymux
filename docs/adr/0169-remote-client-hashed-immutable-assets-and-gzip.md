# 0169. Remote 클라이언트는 셸 문서 + 콘텐츠 해시 불변 자산으로 분리하고 gzip 으로 전송한다

- Status: Proposed
- Date: 2026-08-16
- Source: 사용자 요구("page.html 사이즈 줄여라 — 분리·압축·minify 다 해라") · [ADR-0077](0077-remote-terminal-font-serving.md) · [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md) · [ADR-0168](0168-android-remote-resource-memory-cache-and-transfer-overlay.md)
- Extends: ADR-0077, ADR-0168

## Context

Remote main document(`/remote/`)는 384 KB 였고 그중 318 KB 가 인라인 앱 JS, 50 KB 가 인라인 CSS 다. 문서는 업데이트 즉시 반영을 위해 `no-store` 이므로 브라우저든 Android E2E 캐시(ADR-0168)든 매 접속마다 이 전량을 다시 받는다. vendor 자산(xterm.js 489 KB 등)은 캐시 헤더가 아예 없어 신선도 신호 없이 재전송되고, Android E2E resource RPC 는 압축 없이 원문을 base64 로 실어 1.33배로 부풀린다.

ADR-0168 은 desktop 이 명시한 `Cache-Control: max-age` 만 존중하는 opt-in 캐시를 정했으므로, 남은 문제는 desktop 이 자산에 캐시 정책을 명시할 수 있는 형태로 자산을 재구성하는 것이다. 범위는 Remote 클라이언트 자산의 배치·전송 형식이며, E2E RPC 의 인증·sequence·caller 헤더 금지 계약은 바꾸지 않는다. 조건부 요청(ETag)은 비목표다 — 셸이 16 KB 로 줄면 실익이 작다.

## Decision

**Remote 클라이언트는 (1) `no-store` 셸 문서와 콘텐츠 해시 URL 의 불변 자산(`/remote/asset/<stem>-<sha256 앞 16 hex>.<ext>`)으로 분리하고, (2) 앱 번들은 커밋된 minified 산출물로 서빙하며, (3) HTML/JS/CSS 는 `Accept-Encoding: gzip` 협상으로 압축 전송하고 Android E2E resource 경로도 desktop 압축 + Android 네이티브 해제로 같은 이득을 받는다.**

- 셸 `page.html` 은 마크업만 남기고 `{{ASSET:<논리 이름>}}` 자리표시자로 자산을 참조한다. 서버는 기동 시 자리표시자를 해시 URL 로 치환해 렌더한다. 셸은 계속 `no-store` — 진입점 URL 은 고정이어야 하고, 셸이 새 해시 URL 을 광고하는 것이 곧 자산 무효화다(ADR-0077 과 동일 원리).
- 해시 자산 라우트는 vendor 자산과 같은 base access gate 를 쓰고 `Cache-Control: private, max-age=31536000, immutable` 을 보낸다. `private` 인 이유도 폰트와 같다: cloud relay 가 경로에 있으므로 공유 캐시에 남기지 않는다. 자산 레지스트리(셸이 참조하는 파일의 정확한 집합)가 Android E2E resource allowlist 의 SoT 다 — 두 목록이 따로 놀지 않는다.
- 앱 소스 `remote-app.{js,css}` 는 가독 원본으로 `src-tauri/src/remote_server/assets/` 에 두고, `cd ui && npm run build:remote-page` 가 rolldown-vite 로 minify 한 `remote-app.min.{js,css}` 를 같은 위치에 생성·커밋한다(unicode-provider 선례). 산출물 배너에 소스 sha256 을 찍고 ui 테스트가 드리프트를 잡는다.
- gzip 은 기동 시 자산별로 한 번 사전 압축한다. E2E resource dispatch 는 내부 요청에 `Accept-Encoding: gzip` 을 붙이고 `content-encoding` 헤더를 RPC 응답으로 전달하며, Android 는 AEAD 검증 뒤 네이티브에서 bounded 해제(2 MiB 상한, 미지원 인코딩은 fail closed) 후 WebView 에 평문을 준다. 압축 대상은 컴파일 내장 정적 자산뿐이라 비밀·호출자 데이터가 압축 스트림에 섞이지 않으므로 CRIME 류 공격은 성립하지 않는다.
- 기존 `/remote/vendor/*` 고정 라우트는 구버전 클라이언트·allowlist 호환을 위해 유지하되 서빙 페이지는 더 이상 참조하지 않는다.

## Alternatives Considered

- **page.html 에 ETag + 조건부 재검증.** 문서까지 재검증 한 번으로 줄지만 E2E RPC plaintext 에 조건부 필드를 추가하는 계약 확장이 필요하다. 분리 후 셸은 16 KB(gzip ~5 KB)라 왕복 대비 실익이 작아 기각.
- **vendor URL 에 버전 쿼리스트링.** E2E resource 경로는 쿼리를 금지하고(allowlist), 쿼리 기반 무효화는 중간 캐시에서 신뢰성이 낮다. 파일명 해시를 택했다.
- **brotli 를 E2E 에도 사용.** 폰트 route 의 선례가 있지만 Android 표준 라이브러리에 brotli 디코더가 없어 의존성이 추가된다. gzip 은 JDK 내장이고 정적 자산에서 압축률 차이가 작다.
- **WebView HTTP 캐시 활성화로 해시 URL 캐싱.** 복호화된 E2E 자원이 디스크에 영속된다. ADR-0168 의 메모리 전용 원칙과 충돌해 기각.
- **minify 없이 gzip 만.** 전송량은 비슷하게 줄지만 Android 메모리 캐시와 WebView 파싱이 원문 크기를 그대로 진다. 커밋 산출물 + 드리프트 테스트 비용으로 번들 99 KB(원문 318 KB)를 택했다.

## Consequences

- 재연결 전송: 폰트·아이콘(ADR-0168 캐시) + 해시 자산(본 ADR) 캐시 적중 시 **gzip 셸 ~5 KB 만 남는다**. 첫 연결도 원문 ~905 KB 대신 gzip ~120 KB 수준으로 준다.
- 앱 JS/CSS 수정 시 `npm run build:remote-page` 재실행이 필요하다. 잊으면 ui 드리프트 테스트가 실패한다. 셸 자리표시자에 없는 자산을 추가하면 기동 시 렌더 assert 가 잡는다.
- 바이너리에 vendor 원문 + minified 번들 + 사전 gzip 본이 함께 실려 실행 파일이 수백 KB 커진다. 서빙 단순성을 위해 수용한다.
- 신버전 desktop + 구버전 Android 조합은 구버전이 `content-encoding` 을 버리고 압축 본을 평문으로 취급해 Remote UI 가 깨진다. 내부 개발 단계 정책(AGENTS.md "마이그레이션 불필요", ADR-0146 의 "한쪽만 업데이트된 경우 실패" 수용과 동일)에 따라 이 조합은 지원하지 않으며, APK 와 desktop 은 같은 릴리즈로 함께 배포·갱신한다.
- 인라인 스크립트가 사라져 Remote 문서에 `script-src 'self'` CSP 를 걸 수 있는 길이 열렸다 — 별도 후속 결정.
