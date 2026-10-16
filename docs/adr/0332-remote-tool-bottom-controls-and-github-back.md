# 0332. Remote 우측 도구는 하단 컨트롤바를 기본으로 하고 PRs에서 Issues로 돌아간 뒤 닫는다

- Status: Accepted
- Date: 2026-10-16
- Source: 사용자 요구("이슈까지 갔다가 닫히도록", "우측 툴은 컨트롤바 하단을 옵션으로 주고 기본 true", "메모 뷰어 깃헙 등등"), [ADR-0261](0261-remote-visible-tool-swipe-cycle.md), [ADR-0313](0313-remote-toolbar-shared-size-tokens.md), [api-contracts.md §13](../architecture/api-contracts.md)
- Partially supersedes: ADR-0261의 오른쪽 close 동작 중 PRs에서 즉시 닫는 규칙만 대체한다. ADR-0313의 공통 툴바 크기 토큰을 그대로 적용한다.

## Context

Remote GitHub의 왼쪽 플링은 Issues에서 PRs로 이동하지만 기본 오른쪽 플링은 곧바로 창을 닫아 Issues로 되돌아가기 어렵다. 또한 휴대폰에서 메모·파일 뷰어/탐색기·GitHub의 상단 컨트롤바에 손이 닿기 어렵다. 각 도구가 별도 배치 상태를 소유하면 도구 순환 중 조작 위치도 바뀐다. 모든 Remote 표면에 같은 기본값을 적용하면서 상단을 선호하는 기기의 선택과 기존 역순 도구 순환을 보존해야 한다.

## Decision

**Remote 우측 도구 전체는 기기 로컬 하단 컨트롤바를 기본으로 사용하며, 기본 닫기 플링은 PRs → Issues → 닫기 순서로 처리한다.**

- `toolControlsBottom` boolean의 기본값은 true다. `laymux.remote.toolControlsBottom`이 기기별 선호의 단일 진실원이며, Panels와 Remote settings MCP에서 연결 전후 즉시 편집한다. false는 기존 상단 배치다. 저장값이 없거나 저장소를 읽지 못하면 true를 사용한다. PC 설정으로 동기화하지 않는다.
- 메모·GitHub·파일 뷰어/탐색기의 기존 컨트롤바 전체를 같은 설정으로 배치한다. 본문은 남은 공간에서 스크롤하고 컨트롤바가 본문을 덮지 않는다. 하단 배치는 기존 visual viewport 높이를 따라 키보드가 줄인 표시 영역 안에 컨트롤바를 유지한다. 하단 안전 영역을 확보하고 기존 툴바 크기 토큰을 유지한다. 브라우저·PWA·Android wrapper에 같은 규칙을 적용한다.
- `toolSwipeRightAction=close`에서 PRs의 오른쪽 플링은 같은 패널의 Issues 탭으로 이동한다. 이는 도구 숨김 설정과 `swipeCloseDrawers`에 영향받지 않는 내부 탭 이동이다. Issues와 다른 도구의 오른쪽 플링은 `swipeCloseDrawers=true`일 때 닫는다.
- `toolSwipeRightAction=previous`의 역순 순환과 왼쪽 순환, 단일 제스처 소유자·선택 보호·메모 초안 소유권은 그대로 적용한다. 배치 변경은 기존 DOM과 이벤트 처리기를 보존하며 저장이나 새 네트워크 변경 동작을 유발하지 않는다.

## Alternatives Considered

- 오른쪽을 무조건 이전 도구로 변경: Issues에서도 다른 도구로 넘어가므로 요청한 닫기 흐름을 제공하지 못한다.
- 하단 배치를 GitHub에만 적용: 메모와 파일에서도 엄지로 조작하기 어렵고 도구 사이 조작 위치가 달라진다.
- 터치 기기를 감지해 기본값 분기: 같은 Remote 기기에서도 입력 방식·화면 크기에 따라 위치가 달라진다. 공통 기본값과 명시적인 기기 선호가 더 예측 가능하다.
- 컨트롤바를 본문 위에 띄우기: 마지막 목록 행이나 메모 내용을 가리므로 기존 flex 공간 배분을 사용한다.

## Consequences

- 휴대폰에서 주요 도구 조작에 접근하기 쉽고 PRs에서 Issues로 한 단계 되돌아간 뒤 닫을 수 있다.
- 새 필드가 없는 기존 기기도 기본 하단 배치를 사용한다. 상단 선호는 옵션을 끄면 저장되며 마이그레이션은 없다.
- Remote settings schema·기기 snapshot/patch·Panels UI·생성 번들을 함께 갱신한다. 새 호스트 API·권한·인증 정책은 추가하지 않는다.
- 실제 Chromium 터치로 PRs → Issues → 닫기와 닫기 비활성 상태를 검증한다. 도구별 상하 배치·스크롤·재로드·기기 설정 patch·메모 초안 보존과 모바일/넓은 화면 스크린샷을 확인한다.
