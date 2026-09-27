# 0273. Remote 물리 키보드 상태와 탐색 단축키는 기기 표면에서 처리한다

- Status: Proposed
- Date: 2026-09-27
- Source: 사용자 요구(물리 키보드 연결 시 플로팅·Keys 개별 숨김, 기본 활성 Remote Nav 단축키), [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md), [ADR-0209](0209-remote-display-preferences-are-device-local.md), [ADR-0237](0237-remote-floating-input-controls.md), [ADR-0243](0243-settings-mcp-scoped-discovery-and-remote-device-bridge.md), [api-contracts.md §13.4·§15.5](../architecture/api-contracts.md)
- Extends: ADR-0149의 native 환경 정보 전달, ADR-0237의 표시 조건, ADR-0243의 기기 로컬 설정 목록
- Supersedes in part: [ADR-0269](0269-remote-physical-keyboard-shortcuts.md)의 감지 제외·기기별 재바인딩 제외 범위와 기본 방향키 정책. Composer 및 나머지 PC 공유 단축키는 유지한다.

## Context

물리 키보드가 연결된 Android Remote에서는 터치 입력 보조 컨트롤이 화면을 가린다. 플로팅과 Keys 행을 각각 자동으로 숨기되 사용자가 구성한 배치와 펼침 상태를 잃지 않아야 한다. 일반 웹에는 물리 키보드 연결·해제를 신뢰할 수 있게 알려주는 API가 없으며 키 입력이나 소프트 키보드의 표시만으로 판정하면 잘못 숨길 수 있다.

Remote의 Nav 패드는 pane 순회와 알림 탐색을 제공한다. 사용자는 물리 키보드 감지와 독립적으로 보조키+방향키를 이 동작에 할당하고 PC용 Alt/Ctrl+Alt 방향키 전달을 막기를 원한다. 앱 키 입력과 브라우저 편집·IME·설정 입력은 구분해야 한다. APK에 Remote 도메인 동작을 복제하거나 PC 전역 키바인딩을 수정하는 것은 범위 밖이다.

ADR-0269 구현은 Alt 방향 이동과 Ctrl+Alt 워크스페이스·알림 이동을 PC 바인딩 그대로 적용한다. 이번 요구의 기기별 Nav 옵션은 이 기본 방향키 처리보다 우선하며, 옵션을 끄면 해당 PC 공유 경로로 돌아간다. 기존 키바인딩 데이터·다른 단축키·착지 중 입력 보호를 복제하지 않는다.

## Decision

**Android native가 연결 상태만 제공하고, PC 소유 Remote UI가 기기 로컬 숨김 선호와 재설정 가능한 Nav 단축키를 적용한다.**

- Android `InputManager`의 장치 목록에서 가상 장치를 제외한 문자 입력용 키보드 존재를 판정한다. 장치 추가·제거·변경과 foreground 복귀에서 다시 조회한다. 복수 키보드 중 하나만 분리해도 나머지가 있으면 연결 상태를 유지한다. 키보드 구성 변경으로 Activity와 E2E 세션을 재생성하지 않는다.
- 현재 승인된 secure Remote 문서 세대에만 동기 snapshot과 변경 통지를 제공한다. Cloud 문서에는 노출하지 않는다. 상태는 영속하거나 호스트로 전송하지 않는다. 구형 앱·브라우저는 `unknown`으로 취급하고 자동 숨김을 적용하지 않는다.
- `hideFloatingWithKeyboard`와 `hideKeysWithKeyboard`는 각각 기본 true인 독립 기기 설정이다. 연결이 확인된 동안에만 적용하며 후자는 Keys 행과 Keys 토글을 숨긴다. 원래 플로팅 설정·행 배치·펼침 상태는 보존하고 분리 시 복원한다. 플로팅만 숨겼을 때도 이미 열린 Keys 행은 유지한다.
- `useRemoteNavigationKeys`는 기본 true이며 감지 여부와 무관하다. `remoteNavigationModifiers`는 기본 `alt`, 선택지는 `alt`, `ctrlAlt`, `altShift`, `ctrlShift`다. 중앙 Remote 키바인딩 모듈에서 보조키를 해석하고 기존 Nav 패드와 방향→액션 매핑을 공유한다. ↑/↓는 pane 이전/다음, ←/→는 기존 알림 recent/oldest 탐색이다.
- 활성 상태에서는 선택 조합과 기존 Alt/Ctrl+Alt 방향키를 Remote가 소비한다. 선택되지 않은 기존 조합은 실행하지 않고 버린다. 선택 조합은 키를 누를 때 한 번 실행하고 반복·keyup은 추가 탐색 없이 소비한다. 끄면 기존 PC 공유 키바인딩 경로가 그대로 처리한다. 다른 PC 단축키와 Composer 바인딩은 유지하며 PC의 전역 설정은 바꾸지 않는다.
- 단축키는 제어권을 가진 Remote terminal/Composer 표면에서 처리한다. 설정·도구·별도 편집 필드 및 IME 조합·AltGraph는 가로채지 않는다. 소비한 이벤트는 xterm·Composer 입력까지 전달하지 않으며 기존 lease 검증과 순차 탐색 큐를 재사용한다.
- 설정은 기존 Remote localStorage와 Remote settings MCP에 속한다. UI에서 두 숨김 설정, Nav 활성, 보조키를 각각 변경한다. §15.5의 중앙 등록·재바인딩 원칙을 기기 전용 레지스트리와 설정 UI로 적용하고 PC `settings.json.keybindings`와는 독립으로 둔다. 새 host navigation endpoint나 E2E wire 버전은 만들지 않는다.

## Alternatives Considered

- 브라우저 `keydown`/화면 키보드 크기로 연결을 추정: 연결 해제와 입력 장치 종류를 확정할 수 없어 숨김 복원을 보장하지 못한다.
- 플로팅 enabled와 Keys expanded 저장값을 연결 시 덮어쓰기: 사용자가 지정한 원래 상태와 자동 숨김 상태가 섞여 분리 후 복원할 수 없다.
- 네이티브에서 방향키를 탐색 명령으로 번역: APK가 Remote 액션·설정·lease를 복제하게 되므로 원시 환경 정보만 전달한다.
- PC 전역 단축키를 수정: 다른 기기와 데스크톱 사용자까지 영향을 받으므로 현재 Remote 문서의 입력만 소유한다.

## Consequences

Android는 연결 전·중·복귀 상태를 제공할 수 있고 일반 브라우저도 Nav 단축키를 사용할 수 있다. 자동 숨김에는 갱신된 APK가 필요하며 브라우저에서는 기존 수동 표시 설정을 사용한다. 키보드 정보는 메모리 상태만 늘리고 설정은 기존 기기 저장소를 사용하므로 마이그레이션은 없다.

감지 생명주기·설정 검증·단축키 분류를 단위 테스트로, 실제 Remote 문서에서 분리 복원·독립 숨김·입력 누출·편집 필드 제외·재접속을 브라우저 테스트로 고정한다. USB/Bluetooth 장치의 실제 등록 특성은 Android 실기 검증 대상이다. 향후 웹에서 신뢰 가능한 연결 API를 제공하거나 Nav의 액션별 임의 재바인딩 요구가 생기면 이 결정을 확장한다.
