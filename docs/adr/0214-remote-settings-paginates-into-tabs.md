# 0214. Remote Settings는 탭으로 나누고 선택한 탭만 기기에 남긴다

- Status: Proposed
- Date: 2026-08-29
- Source: 사용자 요구("settings 가 지금 하나로 너무 몰려 있어. settings 바 바로 아래에 서브 메뉴를 둬야 겠다"); [architecture/api-contracts.md §13.4](../architecture/api-contracts.md); [ADR-0004](0004-settings-vs-ui-state-separation.md); [ADR-0186](0186-remote-input-action-three-zone-layout.md); [ADR-0187](0187-remote-drawer-status-dots-and-hidden-subview.md); [ADR-0209](0209-remote-display-preferences-are-device-local.md); [ADR-0213](0213-remote-input-action-segment-placement-and-user-keys.md)
- Extends: [ADR-0187](0187-remote-drawer-status-dots-and-hidden-subview.md)의 drawer 하위 화면 모델

## Context

ADR-0186이 키바 팝오버를 없애고 배치 편집을 Remote drawer의 Settings로 옮긴 뒤, Settings 한 화면에 `Input bar` · `Display` · `Laymux update` · `Install`이 세로로 쌓였다. ADR-0213이 `Input bar`에 행 편집기 둘과 `Hidden` 목록과 커스텀 키 등록 폼을 더하면서 이 화면은 390px 기기에서 한 화면의 여러 배가 됐고, 뒤쪽 섹션은 스크롤에 묻혔다.

여기에 소유권이 어긋난 자리도 하나 있었다. Composer 설정은 `renderKeyPopover()`가 입력 배치와 같은 컨테이너(`#inputLayoutEditor`)에 이어 붙여 렌더했다. 화면에서는 Composer 토글들이 "Input bar" 섹션 소속처럼 보였고, 두 주제가 한 DOM 컨테이너를 공유한다는 사실이 렌더 함수 밖에서는 드러나지 않았다.

drawer의 화면 전환 모델은 ADR-0187이 정했다. 최상위 `Workspace / Hidden / Notifications / Connection / Settings`를 아이콘으로 오가고, "상태 점과 하위 화면 선택은 navigation snapshot에서 파생하는 Remote 문서 runtime 상태이며 별도 영속 상태나 API를 추가하지 않는다"고 못 박았다. Settings 안을 다시 나누는 것은 그 모델에 두 번째 층을 더하는 일이고, 그 층의 선택을 기억할지는 0187이 답하지 않은 질문이다.

이번 결정은 Remote drawer Settings의 화면 분할과 그 선택의 수명만 다룬다. 각 설정 항목의 의미, 키바 배치 모델(ADR-0213), 표시 선호의 저장 위치(ADR-0209), 최상위 drawer 화면 구성(ADR-0187)은 범위 밖이며 바뀌지 않는다.

## Decision

**Remote drawer의 Settings는 헤더 아래 tablist로 `Input bar` · `Composer` · `Display` · `App` 네 페이지로 나누고, 선택한 탭은 ADR-0209의 기기 로컬 표시 선호로 취급해 `localStorage`에 남긴다.**

- 선택한 패널만 layout에 남기고 나머지는 `hidden`으로 감춘다. tablist는 `role="tablist"`/`tab`/`tabpanel`과 `aria-selected`·`aria-controls`·`aria-labelledby`를 갖추고, roving tabindex(선택된 탭만 `tabindex=0`)에 ←/→ 순환과 Home/End 이동을 제공한다. 탭 활성화는 자동(포커스 이동 = 선택)이다.
- tablist는 sticky다. 긴 패널을 읽다가 주제를 바꿀 때 위로 되감아 올라가야 한다면 나눈 의미가 없다.
- 탭을 바꾸면 drawer 스크롤을 맨 위로 되돌린다. 패널마다 높이가 다르므로 이월된 offset은 아직 보지 않은 페이지의 중간에 사용자를 떨어뜨린다.
- **탭 선택은 `localStorage["laymux.remote.settingsPanel"]`에 저장한다.** 이는 ADR-0187이 "영속하지 않는다"고 정한 *drawer 하위 화면 선택*이 아니라, ADR-0209가 규정한 *이 기기에서 무엇을 보고 싶은가*라는 표시 선호에 속한다. 최상위 drawer 화면은 여전히 매번 workspace 기본 화면에서 시작하며 영속하지 않는다 — 0187의 결정은 그대로다. 알 수 없는 값은 첫 탭으로 되돌린다.
- Composer 설정은 자기 탭의 `#composerSettingsEditor`에 렌더한다. 한 컨테이너를 두 주제가 나눠 쓰지 않는다.
- 탭이 곧 제목이므로 패널 안에서 탭 이름을 되풀이하지 않는다.
- Settings 진입점의 상태 점(ADR-0187의 5px 점)이 특정 탭의 내용을 가리킬 때는 그 탭에도 같은 점을 찍는다. 점이 안내하는 곳이 기본으로 접혀 있으면 점은 길을 잃는다. 현재 해당 사례는 PC 업데이트(`App` 탭)다.
- Remote API·`settings.json`·PTY 계약은 바꾸지 않는다.

