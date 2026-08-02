# 0115. GitHubView 의 Issues/PRs 탭은 pane 인스턴스 UI 상태이고 `defaultTab` 은 씨앗일 뿐이다

- Status: Proposed
- Date: 2026-08-02
- Source: 사용자 요구("마지막에 issue 또는 pr 선택이 종료돼도 보존되게, 지금은 재시작하면 다 issue 로 돌아간다"), [ADR-0004](0004-settings-vs-ui-state-separation.md)(설정 vs UI 상태 + 오버라이드 레이어), [ADR-0111](0111-github-view-display-settings.md)(행 표시는 전역 설정 전용)의 인스턴스 축 유보 조항, [ADR-0106](0106-github-list-view-repo-registry.md)(GitHubView 도입)

## Context

`GitHubView` 의 탭 선택은 도입 이후 컴포넌트 지역 상태였고, 초기값은 전역 설정 `settings.github.defaultTab` 하나였다. 앱을 껐다 켜면 모든 pane 이 그 하나의 값으로 되돌아간다.

실사용 배치가 이 가정을 깬다. 사용자는 GitHubView 를 한 화면에 둘 이상 띄우고 **하나는 Issues, 하나는 PRs** 로 고정해서 쓴다. 전역 기본값은 정의상 그중 하나만 맞출 수 있으므로, 재시작마다 나머지 pane 을 손으로 다시 클릭해야 한다. pane 을 지우고 만드는 것도 아닌데 화면 구성이 재시작에서 살아남지 못한다.

[ADR-0111](0111-github-view-display-settings.md) 은 행 **표시** 축(글꼴·크기·열)에 pane 오버라이드를 두지 않기로 하면서 "인스턴스 고유 축이 실제로 필요해지면 그때 그 축만 따로 결정한다"고 유보했다. 이 ADR 이 그 후속이며, 표시 축은 건드리지 않는다.

정해야 할 것은 세 가지다. (1) 탭이 구성인가 UI 상태인가. (2) 보존 단위가 앱 전역인가 pane 인가. (3) 보존값이 생긴 뒤 `defaultTab` 의 역할은 무엇인가.

범위는 Issues/PRs 탭 하나다. 스크롤 위치·메뉴 열림·정렬/필터 보존, Remote 표면, 표시 설정은 비목표다.

## Decision

**탭 선택은 pane 에 귀속된 UI 상태이며 `viewOverrides[paneId].githubTab` (localStorage) 이 소유한다. `settings.github.defaultTab` 은 아직 한 번도 고르지 않은 pane 의 씨앗값으로만 읽힌다.**

- **구성이 아니라 UI 상태다.** 탭은 설정 UI 를 거치지 않고 헤더 버튼으로 즉흥적으로 바뀐다 — [ADR-0004](0004-settings-vs-ui-state-separation.md) 가 localStorage 로 보낸 부류 그대로다. `settings.json` 에 쓰면 사용자가 공유·편집하는 구성 파일이 클릭 로그로 오염된다.
- **pane 축이다(`viewOverrides`).** 보존 단위는 "이 슬롯에 떠 있는 이 GitHubView" 다. 같은 리포를 보는 두 pane 이 서로 다른 탭이어야 한다는 것이 요구 자체이므로 전역 last-used 값은 요구를 만족시키지 못한다. `paneOverrides`(슬롯 속성)가 아니라 `viewOverrides`(콘텐츠 속성)인 이유는 view 타입이 바뀌면 탭의 의미가 사라지기 때문이다 — 기존 리셋 규칙(`clearViewOverride`)이 그대로 맞는 동작이다.
- **해석 순서는 `githubTab` → `defaultTab` 이다.** 오버라이드가 있으면 이긴다. 즉 `defaultTab` 을 나중에 바꿔도 이미 고른 pane 은 움직이지 않는다. 사용자가 명시적으로 누른 선택이 설정 기본값보다 뒤에 온 의도이기 때문이다. 되돌리는 경로는 pane 을 지우거나 view 타입을 바꾸는 것 — 오버라이드 레이어의 기존 생명주기와 같다.
- **선택은 값과 무관하게 저장한다.** 고른 탭이 마침 `defaultTab` 과 같아도 기록한다. "기본값과 같으면 저장하지 않는다"로 하면 나중에 `defaultTab` 이 바뀔 때 손대지 않은 pane 이 조용히 따라 움직여, 사용자가 이미 확정한 선택이 뒤집힌다.
- **`paneId` 없이 렌더된 인스턴스는 보존하지 않는다.** 저장 키가 없으므로 컴포넌트 상태로 탭을 유지하고 언마운트와 함께 잊는다. 그 경우에 임의의 대체 키(useId 등)를 만들지 않는다 — 재시작 후 되찾을 수 없는 키는 `gcStale` 이 청소해야 할 쓰레기만 남긴다.

