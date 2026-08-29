# 0187. Remote drawer 상태 표시는 작은 점으로 통일하고 숨김 workspace는 하위 화면에서 연다

- Status: Accepted
- Date: 2026-08-20
- Source: 사용자 요구(2026-08-20), [ADR-0153](0153-remote-hidden-item-visibility-controls.md), [ADR-0180](0180-remote-hidden-workspace-header-icon.md), [api-contracts.md §13.3](../architecture/api-contracts.md#133-navigation-metadata)
- Extended by: [ADR-0214](0214-remote-settings-paginates-into-tabs.md) — Settings 안에 탭 층이 생기고 그 선택만 기기 로컬로 영속한다. 최상위 drawer 하위 화면 선택은 여기 결정대로 영속하지 않는다.
- Supersedes: [ADR-0180](0180-remote-hidden-workspace-header-icon.md)의 숫자 badge와 인라인 shelf 진입 결정
- Amends: [ADR-0153](0153-remote-hidden-item-visibility-controls.md)의 Remote workspace 보관함 표현

## Context

Remote drawer 상단의 숨김 workspace와 알림 action은 숫자 badge를 아이콘 위에 겹쳐 표시하지만 Settings의 업데이트 상태는 작은 점 하나만 표시한다. 같은 상단 action row 안에서 숫자 badge 두 개가 상태보다 강하게 보이고, 숨김 workspace만 workspace 기본 화면 안에서 shelf를 펼치는 반면 Notifications·Connection·Settings·New workspace는 각자 하위 화면으로 진입한다. 그 결과 표시 강도와 진입 방식이 모두 일관되지 않는다.

숨긴 workspace의 정확한 개수와 알림 unread 개수는 접근성 정보로 계속 제공해야 한다. 숨김 raw state와 알림 상태의 SoT, workspace 복원·활성화 동작, Remote API와 Android E2E의 데스크톱 소유 문서 재사용은 바꾸지 않는다.

## Decision

**Remote drawer 상단의 숨김 workspace·알림 상태는 Settings 업데이트와 같은 작은 점으로 표시하고, 숨김 workspace 목록은 독립된 drawer 하위 화면에서 연다.**

- 숨김 workspace와 unread 알림의 시각 표시는 공통 `5px` 상태 점을 사용한다. 숫자 badge DOM은 두 action에서 제거한다.
- 정확한 개수는 숨김 action의 `aria-label`·`title`과 알림 action의 unread `aria-label`·`title`에 유지한다. 점만으로 수량을 추측하게 하지 않는다.
- 숨김 action은 유효 hidden workspace가 있을 때 workspace 기본 화면에서만 보이며, crossed-eye 아이콘 자체는 다른 header action과 같은 중립 색을 사용한다.
- 숨김 action을 누르면 `Hidden workspaces` 하위 화면으로 전환하고 공통 닫기/뒤로가기 action으로 workspace 기본 화면에 돌아간다. 돌아갈 때 focus는 진입한 숨김 action으로 복원한다.
- 목록의 행 클릭은 workspace를 표시하고 활성화하며 drawer를 닫고, eye action은 표시만 한다. 마지막 hidden workspace가 복원되면 하위 화면은 workspace 기본 화면으로 돌아간다.
- eye action으로 일부만 복원하면 재렌더된 다음 항목(없으면 이전 항목)의 eye로 focus를 옮긴다. 마지막 항목을 복원하면 workspace 기본 화면에서 방금 복원된 workspace의 eye로 focus를 옮긴다.
- 상태 점과 하위 화면 선택은 navigation snapshot에서 파생하는 Remote 문서 runtime 상태이며 별도 영속 상태나 API를 추가하지 않는다.

## Alternatives Considered

- **숫자 badge를 작게 유지**: 정확한 개수가 바로 보이지만 좁은 상단 메뉴에서 상태 신호가 계속 과도하게 강조되고 Settings와 시각 언어가 달라 선택하지 않았다.
- **숨김 shelf만 인라인으로 유지**: 구현 변경은 적지만 다른 상단 action과 다른 진입 모델이 남고 workspace 목록의 스크롤 구조도 예외가 되므로 선택하지 않았다.
- **아이콘 색만 바꾸고 점을 제거**: 더 조용하지만 상태와 action 의미가 한 색에 섞이고 알림·Settings와 공통된 상태 표현을 만들지 못해 선택하지 않았다.
- **popover로 표시**: 화면 전환은 줄지만 모바일의 좁은 폭에서 별도 focus·바깥 클릭·스크롤 경계를 추가하므로 기존 drawer 하위 화면 모델을 재사용했다.

## Consequences

- 숨김·알림·업데이트 상태의 시각적 무게와 위치가 같아지고, 상단 메뉴에서 숫자 badge가 차지하던 주의가 줄어든다.
- 숨김 workspace 목록은 Notifications·Settings와 같은 제목·뒤로가기·focus 복원 계약을 사용해 drawer 탐색이 일관된다.
- 숫자는 화면에 직접 보이지 않으므로 접근성 이름과 title 회귀 테스트가 상태 개수를 보존해야 한다.
- 마지막 숨김 workspace 복원 시 존재 이유가 사라진 하위 화면에서 자동으로 빠져나와야 한다.
- 복원 요청이 navigation 목록 전체를 다시 그리므로, 부분·마지막 복원 모두 명시적으로 focus를 재배치하지 않으면 키보드 사용자의 현재 위치가 사라진다.
- Playwright는 숫자 badge 부재, 공통 점의 크기·위치·색, 하위 화면 전환, 부분·마지막 복원의 focus 복원을 검증한다. Remote API·설정 스키마·마이그레이션 변경은 없다.