## Alternatives Considered

- **키 편집만 별도 화면으로 분리**: 가장 큰 덩어리 하나는 빠지지만 남은 Composer·Display·업데이트가 여전히 한 덩어리이고, 다음에 항목이 늘면 같은 질문이 되돌아온다. 그릇을 만들지 않고 한 번 덜어내는 것은 구조가 아니라 미봉이다.
- **Settings를 drawer 최상위 항목 여럿으로 펼치기**: 2단 내비게이션을 피할 수 있지만 최상위 아이콘 행이 다섯에서 여덟로 늘어 ADR-0187이 정리한 상단 action row를 다시 흐트러뜨린다. 좁은 폭에서 아이콘 여덟 개는 탭 넷보다 나쁘다.
- **탭 선택을 영속하지 않고 매번 첫 탭에서 시작**: ADR-0187의 문장과 가장 가깝지만, 글자 크기 하나를 고치러 들어갈 때마다 매번 같은 탭을 다시 골라야 한다. 이 값은 화면 전환 경로가 아니라 표시 선호이므로 0209의 다른 기기 로컬 값들과 수명을 같이하는 편이 사용자 기대에 맞는다.
- **탭 선택을 `settings.json`으로 승격**: 기기 간 공유가 가능하지만 surface-local 표시 선택을 호스트 설정과 외부 계약으로 끌어올린다. ADR-0004/0209의 경계를 그대로 유지했다.
- **탭 대신 접이식 섹션(accordion)**: 스크롤 한 장을 유지하면서 접을 수 있지만, 여러 섹션을 동시에 펼치면 원래의 긴 스크롤로 되돌아가고 무엇이 열려 있는지도 상태로 남게 된다.

## Consequences

- 한 화면에 한 주제만 보이고, Composer 설정이 자기 이름 아래로 돌아온다. 앞으로 늘어나는 설정은 기존 탭에 붙거나 새 탭을 얻으므로 "이것도 뺄까"를 매번 다시 묻지 않는다.
- Settings의 대부분이 `hidden` 상태로 렌더된다. 숨은 패널 안에서 크기를 재는 코드는 잘못된 값을 얻으므로, 그런 계산은 보이는 패널의 상호작용 경로에서만 실행해야 한다.
- 특정 설정으로 곧장 보내는 딥링크가 없다. 상태 점을 탭에도 찍는 것으로 지금은 충분하지만, 외부에서 특정 설정을 지목해야 할 일이 생기면 패널 id를 여는 진입점이 필요해진다.
- Settings를 여는 e2e는 이제 대상 탭을 먼저 골라야 한다. 헬퍼 네 곳(display-settings, widget-strip-toggle, input-composer, page-layout)이 그렇게 바뀌었다.
- `laymux.remote.settingsPanel`이 기기 로컬 키 목록에 하나 늘었다. `localStorage`가 지워지면 첫 탭으로 돌아간다.
- 재검토 조건: 최상위 drawer 화면 자체를 영속하자는 요구가 나오면 ADR-0187의 결정을 정면으로 다루는 새 ADR이 필요하다. 탭이 넷을 넘어 좁은 폭에서 스크롤로도 감당되지 않으면 분할 방식을 다시 연다.