## Alternatives Considered

- **`settings.json` 에 마지막 탭 기록.** 재시작 보존은 되지만 pane 축이 없어 두 pane 요구를 못 푼다. 게다가 구성 파일에 즉흥 상태를 섞어 [ADR-0004](0004-settings-vs-ui-state-separation.md) 를 정면으로 어긴다.
- **워크스페이스 세션(pane view config)에 저장.** `viewConfig` 는 이미 pane 단위로 영속되므로 저장 자체는 가능하다. 그러나 그 경로는 "무엇을 보여줄지"(view 타입·리포·CWD 정책)의 구성이고, 탭은 그 안에서의 조작 흔적이다. 오버라이드 레이어가 이미 그 부류를 위해 존재하는데 두 번째 보관소를 열면 GitHubView 상태의 SoT 가 갈라진다.
- **pane 마다 `defaultTab` 을 인스턴스 옵션으로 노출(컨트롤 바에 설정 UI 추가).** 표현력은 같지만 사용자가 한 번 더 설정을 열어야 하고, 요구는 "누른 대로 남아라"였다. 클릭이 곧 선택이면 별도 UI 가 필요 없다.
- **탭 대신 두 목록을 한 pane 에 동시 표시.** 탭 상태 문제가 사라지지만 좁은 pane 에서 행 수가 반으로 줄고, 사용자는 이미 pane 두 개로 그 배치를 만들어 쓰고 있다. 기존 배치를 더 잘 살리는 쪽을 택했다.
- **`defaultTab` 을 항상 이기게(설정이 최종 권위).** 설정 변경이 모든 pane 에 즉시 반영되는 장점이 있으나, 그러면 이 ADR 이 풀려는 문제(재시작 시 전부 Issues 로 회귀)가 그대로 남는다.

## Consequences

- 재시작 후 각 pane 이 마지막 탭으로 열린다. 기존 사용자는 첫 실행 때만 한 번 탭을 고르면 그다음부터 유지된다. 마이그레이션은 없다(오버라이드가 없으면 종전과 동일하게 `defaultTab`).
- `settings.github.defaultTab` 의 의미가 "항상 이 탭"에서 "새 pane 의 첫 탭"으로 좁아졌다. 설정 화면 문구는 이 의미를 따른다.
- 오버라이드 생명주기를 그대로 물려받는다 — pane 삭제 시 `clearAll`, view 타입 전환 시 `clearViewOverride`, 기동 시 `gcStale`. GitHubView 전용 정리 코드는 없다.
- `ViewOverrides` 가 view 타입별 필드를 하나 더 갖는다(`fontSize`·`usageLayout` 에 이어 세 번째). 필드가 계속 늘면 타입을 view 별로 쪼개는 결정이 필요해질 수 있으나, 지금은 [overview.md §4.2](../architecture/overview.md) 가 서술하는 "공존 무해" 전제 안이다.
- Remote 표면은 이 상태를 읽지 않는다. Remote 에 GitHub 목록이 생기면 그 표면의 탭 보존은 별도 결정이다.
- 재검토 조건: 워크스페이스 전체에 걸쳐 탭을 한 번에 맞추는 요구가 생기거나, 스크롤 위치·필터까지 보존 대상이 되면 GitHubView 인스턴스 상태를 한 덩어리로 다시 설계한다.
