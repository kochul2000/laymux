# 0219. Android system back은 Remote UI stack을 순서대로 닫는다

- Status: Proposed
- Date: 2026-08-30
- Source: 사용자 요구("뒤로가기 버튼이 리모트 뷰어나 리모트 메뉴를 닫게", 추가로 먼저 닫을 레이아웃 식별) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md) · [ADR-0184](0184-remote-file-viewer-in-page-overlay.md) · [architecture/api-contracts.md §13](../architecture/api-contracts.md)
- Extends: [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)의 Android thin-wrapper 입력 경계

## Context

Android wrapper는 Remote surface의 system back을 전부 가로채 첫 입력에는 이탈 경고를, 2초 안의 두 번째 입력에는 연결 종료를 적용한다. 이 정책은 terminal session을 실수로 끝내지 않지만 native가 연결 중 표시하는 loading/cancel overlay나 PC가 제공한 Remote 문서 안의 현재 UI stack을 보지 않는다. 따라서 연결을 취소하거나 FileViewer·navigation drawer를 닫아야 하는 상태에서도 back이 보이는 최상위 레이어를 처리하지 않고 이탈 경고부터 표시한다.

Remote 문서에는 FileViewer와 drawer 외에도 더 높은 OAuth relay modal, Composer recall/autocomplete popup, drawer 하위 화면과 Dock disclosure가 있다. Android native가 이 DOM과 상태 변수를 각각 해석하면 PC 소유 Remote UI를 APK에 복제해 wrapper를 얇게 유지한다는 ADR-0149의 경계가 무너진다. 반대로 browser history entry를 레이어마다 만드는 방식은 Android 문제를 해결하는 데 history 수명·bfcache·직접 browser navigation 계약까지 불필요하게 바꾼다.

범위는 Android system back이 native Remote loading/cancel overlay와 현재 Remote 문서의 일시적 레이어를 닫는 입력 라우팅, 기존 disconnect guard의 결합이다. browser/PWA의 history navigation, 자체 system back 처리가 있는 native pairing·connection-settings modal, FileViewer 내부 explorer back 버튼의 의미, Remote 레이어의 시각 디자인은 비목표다.

## Decision

**Android system back은 표시 중인 native Remote loading/cancel overlay를 먼저 취소하고, 없으면 현재 PC 소유 Remote 문서의 단일 `dismissTopLayer()` 경계에 닫기를 위임하며, 둘 다 소비하지 않은 경우에만 기존 2회 disconnect guard를 적용한다.**

- native Remote loading/cancel overlay는 secure WebView보다 위에 있으므로 JavaScript 평가보다 먼저 `cancelRemoteConnection()`으로 닫고 입력을 소비한다. 이때도 과거 disconnect 경고를 해제한다.
- Remote 문서는 `window.laymuxRemoteUi.dismissTopLayer(): boolean`만 wrapper에 노출한다. Android는 이 고정 함수를 `evaluateJavascript`로 호출하며 DOM selector, viewer mode, drawer state를 읽지 않는다.
- 문서는 실제 stacking과 탐색 깊이에 따라 OAuth relay modal → FileViewer overlay → drawer 하위 화면 → workspace drawer의 열린 Dock disclosure → drawer → Composer recall/autocomplete popup 순서로 하나만 닫는다. Composer popup은 자체 z-index가 높아도 `z-index:9`인 부모 stacking context 안에 있어 drawer scrim(10)·drawer(20)보다 아래다. 한 back이 여러 층을 건너뛰지 않는다.
- FileViewer의 system back은 explorer 경유 파일이어도 overlay 전체를 닫는다. explorer의 파일→폴더 복귀는 overlay 헤더의 명시적 back action이고, 기존 Escape·backdrop도 overlay 전체를 닫는 ADR-0198 계약과 맞춘다.
- drawer 하위 화면은 먼저 workspace 기본 화면으로 돌아가고, 그 뒤 back이 Dock을 접거나 drawer를 닫는다. 현재 보이지 않는 drawer 내부 상태가 보이는 상위 레이어보다 먼저 소비하지 않는다.
- 문서가 `true`를 반환하면 native disconnect guard의 과거 경고를 해제한다. 따라서 경고 뒤 레이어를 열고 back으로 닫은 다음 한 번의 back만으로 연결이 종료되지 않는다.
- native는 평가 시작 때의 secure WebView identity와 document generation이 callback 시점에도 현재 Remote 권한 세대인지 확인한다. 진행 중인 평가와 같은 문서에 중복 평가를 시작하지 않으며, stale callback은 이탈 경고나 disconnect를 일으키지 않는다.
- loading/cancel overlay가 없고 함수가 없거나 `false`를 반환하면 혼합 버전 문서에서도 기존 첫 back 경고와 2초 안의 두 번째 back disconnect로 안전하게 fallback한다.

## Alternatives Considered

- **Android가 `fileViewerOverlay`, drawer class와 하위 view를 직접 조회한다.** 즉시 구현할 수 있지만 Remote UI 상태와 우선순위가 Kotlin에 복제되고 새 레이어마다 APK 배포가 필요해 ADR-0149의 소유권을 위반하므로 기각했다.
- **각 레이어를 browser History API entry로 모델링하고 WebView `goBack()`을 호출한다.** browser/PWA까지 같은 입력 모델을 얻지만 bfcache·새로고침·deep link·pagehide lease 수명까지 함께 결정해야 한다. Android의 일시 레이어 닫기보다 범위가 크므로 별도 요구 없이 도입하지 않는다.
- **FileViewer와 drawer만 닫고 나머지는 무시한다.** OAuth modal이 열린 채 아래 viewer/drawer가 닫히거나, drawer 뒤에 남은 Composer popup에서 곧바로 disconnect 경고가 뜨는 적층 누락이 생겨 기각했다.
- **drawer 하위 화면에서도 한 번에 drawer 전체를 닫는다.** 입력 수는 적지만 화면 안의 명시적 back action과 탐색 깊이가 system back에서만 달라지므로 하위 화면을 한 단계씩 푼다.

## Consequences

- Remote 연결 중이거나 FileViewer·OAuth 확인·Composer 추천·Remote navigation을 사용한 뒤 system back이 현재 맥락을 먼저 취소·닫고, 닫을 레이어가 없을 때만 연결 이탈 경고가 나타난다.
- PC Remote 문서가 레이어 목록과 우선순위의 SoT로 남아 browser와 Android가 서로 다른 DOM 해석을 갖지 않는다. 다만 `laymuxRemoteUi.dismissTopLayer`라는 좁은 wrapper 계약을 변경할 때는 PC 자산과 APK 호환 fallback을 함께 검토해야 한다.
- 비동기 JavaScript 평가만큼 back 처리가 지연되며, 평가 중 연타는 무시된다. 이는 한 입력으로 여러 층을 닫거나 곧바로 연결까지 종료하는 것보다 안전한 방향이다.
- Playwright는 실제 Composer popup, OAuth/FileViewer stacking, drawer 하위 화면·Dock·drawer 순서를 고정하고, Android 단위 테스트는 native loading overlay와 문서 레이어 소비가 pending disconnect 경고를 해제하는지 검증한다. Android compile과 Remote asset drift 검증이 native 호출과 배포 bundle의 연결을 보장한다.
- Remote가 새 modal·popover·disclosure를 추가하면 stacking상 system back 대상인지 판단해 같은 단일 함수와 테스트를 갱신한다. browser/PWA back도 같은 stack을 써야 한다는 요구가 생기면 History API 수명은 별도 ADR로 재검토한다.
