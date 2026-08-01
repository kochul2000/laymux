# 0111. GitHubView 행 표시는 전역 `settings.github` 이 소유하고, 색은 이름으로만 받는다

- Status: Proposed
- Date: 2026-08-01
- Source: 사용자 요구("다른 view 처럼 글꼴·글자 크기 등을 설정에서"), [ADR-0106](0106-github-list-view-repo-registry.md)(GitHubView 도입), [ADR-0107](0107-widget-typography-and-usage-bar-width.md)(위젯 타이포그래피 소유권), [ADR-0004](0004-settings-vs-ui-state-separation.md)(설정 vs UI 상태)

## Context

`GitHubView` 의 행은 도입 이후 전부 하드코딩이었다 — `--fs-sm`/`--fs-2xs` 크기, 노란 번호, 라벨 2개·80px, 작성자·경과시각 상시 표시. 좁은 pane 에서는 메타데이터가 제목을 밀어내고, 넓은 모니터에서는 11px 이 너무 작다. 사용자마다 필요한 열이 다르다는 것이 실사용에서 드러났다.

[ADR-0107](0107-widget-typography-and-usage-bar-width.md) 은 위젯에서 같은 문제를 이미 한 번 갈랐다: **표시 축은 전역 설정, 배치 인스턴스 고유 값은 인스턴스 옵션.** GitHubView 에는 인스턴스 고유 축이 없다 — 같은 리포를 보는 pane 이 서로 다른 글꼴로 보일 이유가 없고, 스냅샷 자체도 이미 전역 레지스트리가 소유한다([ADR-0106](0106-github-list-view-repo-registry.md)).

정해야 할 것은 세 가지다. (1) 설정 소유 계층 — 전역만인지 pane 오버라이드까지인지. (2) 색을 사용자에게 어떤 형태로 받을지. (3) 잘못된 값(손으로 편집한 settings.json)의 책임을 어디가 지는지.

범위는 `settings.github` 의 표시 키와 그것을 읽는 뷰 하나다. 행 레이아웃(열 순서)·정렬·필터·검색, Remote 표면 노출은 비목표다.

## Decision

**행 표시 설정은 전역 `settings.github` 에만 존재하고, pane 별 오버라이드를 두지 않는다. 색은 팔레트 토큰 이름으로만 받으며, 모든 값은 뷰가 아니라 `lib/github-display.ts` 의 단일 clamp 를 지나야 화면에 닿는다.**

- **전역 전용.** `fontFamily`·`fontSize`·`numberColor`·`showAuthor`·`showUpdated`·`showDraftBadge`·`labelMaxCount`·`labelMaxWidth` 는 `settings.json` 의 사용자 구성이다([ADR-0004](0004-settings-vs-ui-state-separation.md)). `viewOverrides`(localStorage) 축은 열지 않는다 — 열면 "이 pane 만 왜 다른가"를 설명할 SoT 가 둘로 갈라진다. 필요해지면 그때 [ADR-0107](0107-widget-typography-and-usage-bar-width.md) 처럼 인스턴스 고유 축만 따로 결정한다.
- **크기 knob 은 하나다.** `fontSize` 는 번호·제목의 px 이고, 작성자·경과시각·라벨은 `fontSize - 2`(하한 7px)로 **파생**한다. 열마다 크기를 열어 주면 제목만 커진 행처럼 조합해서 깨진 상태를 사용자가 만들 수 있다. 파생 규칙은 도입 전 값(11/9px)을 기본값에서 그대로 재현한다.
- **색은 이름으로만 받는다.** `numberColor` 는 `yellow`·`accent`·`green`·`red`·`primary`·`secondary`·`muted` 중 하나다. 자유 hex 를 허용하면 앱 테마를 바꿀 때 행 하나만 대비가 무너지고, 그 상태를 앱이 고칠 방법이 없다. 알 수 없는 값은 기본 토큰으로 되돌린다.
- **라벨 열의 off 스위치는 개수 0 이다.** 표시 토글과 개수를 따로 두면 "토글 on + 개수 0" 같은 모순 상태가 생긴다. `labelMaxCount: 0` 하나가 열을 없앤다.
- **clamp 는 프론트 단일 지점이 소유한다.** Rust 는 serde 기본값만 채우고 값을 거부하지 않는다(`refreshSeconds` 와 같은 정책). 뷰는 `settings.json` 의 원시 값을 style 로 직접 흘리지 않고 항상 `github-display.ts` 를 통과시킨다 — 손으로 편집한 `fontSize: 400` 이나 `numberColor: "#ff0000"` 이 그대로 렌더되지 않는 지점이 그 파일 하나다.

## Alternatives Considered

- **pane 인스턴스 오버라이드까지 허용.** 워크스페이스마다 다른 밀도를 원할 수 있다. 그러나 요구는 "설정에서 바꾸고 싶다"였고, 오버라이드는 저장 위치(localStorage)·UI(컨트롤 바)·해석 순서를 함께 늘린다. 실제 요구가 관측되면 그때 추가한다.
- **열마다 글자 크기 노출.** 표현력은 최대지만 깨진 조합을 사용자가 만들 수 있고, 설정 행이 4개 늘어난다. 하나의 크기 + 파생이 같은 목적을 거의 다 덮는다.
- **자유 색 입력(hex/color picker).** 테마 전환 시 대비가 무너지는 상태를 앱이 복구할 수 없다. 토큰 목록은 테마가 색을 계속 소유하게 한다.
- **CSS 변수 오버라이드로 구현(`--gh-row-size` 등).** 설정을 스타일 시트에 주입하는 방식은 값 검증 지점이 사라지고 테스트가 DOM 스타일 문자열 비교로 밀린다. 계약을 함수로 두면 clamp 를 단위 테스트로 고정할 수 있다.
- **`widgets.fontFamily`/`fontSize` 를 그대로 재사용.** 위젯은 앱 크롬이고 이 뷰는 pane 콘텐츠다. 한 값이 두 표면의 밀도를 동시에 정하면 한쪽을 맞추면 다른 쪽이 깨진다.

## Consequences

- 기본값이 도입 전 화면과 동일하므로 기존 `settings.json` 은 그대로 열리고 화면도 그대로다. 마이그레이션은 없다.
- 설정 행이 8개 늘었다. Settings → Views → GitHub 는 이제 "동작"과 "표시" 두 서브그룹이다.
- `fontSize` 를 크게 올리면 행 높이가 `--pane-row-max-h` 를 넘어 목록에 보이는 행 수가 줄어든다. 의도된 트레이드오프이며 별도 밀도 설정을 두지 않았다.
- 파생 규칙(−2px, 하한 7px)이 계약이 되었다. 열별 크기를 나중에 열려면 이 파생을 되돌리는 결정이 필요하다.
- Remote 표면은 이 설정을 읽지 않는다. Remote 에 GitHub 목록이 생기면 그 표면의 표시 소유권은 별도 결정이다.
- 재검토 조건: 워크스페이스별로 다른 밀도가 실제로 필요해지거나, 토큰 7개로 부족하다는 요구가 반복되면 각각 인스턴스 축·색 입력 방식을 다시 정한다.
