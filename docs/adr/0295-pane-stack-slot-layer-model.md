# 0295. Pane 스택: 슬롯/레이어 모델

- Status: Proposed
- Date: 2026-10-06
- Source: 사용자 요구(2026-10-06, pane 에 split 외 stacked 모드 추가), [overview.md](../architecture/overview.md) §4, [data-flow.md](../architecture/data-flow.md) §5·§13.7
- 확장: [ADR-0007](0007-pane-identifier-trio.md)(식별자 3종), [ADR-0081](0081-pane-focus-transition-single-owner.md)(포커스 전환 단일 소유), [ADR-0140](0140-split-pane-inherits-source-cwd.md)(분할 CWD 상속), [ADR-0039](0039-remote-spatial-notification-step-navigation.md)(Remote 공간순서)

## Context

워크스페이스 격자는 지금 **평면 rect 목록**이다. `Workspace.panes[i]` 하나가 기하(`x,y,w,h`)·콘텐츠(`view`)·정체성(`id` → `terminal-<id>`, 오버라이드·메모·알림·hidden flag·재시작 버스 키)을 모두 겸한다. 화면을 더 쪼개는 방법은 split 하나뿐이라 터미널이 늘어날수록 각 pane 이 작아진다.

사용자는 같은 자리에 여러 view 를 겹쳐 두고 전환하는 **stacked 모드**를 원한다. 스택된 pane 은 상단에 전환용 한 줄을 고정하고, 키보드로 스택을 순회할 수 있어야 한다. 터미널만이 아니라 pane 의 직속 자식으로 어떤 view 든 쌓을 수 있어야 한다.

이 기능은 "1 pane = 1 rect = 1 콘텐츠" 등식을 깬다. 그래서 결정의 핵심은 UI 가 아니라 모델이다.

- **force — 기하 불변식.** 리사이즈(ADR-0071)·제거 재분배·경계 핸들·공간 이동·swap·Rust `validate_and_repair` 는 모두 "pane 들이 겹치지 않고 그리드를 덮는다"를 전제한다.
- **force — 정체성 안정성.** terminal id 는 pane id 에서 파생되고 세션 복원·출력 캐시·알림이 그 id 에 묶인다. 스택 조작이 살아 있는 터미널을 재마운트하거나 id 를 바꾸면 안 된다.
- **force — 외부 계약.** Automation/MCP/Remote 는 `paneIndex`(레이아웃 조작)와 `paneNumber`(사람/AI 지칭), terminal id 를 쓴다. 스택이 없는 사용자의 결과는 바뀌지 않아야 한다.
- **force — 다운그레이드.** 릴리즈 사용자가 업데이트 후 되돌려도 스택을 쓰지 않은 워크스페이스는 살아 있어야 한다.

범위: 워크스페이스 격자의 pane. 비목표: dock pane 스택(dock 은 단일 view 중심이며 자체 아이콘바 전환이 있다), 레이어 간 동시 표시(그건 split 이다).

## Decision

**워크스페이스 pane 은 기하를 소유하는 슬롯이고, 콘텐츠는 슬롯의 순서 있는 레이어 목록이 소유한다. 슬롯은 정확히 하나의 활성 레이어를 보인다.**

### 모델과 SoT

```ts
interface PaneLayer { id: string; view: ViewInstanceConfig }
interface WorkspacePane { id: string; x; y; w; h; layers: PaneLayer[]; activeLayerId: string }
```

- 슬롯 불변식: `layers.length >= 1`, `activeLayerId ∈ layers`, 레이어 id 는 앱 전체에서 유일하고, 슬롯 id 는 자기 레이어 id 와만 같을 수 있다(그 레이어를 다른 슬롯으로 옮기거나 꺼내면 남는 슬롯이 새 id 를 받고 pane 오버라이드를 들고 간다). 기하는 슬롯에만 존재하므로 기하 소비자(리사이즈·재분배·경계·공간 이동·swap·Rust 겹침 검사)는 슬롯만 보고 바뀌지 않는다.
- 레이어 생성·제거·활성화·순서 변경·슬롯 간 이동은 `ui/src/lib/pane-layers.ts` 의 순수 함수와 `workspace-store` 액션만 수행한다. 컴포넌트는 `layers`/`activeLayerId` 를 직접 쓰지 않는다.
- 단일 레이어 슬롯은 오늘의 pane 과 동일하게 동작하고 보인다. 스택 UI 는 레이어가 2개 이상일 때만 나타난다.

