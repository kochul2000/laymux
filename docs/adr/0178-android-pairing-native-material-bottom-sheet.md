# 0178. Android pairing은 네이티브 Material bottom sheet가 소유한다

- Status: Accepted
- Date: 2026-08-18
- Source: 사용자 요구("원래부터 그렇게 만들어야 경계가 맞는 거 아니냐", "그렇게 수정해") · [architecture/api-contracts.md §13](../architecture/api-contracts.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md) · [ADR-0157](0157-android-pairing-sheet-over-live-cloud-webview.md)
- Supersedes: [ADR-0157](0157-android-pairing-sheet-over-live-cloud-webview.md)

## Context

Cloud dashboard에서 PC를 선택한 뒤 표시하는 pairing UI는 PWA나 PC Remote 문서와 공유되지 않는 Android APK 전용 표면이다. 그런데 ADR-0157은 APK local secure WebView가 전체 화면 scrim과 bottom sheet의 모양·애니메이션·dismiss를 모두 HTML/CSS/JavaScript로 재현하도록 정했다. 이 구현은 Cloud WebView를 비활성화하고 별도 bridge를 사용하므로 Cloud와 key 권한의 보안 경계는 유지하지만, Android 플랫폼이 소유해야 할 modal container까지 웹 문서가 소유한다.

그 결과 drag handle은 장식일 뿐 실제 drag를 제공하지 않고, system/predictive back, swipe dismiss, window inset, modal accessibility와 sheet state를 별도로 흉내 내야 한다. 고정된 웹 높이 안에서 접힌 설정이 주요 action 아래 숨는 정보 구조 문제도 생겼다. 이 pairing 표면은 웹에 재사용되지 않으므로 웹 렌더링을 유지할 플랫폼 간 이점도 없다.

범위는 PC 선택 뒤 pairing·E2E session 진입 표면의 UI 컨테이너와 렌더링 소유권이다. Cloud dashboard와 PC 소유 Remote UI, Kotlin의 QR·Keystore·생체 인증·E2E transport, pairing vault 및 protocol 계약은 바꾸지 않는다.

## Decision

**Android pairing UI 전체와 그 modal lifecycle은 네이티브 Material bottom sheet가 소유하고, secure WebView는 E2E로 검증한 PC Remote 문서를 표시할 때만 사용한다.**

- PC 선택 시 Cloud WebView는 현재 문서를 유지한 채 하위 레이어에서 보이지만 native layer policy가 입력·focus·접근성 descendants와 Cloud bridge action을 비활성화한다.
- native Material bottom sheet가 scrim, drag handle, swipe/system back/predictive back dismiss, window inset, accessibility modal semantics와 expanded/hidden state를 소유한다. dismiss는 기존 Cloud dashboard 복귀 경로 하나로 수렴한다.
- pairing 상태 표시는 Kotlin의 typed raw state에서 단일 presentation 계산으로 도출한다. QR scan, 보호 정책 변경, instance별 확인 재시도·키 확인·삭제, session 열기·취소는 JavaScript bridge를 거치지 않고 기존 native 함수에 직접 연결한다.
- 보안 session이 열리면 sheet를 닫고 Cloud WebView를 숨긴 뒤 secure WebView에 PC가 제공한 E2E Remote 문서만 적재한다. pairing용 APK HTML·CSS·JavaScript와 pairing 전용 JavaScript interface는 제거한다.
- secure WebView의 이전 Remote 문서는 native sheet나 Cloud가 전면인 동안은 물론, 다음 PC의 새 문서가 적재되는 전환 중에도 bridge 권한을 갖지 않는다. native는 Remote를 떠날 때 secure WebView를 폐기하고 새 문서 세대를 설치하며, 현재 전면 surface가 Remote이고 그 세대가 승인 세대와 일치할 때만 resource·transport·output·disconnect·외부 링크 callback을 처리한다.
- bottom sheet의 주요 action 아래에 숨은 후속 메뉴를 두지 않는다. 연결 설정 진입 행을 명시적으로 표시하고, 확장된 설정 내용 뒤에 dismiss action을 마지막으로 둔다.
- Cloud background는 계속 비신뢰 문맥이다. dialog가 modal 입력을 막더라도 Cloud WebView의 native 비활성화와 bridge gate를 함께 유지하며 어느 한쪽만 보안 경계로 의존하지 않는다.

## Alternatives Considered

- **기존 full-screen secure WebView가 HTML/CSS bottom sheet를 계속 그린다.** bridge 분리는 유지되지만 Android 표준 modal 동작을 재구현해야 하고 Android 전용 UI를 웹에 둘 재사용 이점이 없어 기각했다.
- **native bottom sheet 안에 pairing WebView를 넣는다.** container 경계는 바로잡지만 Android 전용 표시 상태와 action routing을 JavaScript bridge에 계속 이중 표현하고, pairing과 Remote 문서가 같은 WebView를 재사용하는 권한 전환도 남으므로 선택하지 않았다.
- **Cloud dashboard DOM이 sheet를 렌더링한다.** 자연스러운 배경 합성은 가능하지만 Cloud script에 pairing action bridge를 노출해 ADR-0149의 권한 분리를 무너뜨리므로 허용하지 않는다.
- **pairing을 별도 full-screen native Activity로 연다.** 명확한 native 경계는 얻지만 방금 선택한 실제 Cloud dashboard를 배경 문맥으로 유지하는 짧은 전환 요구와 맞지 않아 bottom sheet를 택했다.

## Consequences

- sheet gesture, back, inset와 접근성 동작을 Material component가 제공하고 Android 전용 보안 UI의 소유권이 Kotlin으로 모인다.
- pairing bootstrap WebView 자산과 JavaScript interface가 사라져 공격·테스트 표면이 줄어든다. PC Remote UI는 계속 PC가 배포하므로 terminal 기능을 APK에 복제하지 않는다.
- native pairing view와 typed presentation 테스트를 새로 유지해야 하며 Material Components 의존성이 추가된다.
- Cloud WebView와 modal dialog가 동시에 존재하므로 dialog 표시/해제 전환마다 Cloud 입력·접근성·bridge gate를 검증해야 한다. dialog 밖 터치, swipe와 system back은 모두 Cloud 복귀를 정확히 한 번 실행해야 한다.
- 자동 검증은 layer policy, presentation 계산, pairing WebView/bridge 부재, native bottom-sheet layout/action 계약과 Android 빌드를 포함한다. 실기기에서는 drag, swipe dismiss, system/predictive back, TalkBack focus, QR→생체→Remote 전환을 확인한다.
- Material bottom sheet가 필요한 보안 modal 제약을 더 이상 제공하지 않거나 pairing UI가 실제로 다른 플랫폼과 공유되는 제품 요구가 생기면 결정을 재검토한다.
