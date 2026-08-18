# 0179. Android 연결 설정은 Cloud 대시보드의 PC 메뉴에서 진입한다

- Status: Accepted
- Date: 2026-08-18
- Source: 사용자 요구("연결설정은 대시보드에서 ... 으로 별도 진입") · [ADR-0178](0178-android-pairing-native-material-bottom-sheet.md) · [architecture/api-contracts.md §13](../architecture/api-contracts.md)
- Amends: [ADR-0178](0178-android-pairing-native-material-bottom-sheet.md)의 bottom sheet 내 연결 설정 진입 결정

## Context

ADR-0178은 Android 전용 pairing UI를 표준 Material bottom sheet로 옮기면서, 주요 연결 action 아래에 명시적인 연결 설정 진입 행과 접힌 설정 내용을 두었다. 플랫폼 소유권은 바로잡았지만 보안 session을 여는 짧은 작업과 저장된 pairing·키 보호 정책을 관리하는 장기 설정이 한 modal 안에 남았다. 사용자는 연결하려고 연 sheet에서 추가 메뉴의 존재를 발견해야 했고, 설정을 펼치면 핵심 action과 dismiss 위치도 움직였다.

Cloud Android dashboard에는 이미 각 PC 카드마다 `…` 작업 메뉴가 있다. 연결 설정은 특정 PC를 대상으로 하므로 이 메뉴가 더 자연스러운 진입점이지만, Cloud WebView에는 pairing metadata나 키 권한을 넘길 수 없다. 서버와 APK가 독립 배포되므로 새 bridge capability가 없는 구버전 APK도 무동작 메뉴를 노출하지 않아야 한다.

범위는 Android app-mode dashboard의 설정 진입 계약, pairing bottom sheet의 정보 구조, native 설정 modal의 책임이다. 브라우저/PWA dashboard, pairing protocol, vault schema, 키 보호 정책의 의미와 PC Remote UI는 바꾸지 않는다.

## Decision

**Android pairing bottom sheet는 선택한 PC의 연결 실행만 담당하고, 연결 설정은 Cloud dashboard PC 카드의 `…` 메뉴에서 별도 native Material dialog로 연다.**

- pairing bottom sheet에는 현재 상태, 보안 session 열기·취소, QR scan/재pairing과 dismiss만 둔다. 저장된 PC 목록, pairing 확인·삭제, 생체 보호 switch와 접기/펼치기 UI는 두지 않는다.
- Cloud server는 Android app-mode의 각 PC `…` 메뉴에만 `연결 설정`을 렌더링한다. 일반 browser/PWA dashboard에는 이 action을 렌더링하지 않는다.
- Android app-mode JavaScript는 canonical instance UUID 하나만 `LaymuxCloud.openConnectionSettings(instanceId)`로 전달한다. native는 기존 UUID validation과 현재 Cloud foreground gate를 통과한 호출만 처리하며 pairing metadata·secret·정책 상태를 Cloud JavaScript에 반환하지 않는다.
- APK는 해당 instance의 비밀이 아닌 vault metadata와 전역 키 보호 정책을 typed state로 계산해 별도 native Material alert dialog에 표시한다. pending ACK 재시도, 키 보호 확인, 개별 pairing 삭제와 생체 보호 정책 변경은 Kotlin callback에 직접 연결한다.
- 설정 dialog 동안 실제 dashboard WebView는 배경에 유지하되 입력·focus·접근성 descendants와 Cloud/Remote bridge를 모두 비활성화한다. system back, 바깥 터치와 `닫기`는 dialog를 닫고 기존 dashboard를 다시 활성화한다.
- 생체 보호 문제로 pairing이 차단된 경우의 `보호 설정 열기`는 같은 별도 설정 dialog로 직접 이동하는 복구 경로다. 설정 내용을 pairing sheet 안에 다시 중첩하지 않는다.
- server가 새 APK보다 먼저 배포되면 JavaScript는 `openConnectionSettings` capability가 없는 WebView에서 메뉴 항목을 숨긴다. 새 APK와 구버전 server 조합에서는 기존 pairing 차단 복구 경로를 유지하며, dashboard 메뉴는 server 배포 뒤 나타난다.

## Alternatives Considered

- **bottom sheet 안의 명시적 연결 설정 행을 유지한다.** 추가 bridge가 필요 없지만 연결 실행과 관리가 계속 섞이고 설정을 펼칠 때 sheet 구조가 크게 변해 선택하지 않았다.
- **dashboard의 `…` 메뉴에서 웹 설정 페이지로 이동한다.** 서버만으로 구현할 수 있지만 vault metadata와 Keystore/생체 작업을 Cloud에 노출하거나 별도 왕복 계약으로 복제해야 하므로 허용하지 않았다.
- **대시보드 상단에 전역 연결 설정 버튼을 둔다.** 생체 정책은 전역이지만 pairing 확인·삭제는 PC별이라 대상 맥락이 사라지고 카드 메뉴와 중복돼 선택하지 않았다.
- **새 Android Activity로 설정을 연다.** 독립 navigation은 명확하지만 현재 Activity가 소유한 biometric prompt, pending ACK와 vault 작업을 activity 간 계약으로 옮겨야 한다. 현재 범위에서는 별도 Material dialog가 같은 책임 분리와 표준 back 동작을 더 작은 수명 경계로 제공한다.

## Consequences

- pairing sheet가 짧고 예측 가능한 연결 action 표면이 되며, 연결 설정의 발견 위치가 PC 카드 작업 메뉴로 고정된다.
- Cloud bridge에 instance UUID만 받는 새 메서드가 추가되지만 권한은 native에 남고 Cloud 문맥으로 민감 상태가 역전파되지 않는다.
- 서버 템플릿/JavaScript와 APK를 함께 검증해야 하며 독립 배포 순서에 capability fallback을 유지해야 한다.
- native 설정 dialog의 instance별 상태와 전역 보호 정책이 함께 보이므로, 보호 정책 변경 시 모든 pairing이 삭제된다는 기존 확인 dialog와 안내를 계속 유지한다.
- layer policy, bridge surface, server Android-only 렌더링, settings presentation과 pairing sheet의 설정 부재를 회귀 테스트로 고정한다.
- 연결 설정이 여러 하위 화면을 요구할 만큼 커지거나 Android navigation stack에 영속 가능한 설정 목적지가 필요해지면 별도 Activity/Fragment 전환을 재검토한다.