### 식별자 (ADR-0007 확장)

| 식별자 | 대상 | 용도 |
|---|---|---|
| 슬롯 id | 슬롯 | DOM 슬롯 키가 아님(아래 렌더 참조). swap·워크스페이스 간 이동·pane 오버라이드(`controlBarMode`) 키 |
| 레이어 id | 레이어 | 오늘의 "pane id" 가 하던 콘텐츠 역할 전부: `terminal-<layerId>`, `viewOverrides`, 메모, 재시작/CWD 시드 버스, 알림, hidden flag, 시작 코디네이터, `LX_TERMINAL_ID` |
| `paneIndex` | 슬롯 | 레이아웃 조작(split/remove/resize/swap/focus). 같은 슬롯의 레이어는 같은 `paneIndex` 를 공유 |
| `paneNumber` | 레이어 | 슬롯 읽기 순서(y→x) 안에서 레이어 순서로 1..N 연번. `lx:pane:<ws>:<n>` 은 계속 터미널 하나를 가리킨다 |

- 새 슬롯(분할·레이아웃 생성)은 첫 레이어 id 를 슬롯 id 와 같게 만든다. 이는 생성 규칙일 뿐 불변식이 아니다. 원래 레이어를 닫아도 슬롯 id 는 바뀌지 않는다.
- id 로 슬롯을 찾는 진입점은 슬롯 id 와 레이어 id 를 모두 받아 같은 슬롯으로 해석한다.

### 렌더와 생명주기

- `PaneGrid` 는 슬롯을 **레이어 박스로 평탄화**해 그린다. 각 레이어 박스는 슬롯 rect 를 그대로 쓰는 형제 요소이며 **레이어 id 로 key** 한다. 활성 레이어만 보이고 나머지는 `display:none` 이다.
- 따라서 활성 전환·순서 변경·슬롯 간 레이어 이동·레이어를 split 으로 꺼내기·이웃 슬롯을 스택으로 합치기 모두 터미널을 재마운트하지 않는다. 재마운트는 오늘처럼 워크스페이스 간 이동·프로파일 변경·hidden 회수에서만 일어난다.
- 비활성 레이어는 비활성 워크스페이스 pane 과 같은 경로를 탄다: PTY 유지, parser admission background 클래스, 복귀 시 atlas 재생성과 fit 한 번. 새 수명주기를 만들지 않는다. 시작 코디네이터는 활성 레이어를 비활성 레이어보다 먼저 연다.
- 스택 전환 줄(`PaneStackStrip`)은 레이어가 2개 이상인 슬롯의 활성 박스 최상단에 고정되고, 컨트롤 바와 콘텐츠는 그 아래에 놓인다. 컨트롤 바 hover 오버레이는 전환 줄을 가리지 않는다.

### 동작 의미

- **쌓기**: 컨트롤 바의 Stack 버튼(split 버튼 옆), `pane.stack` 키, Automation `stack_pane` 은 대상 슬롯 활성 레이어 바로 뒤에 `EmptyView` 레이어를 추가하고 활성화한다. 어떤 view 든 고를 수 있다.
- **CWD 시드 (ADR-0140 확장)**: 새 레이어의 첫 터미널 세션은 누른 슬롯의 **활성 레이어** CWD 를 상속한다. 같은 재시작 요청 버스를 쓰고, 명시 `cwd` 가 이긴다.
- **삭제**: 컨트롤 바 Delete·`pane.delete`·`remove_pane` 은 슬롯의 활성 레이어 하나를 닫는다(Automation 은 `layerId` 로 특정 레이어 지정 가능). 마지막 레이어를 닫으면 오늘처럼 슬롯이 사라지고 공간이 재분배된다. 유일 슬롯의 유일 레이어는 닫을 수 없다. 닫힌 활성 레이어의 다음 레이어(없으면 이전)가 활성이 된다. 경계선 병합(드래그 끝·더블클릭)은 스택 슬롯을 지우지 않는다 — 여러 터미널을 확인 없이 닫는 경로가 되기 때문이며, 스택 슬롯은 최소 크기로 남고 레이어는 명시적으로 닫는다.
- **split·swap·워크스페이스 간 이동**: split 은 슬롯을 나누고 새 슬롯은 단일 레이어로 태어난다. swap 과 워크스페이스 간 이동은 슬롯 통째(모든 레이어)를 옮긴다.
- **레이어 재배치 (2차 범위)**: 전환 줄 탭 드래그로 순서를 바꾸고, 다른 슬롯에 떨어뜨리면 그 슬롯 스택으로 옮긴다. 레이어를 split 으로 꺼내기와 이웃 슬롯을 스택으로 합치기를 제공한다. 원래 슬롯이 비면 사라지고 공간이 재분배된다.

