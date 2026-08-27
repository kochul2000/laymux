# 0210. Remote 범용 아이콘도 Lucide DOM 경계에서 렌더한다

- Status: Accepted
- Date: 2026-08-27
- Source: 사용자 요구("리모트도 모두 통일적으로 적용해줘"), [ADR-0205](0205-lucide-application-icon-source.md), [ADR-0169](0169-remote-client-hashed-immutable-assets-and-gzip.md), [architecture/api-contracts.md §13.0·§15.3](../architecture/api-contracts.md)
- Extends: ADR-0205, ADR-0169

## Context

ADR-0205는 데스크톱 React UI의 범용 픽토그램을 `lucide-react`와 공용 래퍼로 통일했지만 Remote는 범위에서 제외했다. Remote는 React를 싣지 않는 별도 vanilla JavaScript/HTML 표면이어서, 메뉴·가시성·파일·입력 모드·상태 표시가 손으로 적은 인라인 SVG와 유니코드 문자, CSS 도형으로 계속 나뉘었다. 같은 동작이 데스크톱과 Remote에서 다른 좌표·선 굵기·모양을 사용했고 새 아이콘을 추가할 때 두 번째 도안을 직접 관리해야 했다.

Remote는 브라우저 Direct Mode뿐 아니라 PC가 배포하는 같은 번들을 Android E2E WebView에서도 실행한다. 따라서 CDN·외부 폰트·React runtime에 의존할 수 없고, ADR-0169의 tree-shaken 커밋 번들·콘텐츠 해시 URL·CSP·소스 해시 드리프트 검증을 유지해야 한다. pane 명령 상태의 `⏳`·`✓`·`✗`·`—` 값도 Automation/Remote projection의 호환 데이터 계약이므로 전송 모델을 아이콘 객체로 바꿀 수 없다.

범위는 Remote가 그림으로 표시하는 사용자 조작용 범용 픽토그램과 명령 상태의 최종 렌더링 경계다. 터미널에 보내는 실제 키의 keycap label(`Esc`, `↑`, `⌫` 등), 단위·수학 기호, 앱 로고, 데이터 시각화 막대와 알림 점은 비목표다.

## Decision

**Remote의 범용 픽토그램은 vanilla `lucide` named icon만 사용하고, `ui/src/remote/remote-icons.js`가 생성·크기·선 굵기·접근성 기본값과 동적 상태 매핑을 단독 소유한다.**

1. 데스크톱은 `lucide-react`, Remote는 같은 버전의 `lucide` DOM package를 사용한다. Remote 호출부는 SVG path·아이콘 글꼴·유니코드 픽토그램을 직접 소유하지 않는다.
2. Remote 경계의 기본값은 데스크톱과 같은 `size=14`, `strokeWidth=2`, `currentColor`, `aria-hidden=true`, `focusable=false`, flex 축소 방지다. 표면 geometry가 요구하는 크기·선 굵기만 호출부가 명시적으로 덮어쓴다. 명령 결과처럼 아이콘 자체가 의미를 전달하면 호출부 wrapper가 `role`과 상태 텍스트 `aria-label`을 소유한다.
3. 정적 셸은 `data-remote-icon` placeholder만 선언하고 end-of-body 앱 번들이 이를 SVG로 hydration한다. 런타임에 생기는 파일/폴더·가시성·입력 모드·이동·widget 아이콘은 `setRemoteIcon` 한 경로로 생성한다. 범용 인라인 `<svg>` 문자열과 문자 픽토그램은 셸 및 앱 소스에 두지 않는다.
4. pane 명령 상태의 호환 문자열은 그대로 전송하고, Remote 최종 렌더링 경계가 `Hourglass`·`Check`·`X`·`Minus`로 매핑한다. 데이터 계산·wire 계약은 Lucide 이름이나 DOM node를 소유하지 않는다.
5. named import만 Remote 번들에 포함해 tree-shaking한다. 아이콘은 기존 `remote-app.min.js` 안에 들어가며 새 network route나 CSP source를 만들지 않는다.
6. ADR-0169의 생성 배너는 `remote-app.{js,css}`와 `remote-icons.js`의 콘텐츠 해시뿐 아니라 lockfile의 `lucide` package identity도 기록한다. 아이콘 경계나 package 버전만 바뀐 채 커밋 번들이 오래된 경우에도 드리프트 테스트가 실패해야 한다.

## Alternatives Considered

- **데스크톱의 React 래퍼를 그대로 재사용한다.** 동일 컴포넌트를 공유하지만 Remote에 React runtime과 renderer를 추가해 작은 독립 번들·vanilla DOM 경계를 무너뜨린다. 아이콘 일관성을 위해 Remote 전체 프레임워크를 바꾸지 않는다.
- **Lucide SVG path를 HTML/JavaScript에 복사한다.** 실행 의존성은 가장 작지만 버전·선 굵기·접근성 속성이 다시 호출부마다 분산되고, 아이콘 업데이트가 package의 단일 출처를 통과하지 않는다.
- **아이콘 SVG sprite를 별도 불변 자산으로 제공한다.** 캐시 가능한 대신 symbol id registry·별도 route/asset hash·CSP와 Android resource allowlist를 늘리고, 현재 사용하는 작은 named 집합은 tree-shaken 앱 번들보다 운영 경계가 커진다.
- **아이콘 폰트를 self-host한다.** glyph subset·font loading·플랫폼 rasterization을 다시 관리해야 하고 첫 렌더와 스크린샷 결정성이 낮아진다.

## Consequences

- 데스크톱과 Remote가 같은 Lucide 도형 언어와 기본 선 굵기를 사용하고, 새 범용 아이콘의 공급원을 package named export로 제한한다.
- Remote 앱 번들은 사용하는 Lucide icon node와 DOM 생성 helper만큼 커진다. production 번들 크기와 해시 자산 전송은 기존 build/test로 계속 관찰한다.
- 셸 placeholder는 JavaScript 실행 전까지 비어 있지만 앱 스크립트가 body 끝에서 동기 hydration하므로 사용자 조작 가능한 첫 프레임에는 아이콘이 존재한다. 스크립트가 실패하면 Remote 자체가 동작하지 않는 기존 failure domain과 같다.
- `lucide`와 `lucide-react`의 버전을 함께 갱신해야 한다. 서로 다른 버전을 쓰면 같은 이름이 다른 도형으로 렌더될 수 있으므로 lockfile에서 일치 여부를 테스트한다.
- 앱 로고·keycap·단위·제품 고유 데이터 시각화는 의도적으로 Lucide 경계를 통과하지 않는다. 이 예외 집합이 범용 조작 아이콘으로 넓어지면 결정을 재검토한다.
