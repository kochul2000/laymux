# 0184. Remote FileViewer 는 새 탭이 아니라 Remote 문서 안 오버레이로 렌더한다

- Status: Proposed
- Date: 2026-08-20
- Source: 사용자 보고(안드로이드 앱에서 File viewer 가 아예 보이지 않음), [ADR-0041](0041-remote-served-file-viewer.md)·[ADR-0044](0044-remote-file-viewer-explicit-host-path.md), [ADR-0183](0183-remote-page-content-security-policy.md), [api-contracts.md §13](../architecture/api-contracts.md)
- Supersedes: [ADR-0041](0041-remote-served-file-viewer.md) 의 Decision 1·3(자격 증명 없는 `/remote/viewer/` 새 탭과 `postMessage` 세션 전달)

## Context

ADR-0041 은 호스트 파일을 사용자 제스처로 연 `/remote/viewer/` 새 탭에 same-origin `postMessage` 로 세션을 한 번 넘겨 렌더하도록 정했다. 그 결정 이후 표면이 늘었고, 새 탭이라는 전제가 표면마다 다르게 깨진다.

- **안드로이드 앱**: 래퍼 WebView 는 `setSupportMultipleWindows(false)`·`javaScriptCanOpenWindowsAutomatically = false` 이므로 `window.open` 이 `null` 을 돌려준다. 더 근본적으로 앱은 Remote 를 HTTP origin 으로 띄우지 않고 RPC 로 문서 하나만 설치하므로 두 번째 문서가 존재할 수 없다. 그래서 드로어의 File viewer 섹션은 앱에서 아예 숨겨져 있었다 — 기능이 없는 게 아니라 닿을 수 없어서 감춘 것이다.
- **설치형 PWA**: standalone 창에서 `window.open` 은 커스텀 탭/인앱 브라우저로 열리고 opener 관계가 끊긴다. 그러면 child 는 `laymux:file-viewer-ready` 를 보낼 상대가 없어 "Open this viewer from a connected Laymux Remote page." 에서 멈춘다.
- **일반 브라우저**: 동작하지만 팝업 차단 설정에 걸린다.

즉 새 탭 전제는 이 제품의 주 사용 표면 두 곳에서 성립하지 않는다.

새 탭이 격리를 준다는 인식도 코드와 맞지 않는다. `/remote/viewer/` 는 Remote 와 **같은 origin** 이므로 브라우징 컨텍스트만 달랐고, 실제 경계는 sanitize 결과를 빈 `sandbox` iframe 의 `srcdoc` 에만 넣는 규칙이었다. 빈 sandbox 는 `allow-scripts`·`allow-same-origin` 이 모두 없어 스크립트 실행 자체를 끈다.

새 탭이 실제로 제공한 이점은 하나다: 그 문서만의 좁은 CSP. 셸 문서에는 CSP 가 없었으므로 렌더를 셸로 옮기는 것은 "정책 있는 문서 → 정책 없는 문서" 이동이 된다. 그래서 ADR-0183 이 셸 문서 CSP 를 선행 조건으로 세웠고, 이 결정은 그 위에서만 성립한다.

범위는 렌더가 일어나는 문서와 그 문서에 도달하는 경로다. lease-gated render/status/path-link API 계약(ADR-0042·0044), 8 MiB 상한, typed preview 정책(ADR-0109), 외부 viewer 미실행 원칙은 그대로 두며 변경 대상이 아니다. 파일 저장/다운로드는 비목표다.

## Decision

**Remote FileViewer 는 `/remote/viewer/` 문서를 없애고 Remote 셸 문서 안 오버레이에서 렌더하며, sanitize 된 문서는 계속 빈 `sandbox` iframe 안에만 들어간다.**

1. `/remote/viewer/`·`/remote/viewer/viewer.js` route 와 `viewer_page.{rs,html,js}` 를 제거한다. 자격 증명을 두 번째 문서로 넘기는 `window.open` + `laymux:file-viewer-ready`/`-session` 핸드셰이크도 함께 사라진다 — 같은 문서 안에서는 전달할 대상이 없고, 전달하지 않는 자격 증명은 유출될 수 없다.
2. 렌더 경로는 기존 `POST /remote/v1/file-viewer/render` 하나를 그대로 쓴다. 클라이언트는 이미 보유한 lease·capability 로 호출하고 응답을 오버레이에 그린다. 표면별 분기는 없다 — 앱도 같은 클라이언트 코드가 RPC 브리지를 통해 같은 API 를 호출한다.
3. 보안 경계는 렌더 종류별로 고정한다. text 는 `textContent`, image 는 `data:image/*` 검증을 통과한 `src`, HTML/Markdown preview 는 `sandbox=""` iframe 의 `srcdoc` 이다. 어떤 경로도 파일 내용을 셸 문서의 HTML 로 삽입하지 않는다. 이 세 갈래는 새 탭 시절과 동일하며, 이 결정으로 약해지지 않는다.
4. 안드로이드 앱에서 File viewer 섹션을 숨기던 분기를 제거한다. 숨김의 근거는 두 번째 창의 부재였고, 그 근거가 사라졌다.
5. 오버레이는 표면을 채우고 `Escape`·닫기 버튼·backdrop 클릭으로 닫는다. `Escape` 는 capture 단계에서 소비한다 — 그러지 않으면 읽던 파일을 닫으려는 키가 PTY 로 ESC 로 흘러간다. 파일 본문 클릭은 닫지 않는다(읽기·선택·스크롤이다).
6. 오버레이는 자기 줌을 가진다. 이미지는 실제 width, 텍스트는 font-size 로 확대하며 transform 은 쓰지 않는다 — 스케일된 요소는 원래 박스를 유지해 스크롤 컨테이너가 확대로 밀려난 부분에 닿지 못한다. 줌은 두 손가락 pinch·툴바 버튼·Ctrl+Wheel 로 조작하고, 파일마다 100% 로 초기화되며 어디에도 저장하지 않는다(표시 상태이지 설정이 아니다).
7. 열기 요청은 revision 으로 무효화한다. 닫힌 뒤 도착한 응답이나 lease/capability 가 바뀐 뒤 도착한 응답은 오버레이에 그리지 않는다.

