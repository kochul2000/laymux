# 0213. Remote 입력 action은 행 안의 정렬 구역에 배치하고, 조합키는 사용자가 등록한다

- Status: Proposed
- Date: 2026-08-29
- Source: 사용자 요구(넓은 기기에서 하단 키 레이아웃 고도화, main·keys 정렬 방식 통일, `Ctrl+C`와 `^L`의 표기 불일치 해소, 조합키 사전 정의 축소와 사용자 등록); [architecture/api-contracts.md §13.4](../architecture/api-contracts.md); [ADR-0004](0004-settings-vs-ui-state-separation.md); [ADR-0028](0028-remote-soft-key-toolbar.md); [ADR-0040](0040-remote-soft-key-user-order.md); [ADR-0186](0186-remote-input-action-three-zone-layout.md)
- Extends: [ADR-0028](0028-remote-soft-key-toolbar.md)
- Amends: [ADR-0186](0186-remote-input-action-three-zone-layout.md)의 평탄 zone 배열·활성화 모델·고정 `ctrl-c` action 결정, [ADR-0040](0040-remote-soft-key-user-order.md)의 전역 `order` projection 결정

## Context

ADR-0186의 3-zone 배치는 어느 행에 놓을지는 정할 수 있게 했지만 행 안의 위치는 순서 하나로만 표현했다. 폭이 넉넉한 기기(태블릿, 가로 모드, 데스크톱 브라우저)에서는 버튼이 행 왼쪽에 자연 폭으로 몰리고 나머지 폭이 그대로 빈 공간으로 남는다. 순서만으로는 "이건 왼쪽 끝, 저건 오른쪽 끝"을 표현할 수 없으므로, 넓은 화면 문제는 정렬 개념 없이는 해결되지 않는다.

배치 편집 경로도 둘로 갈라져 있었다. 드로어 Settings의 `Action placement`는 action마다 zone select와 `▲▼` 버튼을 늘어놓은 목록이었고, `Key order`는 소프트키 전용 칩 그리드였다. 같은 "어디에 둘지"를 두 가지 조작 모델로 나눠 배우게 하고, 드래그는 행 경계를 넘지 못했으며, main 행 정렬은 위/아래 버튼이라는 방향 은유가 실제 가로 배치와 맞지 않았다.

키 모델에도 중복과 과잉이 남아 있었다. 고정 action `ctrl-c`와 소프트키 `c-c`는 같은 `\x03`을 보내면서 라벨만 `Ctrl+C`와 `^C`로 달랐다. 반대로 `^A ^D ^E ^K ^R ^W ^Z`는 팔레트에 상시 존재하면서 대부분의 사용자에게 한 번도 쓰이지 않는다. 그러면서 정작 자기 워크플로에 필요한 조합키(가령 `Ctrl+G`, `Alt+.`, `Ctrl+←`)는 등록할 방법이 없었다 — 기존 "Custom keys"는 미리 정의된 키를 고르는 토글이지 새 키를 정의하는 기능이 아니었다.

세트 체크박스(`sets`)와 커스텀 선택(`custom`/`usedCustom`)이 "활성화"를, `zones`가 "배치"를 각각 소유하는 이중 구조도 유지 비용이었다. 한 키를 화면에 세우려면 세트를 켜고 배치까지 확인해야 했고, ADR-0040 호환을 위해 `order` projection을 매 변경마다 재계산해야 했다.

이번 결정은 Remote 페이지의 입력 action 배치·활성화 모델과 소프트키 정의 소유권만 다룬다. PTY/Remote API wire, 첨부 정책, Composer 전송 규칙, 데스크톱 UI는 범위 밖이다.

## Decision

**Remote 입력 action은 두 행 각각의 `left`·`center`·`right` 정렬 구역과 구역 내 순서로 배치하고, 배치 자체가 활성화이며, 기본 제공하지 않는 조합키는 사용자가 등록한다.**