### 포커스와 키보드 (ADR-0081 확장)

- 포커스 대상은 계속 슬롯 인덱스(`focusedPaneIndex`)이고, 포커스된 콘텐츠는 그 슬롯의 활성 레이어다.
- 레이어 활성화+포커스 commit 은 `workspace-transition.ts` 의 `activatePaneLayer(workspaceId, layerId, { focus })` 한 곳이 소유한다. 탭 클릭, 키보드, Automation/Remote `terminals.setFocus`, 알림 이동처럼 비활성 레이어를 가리키는 모든 흐름이 이 함수를 쓴다.
- `pane.layer`(기본 `Alt+Shift+Arrow` 와일드카드): Right/Down 은 다음, Left/Up 은 이전 레이어, 링 순환. 스택이 아닌 슬롯에서는 no-op 이며, 이때 조합은 터미널 앱에 그대로 전달된다(포커스 슬롯이 스택일 때만 패스스루). `pane.stack`(기본 `Ctrl+Alt+S`)은 스택을 새로 만들어야 하므로 항상 앱 단축키다.
- `pane.focus`(`Alt+Arrow`)의 막힌 방향: 이웃 슬롯 → (`dock.arrowNav` 면) 보이는 dock → (`paneStack.cycleOnBlockedArrow`, 기본 `true`) 포커스 슬롯의 스택 순환 순으로 해석한다. dock 이 스택보다 먼저인 이유는 화면 전체를 차지한 스택 슬롯에서도 dock 진입이 막히지 않게 하기 위해서다. 규칙은 "그쪽에 무엇이 있으면 거기로, 아무것도 없으면 스택을 넘긴다"이다.
- 알림 자동 해제는 포커스된 슬롯뿐 아니라 활성 레이어 변경에도 반응한다.

### 외부 계약

- Frontend bridge `workspaces.list`/`getActive` 와 MCP `get_active_workspace`·`list_terminals` 의 `panes` 는 **레이어마다 한 항목**이다. 항목은 레이어 `id`·`view`·슬롯 기하·`paneIndex`(슬롯)·`paneNumber`(레이어)·`terminalId` 를 갖고, 추가 필드 `slotId`·`layerIndex`·`layerCount`·`activeLayer` 를 싣는다. 스택이 없으면 항목과 값은 오늘과 같다.
- 신규 계약: REST `POST /api/v1/panes/stack`·MCP `stack_pane`(split_pane 미러, `cwd`·`ready` 동일 의미), REST `POST /api/v1/panes/layers/activate`·MCP `activate_pane_layer`(`layerId` 또는 `terminalId`, 선택 `focus`). `remove_pane` 은 선택 `layerId` 를 받는다.
- `focus_terminal`·Remote terminal focus 는 대상이 비활성 레이어면 활성화까지 수행한다. `identify_caller` 는 `pane.stack = { position, count, layerIds }` 를 추가하고, 이웃은 슬롯 기준으로 계산해 그 슬롯의 활성 레이어 터미널을 보고한다.
- Remote navigation 의 workspace pane 행은 레이어마다 하나이며 비활성 레이어 행은 `activeLayer:false` 로 내려간다. Remote 공간순서(ADR-0039)는 (슬롯 읽기순 × 레이어순)의 터미널 레이어 전부다.
- 워크스페이스 클리어 브로드캐스트(ADR-0137)는 비활성 레이어를 포함한 격자의 모든 터미널 레이어가 대상이다. 단일 pane 클리어·hidden 토글·자동 회수는 레이어 단위다.

### 영속과 호환

