# 0205. 범용 애플리케이션 아이콘은 Lucide를 단일 출처로 사용한다

- Status: Accepted
- Date: 2026-08-24
- Source: 사용자 요구("laymux 에 현재 아이콘 세트가 없다", "lucide 도입하자", "체크나 모레시계, x 같은건 아이콘 도입 안한거니?", "그것도 수정해줘"), [architecture/api-contracts.md §15](../architecture/api-contracts.md), [ADR-0192](0192-standard-action-button-and-disabled-affordance.md)
- 관계:
  - **부분 대체** — [ADR-0192](0192-standard-action-button-and-disabled-affordance.md)의 Decision 5(아이콘 패키지를 도입하지 않고 손그림 SVG를 모은다)

## Context

데스크톱 UI의 범용 픽토그램은 작은 격자의 인라인 SVG, Segoe Fluent Icons/MDL2 글꼴 글리프, 유니코드 문자로 나뉘어 있다. 같은 의미의 눈·닫기·더보기 아이콘도 호출 지점마다 다른 좌표와 선 굵기를 사용한다. 새 아이콘은 다시 그려야 하고, Windows 전용 글꼴 글리프는 Linux에서 같은 모양을 보장하지 않는다.

ADR-0192는 당시 필요한 외부 링크 글리프가 하나뿐이고 startup entry chunk가 예산에 가까웠으므로 패키지를 도입하지 않기로 했다. 이제 실제 UI에는 범용 인라인 SVG가 여러 화면에 반복되고 글꼴 글리프까지 공존하므로 그 결정의 재검토 조건인 관리 규모에 도달했다. 동시에 앱은 Windows와 Linux에서 동일한 로컬 자산으로 동작해야 하고, Tauri 시작 시 파싱하는 entry chunk는 기존 515 kB 상한을 지켜야 한다.

범위는 데스크톱 React UI의 사용자 조작용 범용 픽토그램, pane 명령 상태 픽토그램과 그 공급 경계다. 레이아웃 미니맵처럼 런타임 데이터에 따라 그리는 SVG와 앱 로고는 비목표다. 터미널 상태 계산 및 Automation/Remote projection의 문자열 값은 호환 계약으로 유지하되, 데스크톱 React는 그 값을 화면에 문자로 직접 쓰지 않는다.

## Decision

**데스크톱 React UI의 범용 애플리케이션 아이콘은 `lucide-react`를 단일 출처로 사용하고, laymux 공용 래퍼가 크기·선 굵기·장식 아이콘 접근성 기본값을 소유한다.**

1. 사용자 조작용 범용 픽토그램은 Lucide의 named icon component를 사용한다. 새 Segoe/MDL2 글꼴 글리프, 유니코드 아이콘, 손그림 범용 SVG를 추가하지 않는다.
2. `components/ui/icons.tsx`가 애플리케이션 아이콘의 공개 진입점이다. 호출부는 `lucide-react`를 직접 import하지 않으며, 이 진입점이 기본 `size=14`, `strokeWidth=2`, `currentColor`, `aria-hidden`, `focusable=false`와 flex 축소 방지를 통일한다. 텍스트 옆 외부 링크 아이콘은 기존 계약대로 `size=12`를 기본값으로 둔다.
3. 버튼의 이름과 상태는 계속 버튼의 텍스트·`aria-label`·`title`이 소유한다. 공용 아이콘은 기본적으로 장식 요소이며 독립적인 접근성 이름을 만들지 않는다.
4. 레이아웃 미니맵처럼 입력 데이터에 따라 그려지거나 Lucide 하나로 의미를 보존할 수 없는 제품 전용 SVG는 해당 소유 컴포넌트에 남긴다. dock 위치 토글처럼 Lucide가 의미를 그대로 제공하는 정적 도식은 예외가 아니다.
5. pane 명령 상태의 계산·절전 억제·Automation/Remote projection은 기존 문자열 값(`⏳`·`✓`·`✗`·`—`)을 호환 식별자로 유지한다. 데스크톱 React의 `CommandStatusIcon`은 최종 렌더링 경계에서 이를 Lucide `Hourglass`·`Check`·`X`·`Minus`로 매핑하며, 지역화된 접근성 이름을 제공한다. 상태 로직은 React 노드나 Lucide 타입을 소유하지 않는다.
6. named import의 tree-shaking 결과를 production build와 startup chunk 예산 테스트로 검증한다. 아이콘 도입을 이유로 515 kB 상한을 올리지 않는다.

## Alternatives Considered

- **손그림 SVG를 계속 `icons.tsx`에 추가한다**: 런타임 의존성과 번들 증가는 가장 작다. 그러나 이미 여러 화면에서 같은 의미의 모양과 선 굵기가 갈라졌고, 새 아이콘마다 디자인·접근성·Linux 표시를 다시 검증해야 하므로 관리 비용이 수요에 비례해 증가한다.
- **Material Symbols를 글꼴로 self-host한다**: 아이콘 종류와 weight/optical-size 축이 풍부하다. 그러나 사용하는 글리프만 tree-shake할 수 없고, 폰트 로딩과 글리프 렌더링이 스크린샷 및 첫 화면의 결정성을 낮춘다.
- **`@mui/icons-material`을 사용한다**: React 컴포넌트가 준비돼 있고 익숙하다. 아이콘만을 위해 `@mui/material`과 그 스타일링 의존 경계를 도입해야 하며, laymux의 기존 Tailwind+CSS 변수 UI 계층과 책임이 겹친다.
- **Tabler Icons를 사용한다**: Lucide보다 훨씬 많은 아이콘을 제공하고 선형 스타일도 맞는다. 현재 필요한 IDE 범용 의미는 Lucide 범위로 충족되며, 더 큰 카탈로그보다 React 사용량·생태계와 작은 일관된 집합을 우선했다.
- **각 호출부가 `lucide-react`를 직접 import한다**: 가장 얇은 코드 경로다. 대신 기본 크기·선 굵기·접근성 속성이 다시 분산되고 다른 아이콘 공급원을 섞는 것을 구조적으로 막지 못한다.

## Consequences

- Windows와 Linux가 같은 SVG 컴포넌트를 렌더하고, 범용 동작은 일관된 24×24 좌표계와 선 굵기를 갖는다.
- 새 범용 아이콘은 공용 진입점에 명시적으로 추가해야 한다. 이는 한 파일의 export 작업을 요구하지만 아이콘 공급원과 기본 표현을 리뷰 가능한 한 곳에 둔다.
- npm 개발 설치 크기는 늘지만 production에는 사용하는 named icon만 포함된다. 실제 startup 비용과 chunk 배치는 번들 테스트가 계속 제한한다.
- 기존 범용 SVG·글꼴·문자 아이콘은 이번 변경에서 교체한다. 제품 전용 SVG는 남고, 외부 계약의 상태 문자열은 데이터로만 공존하며 데스크톱 UI에는 Lucide로 표시된다.
- Lucide에서 의미가 맞는 아이콘을 찾을 수 없거나 icon module 비용이 startup 예산을 반복해서 압박하면, 제품 전용 SVG 예외 또는 아이콘 chunk 정책을 새 결정으로 재검토한다.