## Alternatives Considered

- **안드로이드 WebView 에 다중 창 허용 + `onCreateWindow`**: 새 탭 결정을 유지할 수 있다. 기각. 앱은 RPC 로 단일 문서를 설치하는 구조라 두 번째 문서를 위한 자원 경로·문서 권위·수명 관리를 새로 만들어야 하고, 설치형 PWA 의 opener 끊김과 브라우저 팝업 차단은 그대로 남는다. 표면 하나를 위해 공격 표면(`javaScriptCanOpenWindowsAutomatically`)을 열면서 문제의 3분의 1만 고치는 거래다.
- **앱에서만 오버레이, 브라우저는 새 탭 유지**: 앱을 고치는 최소 변경이다. 기각. 렌더 코드가 두 벌이 되고 두 벌의 보안 경계를 계속 동기화해야 한다. PWA 케이스도 남는다.
- **셸 CSP 없이 오버레이로 이동**: 가장 빠르다. 기각. 파일 바이트를 정책 있는 문서에서 정책 없는 문서로 옮기는 실질적 후퇴다. 그래서 ADR-0183 을 선행 결정으로 분리했다.
- **오버레이 안 iframe 에 `allow-same-origin` 부여**: preview 안에서 상대 자원을 읽게 하려면 편하다. 기각. 그 순간 sanitizer 한 번의 실수가 Remote origin 의 lease·capability 에 닿는다. 빈 sandbox 는 타협하지 않는다.
- **줌을 설정으로 저장**: 데스크톱 뷰어의 폰트 설정과 대칭이 될 수 있다. 기각. 한 파일을 보는 배율은 일회성 표시 상태이며, `settings.json` 은 사용자 구성만 갖는다.

## Consequences

- 앱·설치형 PWA·브라우저가 같은 코드로 같은 뷰어를 얻는다. 팝업 차단·opener 관계·다중 창 지원이라는 실패 모드 세 개가 함께 사라지고, 표면별 숨김 분기도 없어진다.
- 자격 증명이 문서 경계를 넘지 않으므로 `postMessage` 세션 전달과 그 검증 로직(exact origin, pending `Window` identity, 30초 타임아웃)이 전부 불필요해진다. 삭제되는 코드가 곧 사라지는 위험이다.
- 문서별 CSP 라는 이점은 잃는다. 대신 ADR-0183 의 셸 정책이 그 자리를 대신하며, 셸 정책이 약해지면 이 결정의 전제도 약해진다 — 두 ADR 은 함께 읽어야 한다.
- ADR-0109 의 판단은 유지된다. Remote 는 여전히 데스크톱의 typed preview 렌더러를 이식하지 않고 structured 종류를 원문 text 로 표시한다. 달라진 것은 그 표시가 일어나는 문서뿐이며, 렌더러 이식 여부는 Remote 클라이언트 통합 결정에서 다시 본다.
- 오버레이가 터미널 위를 덮으므로 열려 있는 동안 터치 제스처와 키 입력의 소유권이 오버레이로 넘어간다. 같은 문서라 이 라우팅을 직접 끊을 수 있는 것이 새 탭 대비 이점이지만, 새로 추가되는 전역 키 처리는 항상 "오버레이가 열려 있을 때만" 조건을 갖춰야 한다.
- 테스트는 Rust 단위(오버레이 마크업·sandbox 경계·줌 상태 비영속·새 탭 흔적 부재)와 Playwright(오버레이 렌더와 popup 미발생, Escape·backdrop 닫기, 이미지 줌, 닫힌 뒤 도착한 stale 응답, 안드로이드 래퍼에서 섹션 노출과 인페이지 렌더, 모바일 폭)로 나눈다.
- 파일 저장/다운로드는 여전히 어느 표면에도 없다. 오버레이는 그 기능을 추가하기 쉬운 자리를 만들지만, 앱은 WebView 다운로드 경로가 없어 네이티브 작업이 필요하므로 별도 결정으로 다룬다.
