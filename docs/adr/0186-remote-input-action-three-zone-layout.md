# 0186. Remote 입력 action은 기기별 3-zone 배치를 사용한다

- Status: Accepted
- Date: 2026-08-20
- Source: issue [#889](https://github.com/kochul2000/laymux/issues/889) 및 사용자 합의(기본행 `Ctrl+C · Keyboard · Keys · Send`, Keys 확장행의 Composer 전환과 기존 특수키, 첨부 기본 숨김); [architecture/api-contracts.md §13.4](../architecture/api-contracts.md); [ADR-0004](0004-settings-vs-ui-state-separation.md); [ADR-0028](0028-remote-soft-key-toolbar.md); [ADR-0034](0034-single-send-terminal-composer.md); [ADR-0036](0036-remote-composer-layout-rule.md); [ADR-0040](0040-remote-soft-key-user-order.md); [ADR-0181](0181-remote-terminal-file-attachments.md)
- Extends: [ADR-0028](0028-remote-soft-key-toolbar.md), [ADR-0040](0040-remote-soft-key-user-order.md)
- Amends: [ADR-0036](0036-remote-composer-layout-rule.md)의 desktop layout Send 버튼 부재 결정
- Amended by: [ADR-0213](0213-remote-input-action-segment-placement-and-user-keys.md) — 평탄 zone 배열이 행별 3-구역 배치로, `sets`/`custom` 활성화 모델이 "배치가 곧 활성화"로, 고정 `ctrl-c` action이 소프트키 `c-c`로 바뀌었다.

## Context

ADR-0028/0040의 Remote 키바 설정은 `Keys`가 연 소프트키만 선택하고 정렬했다. `Ctrl+C`, `Keyboard`, 입력 모드 전환, Send, 첨부 같은 입력 action은 header/footer의 고정 위치를 가졌고 서로 같은 배치 모델에 참여하지 않았다. 따라서 사용자는 기기 폭과 사용 방식에 맞춰 자주 쓰는 action을 기본행으로 올리거나 드문 action을 숨길 수 없었다. 설정 진입점도 Keys 행의 `⚙`에 있어 Keys 자체를 숨길 수 있는 모델과 양립하지 않았다.

세트/커스텀 선택과 행 배치가 모두 소프트키 표시를 소유하면 한 키가 두 상태에서 서로 다른 위치를 갖는 중복 SoT가 생긴다. 반대로 모든 상태를 `settings.json`이나 Remote API로 옮기면 한 브라우저 기기의 표시 취향 때문에 호스트 계약과 동기화 범위를 넓히게 된다. 기존 escape sequence, navigation action, structured input, 첨부 업로드와 포커스 보존 계약은 바뀌지 않아야 한다.

이번 결정은 Remote 페이지의 입력 action 배치와 설정 surface만 다룬다. 키 정의, PTY/API wire, 첨부 저장 정책, Composer 초안과 전송 안전성, 데스크톱 UI는 범위 밖이다.

## Decision

**Remote 입력 action은 `main`(기본행), `expanded`(Keys 확장행), `hidden`의 기기별 3-zone 배치를 하나의 surface-local 상태로 저장하고, Remote drawer의 Settings에서 편집한다.**

- `laymux.remote.keybar`의 `zones`가 action의 배치와 각 행 안 순서의 단일 진실원이다. 고정 action ID는 `ctrl-c`, `keyboard`, `keys`, `send`, `composer`, `attachment`이고 일반 소프트키는 안정된 `soft:<key-id>` ID를 사용한다.
- `sets`와 `custom`은 활성 일반 소프트키 집합만 결정한다. `zones`는 비활성 소프트키의 zone과 행내 순서를 보존하며 다시 활성화해도 사용자가 정한 배치를 바꾸지 않는다. 기존 전체 소프트키 `order`는 `zones`에서 매번 재계산하는 ADR-0040 호환 projection으로만 유지하며 zone이나 행내 순서의 독립 소유권을 만들지 않는다. custom 키는 최초 선택 때만 ADR-0040대로 활성 Keys 행 끝에 붙이고, 비활성화 후 재활성화할 때는 보존된 zone과 순서를 복구한다.
- 권장 기본값은 기본행 `Ctrl+C · Keyboard · Keys · Send`, Keys 확장행 `Composer 전환 · 기존 기본 특수키 배열`이며 첨부는 숨김이다. 기존 기본 특수키 배열은 `step`과 `nav` 세트의 기존 `KEY_ORDER` 결과다.
- `Keys`는 구조 토글이므로 기본행 또는 숨김만 허용하고 확장행에는 둘 수 없다. Keys를 숨기면 확장 열림 상태를 즉시 `false`로 저장하고 행을 닫지만, 확장행 action과 순서는 변경하지 않는다. Keys를 기본행에 복구하면 보존된 구성을 다시 열 수 있다.
- `Send`는 배치 설정을 보존하되 Composer mode에서만 렌더한다. desktop/mobile layout 모두 같은 표시 규칙을 쓰며 ADR-0036의 Enter gesture 분류는 유지한다. 즉 desktop layout은 Enter 전송도 유지하면서 명시적 Send action을 함께 보여 줄 수 있다.
- `Ctrl+C`, `Keyboard`, `Send`, `Composer`, `attachment`와 모든 일반 소프트키는 세 zone 사이를 자유롭게 이동하고 행 안에서 재정렬할 수 있다. 이동은 action 자체만 바꾸며 escape sequence, navigation dispatch, file chooser, structured input과 pointer focus 보존 동작을 재사용한다.
- 배치 편집, 세트/커스텀 선택, 키 순서와 Composer 관련 surface-local 설정은 Remote drawer의 Settings에 둔다. 키바의 `⚙` 팝오버는 제거한다. 따라서 Keys와 확장행이 모두 숨겨져도 Settings에서 복구할 수 있다.
- 저장값이 없거나 구조·ID·중복·Keys 위치가 비정상이면 해당 필드를 안전한 기본값으로 정규화한다. 별도 버전 필드나 마이그레이션 단계는 만들지 않는다.
- 3-zone 상태와 확장 열림 상태는 계속 현재 Remote 기기의 `localStorage`에만 저장한다. `settings.json`, Remote API, Automation/MCP, PTY 계약은 변경하지 않는다.
- 좁은 화면에서는 기본행과 확장행이 각각 한 줄을 유지하고 행 내부에서만 가로 스크롤한다. 입력 chrome이 문서의 outer overflow를 만들지 않아야 한다.

## Alternatives Considered

- **일반 소프트키만 사용자 배치하고 고정 action은 유지**: ADR-0028/0040 구현은 가장 적게 바뀌지만 issue #889의 입력 action 자유 배치를 충족하지 못한다.
- **Keys 팝오버를 설정 진입점으로 유지**: 구현 표면은 작지만 Keys를 숨긴 뒤 복구할 길이 없어 구조 토글의 숨김 요구와 충돌한다.
- **Keys를 숨길 수 없게 고정**: 복구는 단순하지만 사용자가 명시적으로 합의한 숨김 요구를 위반한다.
- **하나의 전역 action 순서와 행 경계 인덱스 저장**: 배열 하나로 보이지만 숨김과 비활성 소프트키 복원, Keys의 main-only 불변식을 경계 인덱스와 별도로 관리해야 해 상태 의미가 불명확해진다.
- **`settings.json`과 Remote API로 동기화**: 기기 간 공유는 가능하지만 surface-local 표시 선택을 호스트 설정으로 승격하고 외부 계약과 충돌 해결을 불필요하게 넓힌다.

## Consequences

- 사용자는 모바일 폭과 작업 방식에 맞춰 모든 입력 action의 노출과 우선순위를 정할 수 있고, Keys를 숨겨도 drawer Settings에서 복구할 수 있다.
- 세트/커스텀은 활성 집합, zones는 배치라는 두 책임이 명확해지는 대신 저장 객체와 정규화 규칙이 커진다. 새 action/소프트키는 안정 ID와 기본 zone을 함께 등록해야 한다.
- desktop Composer에도 Send가 표시되어 ADR-0036 당시의 버튼 부재 UX가 바뀐다. 키보드 Enter/Shift+Enter와 mobile Enter 규칙은 바뀌지 않는다.
- 첨부는 권장 기본값에서 보이지 않지만 사용자가 main/expanded로 옮기면 기존 chooser와 업로드 계약을 그대로 사용할 수 있다.
- Playwright는 기본값, 3-zone 이동·행내 재정렬·숨김, Keys 닫힘/구성 보존과 복구, 저장 복원·비정상 fallback, Send 동적 표시, 첨부 chooser, 포커스 보존과 390px outer overflow를 검증한다. Rust 정적 회귀 테스트는 bundled Remote page의 마크업과 계약 문자열을 고정한다.
- 향후 기기 간 배치 동기화나 다른 Remote surface와 공유가 필요하면 ADR-0004의 상태 소유권과 외부 계약을 새 결정으로 재검토한다.