- 메모리 표현은 항상 `layers`/`activeLayerId` 다.
- `settings.json` 기록은 **단일 레이어이고 레이어 id 가 슬롯 id 와 같으면 오늘의 축약형 `{ id, x, y, w, h, view }`** 로, 그 밖에는 `{ id, x, y, w, h, layers, activeLayerId }` 로 쓴다. 스택을 쓰지 않은 사용자의 파일은 바이트 단위로 같은 모양을 유지하고 이전 버전으로 되돌려도 읽힌다.
- 읽기(Rust 모델·프론트 적용)는 두 형태를 모두 받아 `layers` 로 정규화한다. 레이어가 없거나 `activeLayerId` 가 목록에 없으면 첫 레이어로 복구하고, 둘 다 없는 pane 은 기존 lenient 규칙대로 버린다. 이는 AGENTS.md 의 "마이그레이션 불필요" 규칙의 예외이며, 사용자가 2026-10-06 명시적으로 승인했다.
- 레이아웃 템플릿(`LayoutPane`)은 선택 `layers: [{ viewType, viewConfig? }]`·`activeLayerIndex` 를 갖고, 단일 레이어면 기존 `viewType`/`viewConfig` 축약형으로 쓴다.
- 설정 `paneStack.cycleOnBlockedArrow`(기본 `true`)를 추가한다.

## Alternatives Considered

- **평면 목록 유지 + `stackId` 로 묶기.** 같은 스택 멤버가 같은 rect 를 중복 보유한다. 타입 변경은 거의 없지만 "멤버 rect 는 같다"는 불변식을 리사이즈·재분배·경계·swap·공간 이동·Rust 겹침 검사·paneNumber·미니맵이 각자 지켜야 한다. ADR-0005 의 단일 계산 원칙에 반하고 실패가 컴파일 오류가 아니라 조용한 레이아웃 붕괴로 나타나 기각했다.
- **슬롯의 `id`/`view` 를 활성 레이어로 두고 나머지만 별도 목록에 보관.** 활성 전환마다 슬롯 id 가 바뀌어 DOM 키와 오버라이드 키가 흔들리고, 슬롯 키 기반 렌더에서는 전환이 재마운트를 일으킨다. 기각.
- **터미널 전용 스택.** 레이어는 `ViewInstanceConfig` 를 담는 슬롯 컨테이너 개념이라 콘텐츠 타입과 직교한다. 터미널 한정은 view 전환·EmptyView 선택 같은 기존 경로에 특수 분기만 늘리고, `ViewRenderer` 는 이미 모든 타입을 그린다. 기각.
- **슬롯 키 렌더(슬롯 div 안에 레이어 자식).** 레이어를 다른 슬롯으로 옮기거나 split 으로 꺼낼 때 부모가 바뀌어 React 가 재마운트한다. 레이어 id 키 평탄화가 같은 비용으로 이 문제를 없앤다.
- **막힌 방향 순환을 끄고 전용 키만 제공.** 사용자가 기본 ON 을 선택했다. 명시 키(`Alt+Shift+Arrow`)가 별도로 있으므로 레이아웃에 따라 `Alt+Arrow` 의미가 바뀌는 모호함은 설정으로 끌 수 있는 수준으로 판단했다.
- **dock pane 까지 스택 지원.** dock 은 아이콘바 view 전환이 이미 같은 역할을 하고 store·자동화 표면이 별도라 범위가 두 배가 된다. 이후 요구가 생기면 같은 모델을 `DockPane` 에 적용하는 별도 결정으로 다룬다.

## Consequences

- 스택을 쓰지 않으면 화면·자동화 응답·`settings.json` 이 그대로다. 단일 레이어 슬롯의 DOM 키는 레이어 id(=슬롯 id)라 기존 터미널도 재마운트되지 않는다.
- `pane.view` 를 읽던 콘텐츠 소비자 전부가 활성 레이어 또는 레이어 목록을 읽도록 바뀐다. 타입이 바뀌므로 누락은 컴파일 오류로 드러난다. 테스트 픽스처도 같이 바뀐다.
- 비활성 레이어 터미널도 PTY 와 메모리를 쓴다. 스택이 깊으면 hidden 워크스페이스와 같은 비용을 진다. 필요하면 이후 hidden 자동 회수 정책을 비활성 레이어로 확장한다.
- `paneIndex` 가 레이어 간에 중복되므로 Automation 호출자는 터미널을 가리킬 때 terminal id 나 `paneNumber` 를 써야 한다. 이는 ADR-0007 의 기존 권고와 같다.
- 외부 계약 추가(`stack_pane`, `activate_pane_layer`, 응답 필드)는 additive 다. `remove_pane` 의 의미는 스택 슬롯에서만 "레이어 하나 닫기"로 좁아진다.
- 재검토 조건: dock 스택 요구, 비활성 레이어 리소스 문제, 막힌 방향 순환에 대한 사용자 혼란 보고.