- `laymux.remote.keybar`의 `zones`는 `{ main: {left, center, right}, expanded: {left, center, right} }`이며 배치와 구역 내 순서의 단일 진실원이다. `hidden`은 저장하지 않는다 — 어느 구역에도 없는 action이 곧 팔레트에 있는 action이다.
- **배치가 곧 활성화다.** `sets`, `custom`, `usedCustom`, `order`를 모두 제거한다. 두 행 중 어딘가에 배치된 action만 렌더하고, 배치되지 않은 action은 팔레트에 남는다. ADR-0040의 "사용자가 정한 순서를 보존한다"는 결정은 구역 내 순서가 계승하며, 별도 전역 `order` projection은 두지 않는다.
- 편집 UI는 하나의 칩 편집기로 통일한다. Main 행·Keys 행의 각 구역과 팔레트가 모두 드롭 대상이고, 고정 action과 소프트키를 구분 없이 칩으로 다룬다. ADR-0040의 long-press Pointer Events 드래그를 그대로 쓰되 행·구역·팔레트 경계를 자유롭게 넘고, 칩을 탭하면 행·구역 select와 구역 내 이동 버튼이 나오는 접근성 경로를 제공한다. 드래그는 enhancement이고 탭 경로가 정본이다.
- `Keys`는 여전히 구조 토글이므로 main 행의 세 구역 또는 팔레트에만 놓을 수 있고, 자기가 여는 확장행에는 들어갈 수 없다. 팔레트로 보내면 확장 열림 상태를 `false`로 저장한다.
- 고정 action `ctrl-c`와 전용 `#ctrlC` 버튼을 제거하고 소프트키 `c-c`(`^C`)로 통일한다. 조합키 라벨은 전부 `^X` 계열 표기를 쓴다.
- 기본 제공 Ctrl 조합은 `^C ^J ^U ^T ^L` 다섯 개다. `c-a`, `c-d`, `c-e`, `c-k`, `c-r`, `c-w`, `c-z`는 정의에서 제거하고, 필요하면 사용자가 등록한다.
- 사용자 등록 키는 `userKeys: [{ id, label, seq }]`에 저장한다. `id`는 `/^u-[a-z0-9]{1,24}$/`(내장 id 및 `__proto__`/`constructor`와 구조적으로 충돌 불가), `label`은 1–8자, `seq`는 1–32 code unit, 최대 24개이며 정규화가 항목 단위로 검증하고 실패 항목만 버린다. 등록 방식은 조합 피커(Ctrl / Alt / Ctrl+Alt + 베이스 키, Shift는 Alt를 포함할 때만 의미가 있으므로 그때만 활성)와 raw 시퀀스 입력(`\e \xNN \r \n \t \0 \\`) 두 가지다.
- 등록된 키는 `keyDef()` 단일 조회를 거쳐 내장 키와 동일하게 `sendKey → enqueueInput → /remote/v1/terminals/{id}/write` 경로를 탄다. 새 Remote API도, 새 전송 경로도 만들지 않는다.
- 저장값이 v2 shape이 아니면 — ADR-0186의 평탄 배열 포함 — 마이그레이션하지 않고 기본 배치로 되돌린다. 정상 shape 안의 미지·중복 ID는 항목 단위로 버리고, 배치되지 않은 action을 기본값으로 채워 넣지 않는다. 버전 필드는 두지 않는다.
- 배치·확장 열림·사용자 키는 계속 현재 Remote 기기의 `localStorage`에만 저장한다. `settings.json`, Remote API, Automation/MCP, PTY 계약은 변경하지 않는다.
- 두 행은 CSS grid 3열 + `justify-content: space-between`으로 그린다. 구역 컨테이너에 `min-width: 0`을 주지 않는다 — 트랙의 자동 최소 크기가 0이 되어 구역이 내용보다 좁아지고 이웃 구역과 겹치기 때문이다. 폭이 모자라면 행 내부에서만 가로 스크롤하며, 문서에는 outer overflow를 만들지 않는다.

## Alternatives Considered

