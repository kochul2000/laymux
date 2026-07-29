# 0091. Remote 클라이언트는 gate 안쪽 web app manifest로 standalone 설치를 지원한다

- Status: Accepted
- Date: 2026-07-29
- Source: issue [#654](https://github.com/kochul2000/laymux/issues/654), [ADR-0013](0013-direct-remote-mode.md) §32/§43, architecture/api-contracts.md §13.0

## Context

폰에서 `/remote/` 를 열면 브라우저 chrome(주소 표시줄 + 하단 툴바)이 세로 공간을 상당히 먹는다. 터미널이 쓸 수 있는 행 수가 줄고, 스크롤·스와이프가 브라우저 UI 제스처와 경쟁한다. issue #654 는 "PWA 처럼 주소 표시줄을 생략한 표시"를 요구한다. 브라우저 전반에서 이를 제공하는 표준 경로는 origin 이 `display: standalone` 을 선언한 web app manifest 와 launcher 아이콘을 제공하고, 사용자가 홈 화면에 설치하는 것이다. iOS 의 오래된 `apple-*` 메타 경로도 호환용으로 함께 제공한다.

작용하는 force:

- **Direct Remote Mode 는 평문 HTTP** (`http://<host>:19280/remote/`) 다. secure context 가 아니므로 브라우저가 설치를 제안하지 않는다. 실제 설치가 성립하는 경로는 HTTPS 인 cloud relay(`laymux-server`) 뿐이다. 다만 사용자가 Tailscale/역프록시로 HTTPS 를 앞단에 두면 direct 경로도 설치 가능해진다.
- **`/remote/*` 는 전부 base access gate 뒤에 있다** — 실효 enabled + 실효 token + IP allowlist, 또는 cloud tunnel 의 `TunnelAuthorized`(api-contracts §13.1). 새 라우트를 gate 밖으로 빼는 것은 노출 정책 변경이다.
- **manifest fetch 는 기본적으로 credentials 를 생략한다.** gate 안쪽 manifest 를 기본 fetch 로 가져오면 401 이고 설치 프롬프트가 아예 뜨지 않는다.
- **cloud remote origin 의 CSP 는 `worker-src 'none'`** 이다(laymux-server `app/remote_origin.py`). service worker 등록은 현재 정책상 불가능하다.
- relay 자격 증명 쿠키는 `path=/remote`, TTL 8h 다. 설치된 앱의 실행 지점이 이 범위 밖이면 세션이 통하지 않는다.

범위: `/remote/` surface(remote 클라이언트 페이지와 그 자산)의 설치 계약. 비목표: 오프라인 동작·응답 캐싱·service worker, fullscreen 표시, `scope_extensions` 로 공개 오리진과 scope 를 합치는 것, Android 네이티브 셸(laymux-server M7), 공개 오리진(`app.laymux.com`) 자체의 manifest — 그 origin 은 laymux-server 가 소유한다.

## Decision

**manifest 와 launcher 아이콘은 remote 클라이언트를 서빙하는 쪽이 소유하고, 다른 `/remote/*` 자산과 똑같은 gate 를 통과한다.**

- 라우트는 `GET /remote/manifest.webmanifest`(`application/manifest+json`, `Cache-Control: no-store`)와 `GET /remote/pwa/{file}`(`image/png`, `Cache-Control: private, max-age=86400`)다. 두 라우트는 `remote_guard` 밖에 있고 vendor asset 과 동일한 `remote_asset_gate` 를 핸들러에서 적용한다. 등록되지 않은 아이콘 이름은 404 다.
- manifest 는 `display: standalone`, `scope` = `start_url` = `id` = `/remote/` 다. `display_override` 는 쓰지 않는다 — 요구는 주소 표시줄 제거이고, `fullscreen` 은 상태바(시계·배터리)까지 없애 요구 범위를 넘는다. `background_color`/`theme_color` 는 `--bg-base`(`#1e1e2e`)와 일치시켜 실행 splash 가 다른 색으로 번쩍이지 않게 한다.
- 아이콘 SoT 는 `ui/public/logo.svg` 다. `ui/scripts/build-pwa-icons.mjs`(`npm run build:pwa-icons`)가 192/512/maskable 512/apple-touch 180 PNG 를 `src-tauri/src/remote_server/assets/pwa/` 로 rasterize 하고, 결과는 `include_bytes!` 대상이므로 커밋한다. maskable 변형은 launcher 의 원형 crop 을 견디도록 마크를 0.6 배로 축소해 자체 배경 위에 올린다.
- `page.html` 의 manifest link 는 **`crossorigin="use-credentials"`** 를 반드시 갖는다. gate 안쪽 manifest 를 가져오는 유일한 방법이다.
- **service worker 는 두지 않는다.** 인증된 터미널 origin 에 SW 를 등록하면 세션보다 오래 사는 요청 가로채기가 생기고(설치 해제 후에도 남는다), 응답 캐싱은 자격 증명이 실린 응답을 디스크에 남길 위험을 만든다. cloud CSP `worker-src 'none'` 도 그대로 유지한다.
- iOS/iPadOS도 manifest의 `display`와 아이콘을 지원하지만, `apple-touch-icon`이 manifest 아이콘보다 우선하고 오래된 설치 경로는 `apple-*` 메타를 사용한다. 따라서 `apple-mobile-web-app-capable`, `apple-mobile-web-app-title`, `apple-touch-icon` 을 호환 경로로 함께 둔다. status bar style 은 `default` 로 고정한다 — `black-translucent` 는 터미널 첫 행을 시계 아래로 밀어 넣고 safe-area 보정을 요구하는데, `default` 는 그 문제 자체를 만들지 않는다. 따라서 이 결정은 `viewport` 를 바꾸지 않는다.
- 설치 성립 여부는 origin 의 보안 컨텍스트가 정한다. HTTP direct mode 에서 manifest 는 무해하게 무시되고, 라우트는 두 모드에 동일하게 제공한다.

## Alternatives Considered

- **service worker 추가.** Chrome 의 과거 설치 기준(fetch handler 를 가진 SW)을 확실히 만족시킬 수 있다. 그러나 cloud origin CSP 를 완화해야 하고, 자격 증명이 흐르는 origin 에 영속 인터셉터를 심는 비용·위험이 크며, 우리가 필요한 것은 오프라인 동작이 아니라 주소 표시줄 제거뿐이다. 실기에서 SW 없이 설치가 되지 않는다고 확인되면 이 결정을 재검토한다.
- **cloud server 가 manifest/아이콘을 인증 없이 대신 서빙.** Chrome 이 아이콘을 credential 없이 가져가는 경우까지 안전해지지만, 클라이언트와 그 자산 계약이 두 리포로 쪼개지고 direct mode 에는 여전히 없다. relay 는 transport 만 바꾼다는 ADR-0013 §32/§43 원칙과 어긋난다.
- **manifest 에 `data:` URI 아이콘 병기.** 아이콘 fetch 실패에 대한 hedge 지만 여기서 검증할 방법이 없고 manifest 를 비대하게 만든다. 실기 결과를 보고 필요할 때 넣는다.
- **`display: fullscreen`.** 상태바까지 사라져 요구 범위를 넘고, 알림·시계를 못 보는 대가가 크다.
- **공개 오리진 manifest 의 `scope_extensions` 로 remote origin 까지 한 앱으로 묶기.** 대시보드에서 터미널로 넘어갈 때도 설치 창을 유지할 수 있으나, 브라우저 지원이 아직 확정적이지 않아 검증 불가능한 코드가 된다. 후속 재검토 대상.

## Consequences

- 폰 홈 화면에서 실행하면 주소 표시줄 없이 터미널이 뜨고, `scope` 가 `/remote/` 이므로 `/remote/viewer/` 새 탭도 같은 설치 창 안에서 열린다.
- **위험 — 아이콘 fetch 자격 증명.** Chrome 이 WebAPK 아이콘을 credential 없이 가져오면 아이콘이 비거나 설치 프롬프트가 뜨지 않을 수 있다. 실기(Android Chrome) 확인 항목이며, 그렇게 확인되면 위 대안 2 로 좁혀 재검토한다. manifest 자체는 `use-credentials` 로 해결된다.
- **위험 — 만료된 relay 자격 증명.** 홈 화면 실행이 `/remote/` 로 바로 들어가므로 relay 쿠키(8h)가 만료된 뒤의 실행은 401 이고, 주소창이 없는 창에서는 사용자가 스스로 대시보드로 갈 방법이 마땅치 않다. laymux-server 가 remote origin 에서 HTML 내비게이션 401 을 scope 안의 재연결 페이지로 답해 이 막힘을 없앤다(별 리포 변경). 자격 증명 TTL 을 sliding 으로 바꾸는 것은 별도 결정이다.
- 아이콘은 생성 자산이므로 로고를 바꿀 때 `npm run build:pwa-icons` 를 같은 변경에서 돌려야 한다. `pwa.rs` 테스트가 manifest 가 광고한 크기와 실제 PNG IHDR 크기, 그리고 `page.html` 이 링크한 아이콘이 실제로 서빙되는지를 검증하므로 누락은 빌드에서 잡힌다.
- 실제 설치·standalone 표시는 자동 테스트로 검증할 수 없다(실기 확인). 자동 테스트는 계약(manifest 필드, 아이콘 크기, head 태그)까지만 담보한다.
- 재검토 조건: Android 네이티브 셸(M7) 도입, SW 없이는 설치가 안 된다는 실기 결과, `scope_extensions` 안정화, fullscreen 요구가 생기는 경우.
