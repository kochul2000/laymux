# 0261. Remote 도구 스와이프는 표시된 도구를 고정 순서로 순환한다

- Status: Accepted
- Date: 2026-09-21
- Source: [issue #1064](https://github.com/kochul2000/laymux/issues/1064), [ADR-0260](0260-remote-shared-memo-and-panel-preferences.md), [architecture/api-contracts.md](../architecture/api-contracts.md)
- Extends: ADR-0260의 기기 로컬 패널 설정과 아이콘 표시 정책

## Context

Remote의 Files/GitHub/Memo는 별도 overlay여서 다른 도구로 이동하려면 닫고 헤더 버튼을 다시 눌러야 한다. 사용자는 열린 도구에서 왼쪽 스와이프로 Issues → PRs → Files → Memo를 순환하고, 오른쪽은 기존 닫기를 기본으로 유지하면서 역순 순환도 선택하기를 요청했다. 숨긴 도구는 순환에서 제외해야 하지만 기존 우측 가장자리 바로가기는 숨긴 도구도 열 수 있다. 메모 초안·파일 뒤로가기·본문 선택/스크롤을 도구 전환이 훼손해서는 안 된다.

## Decision

**열린 Remote 도구의 왼쪽 스와이프는 표시·가용 조건을 만족하는 도구를 고정 순서로 순환하고, 오른쪽 동작은 기기별로 닫기 또는 역순을 선택한다.**

- 순서는 Issues → PRs → Files → Memo → Issues다. GitHub 아이콘의 표시·active terminal 조건은 Issues/PRs 모두에 적용하고 Files에는 FileViewer capability, 모든 도구에는 active lease가 필요하다. 헤더 표시 설정과 가용성 원시 상태를 그대로 사용하며 별도 순회 목록을 저장하지 않는다. 현재 도구가 숨겨져 있어도 전체 순서상 현재 위치에서 다음 표시 도구를 찾는다. 다른 대상이 없으면 no-op이다.
- `toolSwipeRightAction`은 Remote settings MCP와 `localStorage["laymux.remote.toolSwipeRightAction"]`에 속하는 `close | previous` 기기 로컬 설정이며 기본값은 `close`다. Panels 탭에서 편집하고 즉시 적용한다. 손상되거나 없는 값은 close다. 기존 `swipeCloseDrawers` 토글은 close 동작만 제어하며, 순환은 그 토글과 독립이다. workspace 닫기와 terminal 가장자리 열기 계약은 유지한다.
- `headerFiles/headerGithub/headerMemo`는 새 순환의 포함 여부를 정한다. 기존 `rightSwipeView` 바로가기는 여전히 아이콘 표시와 독립이다. 이는 ADR-0260의 기존 열기 경로를 유지하면서 새 순환에만 표시 조건을 적용하는 확장이다. 탐색 제외/PC 모드처럼 도구창이 아닌 버튼은 순환하지 않는다.
- 터치·펜의 모바일 제스처만 처리한다. 헤더와 안내 줄, GitHub 목록·Files 디렉터리 목록이 제스처 표면이다. textarea/select/input/contenteditable 및 파일 렌더링 본문은 제외하며 기존 선택이 있으면 시작하지 않는다. 수직 우세 이동과 다중 포인터·취소는 기존 상호작용으로 돌아간다. 수평 56px·수직 대비 1.25배 임계값 후 pointerup에서 한 번만 전환하고 뒤따르는 클릭은 소비한다.
- 도구 이동은 기존 open/close와 GitHub 탭 상태를 사용한다. 메모 문서는 폐기하거나 저장하지 않으며 비동기 응답 무효화·초안 보호를 유지한다. Files의 Back은 현재 파일에서 기존 폴더로 돌아가는 독립 action이고 스와이프에 재할당하지 않는다. 도구를 떠난 뒤 다시 Files에 진입하면 기존 현재 terminal CWD 열기 경로를 따른다.
- 새 host API·권한·데이터 영속 상태는 만들지 않는다. 설정 변경은 연결 없이 가능하나 도구 탐색은 기존 lease/capability 게이트를 유지한다.

## Alternatives Considered

- 모든 도구를 항상 순환: 숨긴 아이콘을 제외한다는 요구와 어긋난다.
- 필터링한 목록에서 현재 도구가 없으면 첫 항목으로 이동: 숨겨진 현재 도구의 원래 순서를 잃어 방향이 예측 불가능하다.
- 도구 본문 전체에 제스처 적용: 메모 편집·파일 수평 스크롤/선택 및 iframe의 별도 입력 소유권과 충돌한다. 안전한 표면과 보이는 안내 줄로 제한한다.
- pointermove마다 즉시 전환: 한 번의 손가락 이동이 다음 표면에서 다시 해석되거나 버튼 클릭으로 이어질 수 있다. 문서 단일 포인터 소유자가 release에서 한 단계만 수행한다.

## Consequences

- 도구 전환 횟수가 줄고 사용자가 노출한 도구만 방문한다. 헤더 공간이 없는 메모에서도 안내 줄로 제스처를 시작할 수 있지만 화면 높이를 소량 사용한다.
- 기본 오른쪽 닫기와 명시적 닫기 버튼/Escape/시스템 Back은 유지한다. previous 모드에서도 닫기 버튼은 필요하다. 설정을 지우면 close로 돌아가며 마이그레이션은 없다.
- 순수 계산·MCP 설정 검증·모바일 E2E에서 전체/역순 순환, 숨김·사용 불가·대상 없음, 초안 보존, 목록/헤더 상호작용과 생성 bundle 일치를 고정한다. 실제 dev 터치 검증으로 브라우저 스크롤·클릭과의 충돌을 확인한다.
- 향후 새 도구를 추가하거나 사용자가 순서를 편집하려면 고정 순서와 표시 정책을 재검토한다.