- **정렬 없이 순서만 유지하고 넓은 화면에서 버튼을 균등 분배**: 구현이 가장 작지만 "왼쪽 끝 / 오른쪽 끝"을 사용자가 지정할 수 없어 요구를 충족하지 못한다. 중앙 정렬 + 최대폭 캡도 같은 이유로 기각했다 — 배치 의도가 아니라 한 가지 고정 배열만 강요한다.
- **구역을 더 잘게(4·5분할) 나누기**: 표현력은 늘지만 좁은 화면에서 의미가 사라지는 구역이 늘고, 편집 UI가 다시 목록형으로 비대해진다. 좌·중·우 셋이 실제로 구분되는 정렬의 전부다.
- **`hidden` 배열도 저장**: 팔레트 순서까지 사용자가 정할 수 있지만, 팔레트는 카테고리 그룹으로 렌더하므로 저장된 순서가 화면에 드러나지 않는다. 저장하지 않으면 중복 검사가 6개 구역으로 끝난다.
- **`sets`/`custom` 활성화 모델 유지**: 기존 저장값과 호환되지만 한 키를 세우는 데 두 단계를 요구하고, 활성화와 배치가 서로를 무효화하는 상태를 계속 관리해야 한다.
- **legacy 평탄 zone 배열을 각 행 `left`로 흡수**: 사용자 배치를 일부 살릴 수 있지만, ADR-0186 기본값 사용자는 확장행 `left`에 전 소프트키가 몰려 오히려 망가진 배치를 물려받는다. 내부 개발 단계이므로 AGENTS.md의 "마이그레이션 불필요" 원칙대로 기본값 복귀를 택했다.
- **`^A`~`^Z` 전체 유지 + 등록 기능만 추가**: 트리밍 없이도 요구는 충족되지만, 팔레트가 계속 실사용되지 않는 칩으로 채워져 등록 기능이 해결하려던 문제(원하는 키를 찾기 어렵다)를 그대로 남긴다.
- **사용자 키를 `settings.json`으로 승격**: 기기 간 공유가 가능하지만 surface-local 표시 선택을 호스트 설정과 외부 계약으로 끌어올린다. ADR-0004/0028/0186의 경계를 그대로 유지했다.

## Consequences

- 넓은 기기에서 하단 키가 좌·우로 갈라져 엄지 접근성이 살아나고, 좁은 기기에서는 기존의 행 내부 스크롤·축소 정책이 그대로 유지된다.
- 설정에서 배울 조작이 하나로 줄고, 드래그가 행·구역·팔레트를 모두 넘는다. 반대로 기존 사용자는 익숙한 `Action placement` 목록과 세트 체크박스를 잃는다.
- **기존 `laymux.remote.keybar` 배치는 전부 초기화된다.** 마이그레이션은 없다. 내부 개발 단계라 수용하지만, 외부 배포 이후라면 이 결정은 재검토 대상이다.
- `sets`/`custom`/`order`와 그 동기화 코드(`resolveKeyIds`, `projectSoftKeyOrderFromZones`, `commitKeyOrder`, `reorderKey` 등)가 사라져 키바 상태 기계가 단순해진다.
- 사용자 키는 기기 로컬이므로 다른 기기·브라우저에서는 다시 등록해야 한다. `localStorage`가 지워지면 함께 사라진다.
- 임의 시퀀스를 사용자가 입력할 수 있게 되므로 정규화가 유일한 방어선이다. 길이·타입·id 패턴·개수 상한을 정규화에서 강제하고, e2e가 프로토타입 오염과 경계값을 고정한다.
- `remote-page-layout.spec.ts`의 소프트키 관련 테스트는 이제 배치를 명시적으로 시드해야 한다(placement = activation). 기존 `drags visible soft keys…` 테스트는 새 `remote-input-layout.spec.ts`가 대체한다.
- CSS grid + `overflow-x` 조합은 데스크톱 Chromium 밖에서 재검증이 필요하다. 특히 iOS/WebKit의 스크롤 전환은 실기기 확인 대상으로 남는다.
- 재검토 조건: 사용자가 기기 간 배치 공유를 요구하면 `settings.json` 승격을 새 ADR로 다룬다. 좌·중·우 셋으로 표현되지 않는 배치 요구가 나오면 구역 모델 자체를 다시 연다.
