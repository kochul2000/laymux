# 0157. Android pairing sheet는 비활성 Cloud WebView 위의 secure overlay다

- Status: Accepted
- Date: 2026-08-15
- Source: 사용자 요구("웹뷰를 배경에 깔고", "완전히 분리된 화면", "동작은 완전 그대로면서 시각적인 트릭") · [architecture/api-contracts.md §13.0](../architecture/api-contracts.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)
- Extends: [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)의 Cloud/pairing WebView 분리와 표시 전환 규칙

## Context

Cloud dashboard에서 PC를 선택한 직후의 pairing 단계는 이미 선택한 PC에 연결하기 위한 짧은 전환이다. 별도 pairing 화면이 Cloud dashboard처럼 보이는 정적 마크업을 다시 그리면 실제 목록과 online 상태가 어긋날 수 있고, 사용자는 그 장면을 실제 Cloud 화면으로 오인한다. 사용자가 요구한 bottom sheet 표현은 실제 dashboard를 배경 문맥으로 유지하되 pairing 작업 자체는 기존 secure 경계가 계속 소유해야 한다.

서로 다른 WebView를 동시에 보이면 입력·접근성·시각적 신뢰 경계가 새로 생긴다. 아래 Cloud 문서가 터치나 TalkBack 포커스를 받으면 sheet가 열린 동안 다른 PC를 선택하거나 Cloud bridge를 호출할 수 있다. 반대로 Cloud 콘텐츠가 secure 상태나 버튼처럼 보이는 요소를 그릴 수 있으므로, 배경이 보인다는 사실을 신뢰 UI 합성으로 취급해서도 안 된다.

범위는 PC 선택 뒤 pairing overlay의 레이어·입력·접근성·표시 정책과 닫기 전환이다. Cloud dashboard 문서·bridge 계약, pairing vault, QR·생체 인증·E2E 연결, PC 제공 Remote surface와 release 계약은 바꾸지 않는다.

## Decision

**Android는 실제 Cloud dashboard WebView를 아래에 계속 표시하되 완전히 비활성화하고, APK local secure WebView가 전체 화면의 투명 scrim과 불투명 pairing bottom sheet를 소유한다.**

- pairing 진입 시 Cloud WebView는 현재 문서와 렌더링 상태를 유지한 채 하위 레이어에서 `VISIBLE`이다. 정적 dashboard 복제·snapshot·screenshot을 만들지 않는다.
- secure WebView는 Cloud보다 위의 full-container 레이어다. 문서 배경은 투명하고 full-screen dismiss layer가 scrim을 그리며 sheet 바깥을 포함한 모든 pointer/touch를 받는다. Android view hit test에서도 secure WebView가 전체 container를 덮어 Cloud로 click-through하지 않는다.
- overlay가 보이는 동안 Cloud WebView는 disabled이며 focus 대상에서 제외하고 접근성 descendants를 숨긴다. 따라서 touch, keyboard focus와 TalkBack 탐색 모두 secure overlay만 대상으로 한다. Cloud JavaScript 실행은 계속될 수 있으므로 native는 현재 전면 surface가 Cloud일 때만 `signInWithGoogle`·`selectInstance` bridge 호출을 받으며 pairing/Remote 동안의 호출은 부작용 없이 거부한다. Cloud WebView는 cookie·navigation 상태를 계속 소유하지만 pairing·E2E bridge 권한을 얻지 않는다.
- 보안 상태, 오류, QR·생체 인증·E2E 동작은 불투명한 secure sheet 안에서만 표시한다. scrim 뒤 Cloud 콘텐츠는 문맥용 비신뢰 배경이며 trusted prompt, 상태 badge 또는 secure action으로 해석하지 않는다.
- 바깥 영역과 취소 버튼은 secure sheet의 종료 애니메이션 뒤 기존 native dashboard 복귀 경로를 호출한다. native는 secure WebView를 숨기고 Cloud WebView의 입력·접근성을 복구한다. 중복 닫기는 한 번만 처리한다.
- PC Remote surface로 전환할 때는 기존처럼 Cloud WebView를 숨기고 secure WebView만 표시한다. Remote 문서와 pairing 문서는 같은 secure WebView를 재사용하되 ADR-0149/0154의 bridge 교체 규칙을 그대로 따른다.
- WebView 레이어의 visibility·input·accessibility 조합은 단일 native 정책 함수에서 계산한다. 개별 전환 함수가 속성을 따로 조작하지 않는다.

## Alternatives Considered

- **APK local 문서가 가짜 dashboard 장면을 함께 그린다.** WebView가 하나라 click-through 위험은 작지만 실제 Cloud 목록·상태와 달라지고 실제 dashboard가 배경이라는 사용자 기대를 위반하므로 기각했다.
- **Cloud와 pairing을 한 WebView DOM에 합친다.** 자연스러운 sheet를 만들 수 있지만 Cloud script에 pairing bridge와 secure action이 노출되어 ADR-0149의 권한 분리를 무너뜨리므로 기각했다.
- **native `BottomSheetDialog`가 Cloud WebView 위에 표시된다.** 입력 격리는 명확하지만 기존 APK local pairing manager의 HTML/JS 상태 렌더링을 native UI로 복제해야 하고 기능이 두 구현으로 갈리므로 선택하지 않았다.
- **Cloud WebView를 screenshot으로 고정해 배경에 둔다.** 실제 화면 모양은 보존하지만 민감한 화면 bitmap의 수명·폐기 정책이 생기고 live WebView를 유지하려는 요구를 충족하지 못하므로 기각했다.
- **Cloud WebView를 보이게만 두고 enabled/accessibility 상태를 유지한다.** 투명 영역의 hit testing이나 보조기술을 통해 Cloud action이 실행될 수 있으므로 허용하지 않는다.

## Consequences

- 사용자는 자신이 방금 선택한 실제 Cloud dashboard를 문맥으로 보면서 pairing 작업만 secure sheet에서 수행한다. Cloud UI가 바뀌어도 Android가 가짜 목록을 동기화할 필요가 없다.
- pairing 동안 두 WebView가 동시에 합성되므로 GPU layer와 메모리 비용이 늘어난다. Remote surface에서는 계속 Cloud를 숨겨 terminal 렌더링과 겹치지 않는다.
- Cloud 배경은 악의적이거나 손상될 수 있는 비신뢰 시각 요소다. secure sheet의 불투명도·z-order·전체 입력 캡처가 깨지면 보안 회귀로 취급한다.
- 자동 검증은 Cloud/secure visibility, Cloud input·접근성 비활성, secure z-order, 투명 local 문서와 가짜 dashboard 부재, 바깥/내부 터치 종료를 포함한다. 실기기에서는 실제 Cloud dashboard가 sheet 뒤에 보이고 sheet 바깥 터치가 Cloud action을 실행하지 않는지 확인한다.
- Android WebView의 투명 합성 또는 접근성 hit testing 동작이 플랫폼 업데이트로 바뀌거나 Cloud가 신뢰 가능한 native surface로 이전되면 이 결정을 재검토한다.
