# 0154. Android pairing vault는 instance별 레코드와 정책별 공유 wrapping key를 사용한다

- Status: Accepted
- Date: 2026-08-13
- Source: 사용자 요구(GitHub issue #806: "Android APK 다중 PC 페어링 저장 지원") · [architecture/api-contracts.md §13.0](../architecture/api-contracts.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)
- Amends: [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)의 단일 Android pairing 범위와 consequence
- Extends: [ADR-0145](0145-android-pairing-authenticated-one-time-ack.md), [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md)

## Context

Cloud dashboard는 한 계정의 여러 PC를 보여 주지만 Android vault는 pairing envelope 하나만 저장했다. 다른 PC를 스캔하면 기존 seed가 덮어써져, 이미 확인한 PC로 돌아갈 때도 QR을 다시 발급하고 스캔해야 했다. Cloud instance 선택은 capability가 아니므로 다중 저장을 추가하더라도 선택한 PC와 다른 seed를 자동 사용해서는 안 된다.

Pairing seed는 계속 Android Keystore 비추출 키로 감싸야 한다. PC마다 wrapping key를 만들면 alias 수명과 생체 등록 변경 처리가 불필요하게 복잡해지고, 반대로 모든 pairing을 하나의 JSON blob에 넣으면 한 PC의 갱신·삭제가 전체 레코드의 원자적 재작성과 secret 재포장을 요구한다. 표시 목록은 생체 인증이나 seed 복호화 없이 읽을 수 있어야 하며 보호 정책 변경은 서로 다른 정책으로 감싼 레코드가 공존하지 않도록 해야 한다.

현재 내부 개발 단계의 저장소에는 migration 의무가 없다. 이전 singleton 레코드를 보존하려고 읽기·쓰기 양쪽 계약을 유지하는 것보다 새 저장 버전을 명확히 시작하고 다시 pairing하게 하는 편이 작은 공격 표면과 결정적인 상태를 제공한다.

범위는 Android APK의 pairing 저장·선택·목록·개별 삭제와 E2E session seed 선택이다. Cloud 계정의 PC 목록 소유권, desktop pairing record 수, 한 Android pairing당 단일 활성 E2E session, QR/ACK 암호 계약은 바꾸지 않는다.

## Decision

**Android는 `instanceId`별 독립 pairing envelope를 저장하고 보호 정책별 wrapping key 하나를 모든 envelope가 공유하며, Cloud에서 선택한 instance와 정확히 일치하는 confirmed 레코드만 E2E session에 사용한다.**

- SharedPreferences key는 `pairing:<instanceId>`이고 value는 비밀 metadata와 AES-256-GCM ciphertext를 포함하는 storage version 4 envelope다. `instanceId`는 기존 canonical identifier 검증을 통과해야 하며 key suffix와 envelope metadata가 다르면 손상으로 거부한다.
- `loadMetadata()`는 모든 활성 레코드의 비밀 아닌 metadata 목록을 instance ID 순으로 반환한다. metadata 열거는 wrapping key 초기화·생체 인증·seed 복호화를 수행하지 않는다. 만료된 pending 레코드는 해당 instance만 삭제한다.
- 저장은 같은 instance의 레코드만 교체한다. ACK confirm·무효화와 복호화도 instance ID와 기존 pairing ID·client nonce를 함께 확인하여 다른 PC의 레코드를 변경하지 않는다.
- wrapping key alias는 `biometric`과 `keystoreOnly` 보호 정책별 하나씩만 유지한다. 개별 pairing 삭제는 envelope만 삭제하고 공유 alias를 보존한다. 보호 정책 변경은 모든 envelope와 두 alias를 삭제한 다음 새 정책을 저장하며 모든 PC에 재pairing을 요구한다.
- Cloud dashboard의 선택은 연결 의도일 뿐이다. native는 선택 instance와 같은 confirmed envelope만 자동 선택한다. confirmed 레코드가 없으면 그 PC의 QR을 요구하며, 기존 pending 레코드의 ACK 재시도는 pairing manager의 명시적 동작으로만 제공한다. 선택 변경 시 다른 PC의 열린 native session은 먼저 닫는다.
- pairing manager는 전체 metadata 목록과 각 레코드의 confirmed/pending 상태를 표시하고 instance별 확인 재시도·키 보호 확인·삭제를 제공한다. secret과 client nonce는 JavaScript 상태에 넣지 않는다.
- APK pairing manager 문서와 PC 제공 Remote 문서는 같은 WebView를 재사용하되 navigation 전에 JavaScript interface를 교체한다. pairing manager에만 vault 관리 interface를 주고, Remote 문서에는 E2E HTTP/output transport와 현재 session disconnect만 노출한다. native pairing 상태 callback도 pairing manager surface에서만 실행한다.
- storage version을 4로 올리고 이전 `pairing` singleton key는 읽거나 migration하지 않고 앱의 새 vault 초기화 시 폐기한다.

## Alternatives Considered

- **PC를 바꿀 때 기존 singleton을 계속 교체한다.** 저장 구조는 단순하지만 이미 확인한 PC마다 QR 재스캔이 반복되어 Cloud 다중 PC dashboard와 맞지 않으므로 기각했다.
- **모든 PC envelope를 하나의 JSON 배열에 저장한다.** 목록 snapshot은 쉽지만 한 레코드 변경이 전체 blob을 재작성하고 부분 손상·경쟁의 범위를 모든 PC로 넓히므로 기각했다.
- **instance마다 별도 Keystore alias를 만든다.** 한 PC의 키 폐기는 명확하지만 생체 등록 변경과 보호 정책 전환에서 alias 열거·정리 상태가 늘어난다. 같은 앱·같은 보호 정책 경계 안에서는 envelope별 고유 GCM IV와 인증 태그로 분리가 충분하므로 선택하지 않았다.
- **기존 version 3 singleton을 첫 instance 레코드로 migration한다.** 재스캔을 줄이지만 내부 개발 단계에서 일회성 parser와 실패 복구 계약을 장기 보유해야 하며 명시된 migration 불필요 정책과 어긋나므로 기각했다.
- **Cloud가 마지막 선택 instance를 pairing SoT로 저장한다.** Cloud script가 native secret을 얻지는 않더라도 local key 선택 권한이 넓어진다. 선택은 일회 연결 의도로만 받고 실제 레코드·확정 상태는 native vault가 판정하도록 유지한다.

## Consequences

- 사용자는 여러 PC를 한 번씩 pairing한 뒤 Cloud dashboard 선택만으로 해당 PC의 confirmed seed를 재사용할 수 있다. 한 PC의 재스캔·만료·삭제가 다른 PC pairing을 보존한다.
- 모든 envelope가 정책별 alias를 공유하므로 생체 등록 변경 또는 alias 손상은 그 정책의 모든 pairing 사용에 영향을 준다. 화면은 레코드별 오류처럼 위장하지 않고 보호 정책 경계의 재pairing 필요를 알린다.
- 보호 정책 변경은 PC 수와 무관하게 전체 삭제다. UI 경고와 테스트는 단일 pairing이 아니라 모든 저장 pairing이 사라짐을 명시해야 한다.
- version 3 singleton 사용자는 업데이트 뒤 기존 pairing을 다시 스캔해야 한다. 자동 migration이나 fallback read는 제공하지 않는다.
- 자동 검증은 다중 저장·대상 instance 복호화·대상만 confirm/삭제·다른 레코드 보존·정책 변경 전체 삭제·legacy singleton 폐기와 dashboard 선택 일치를 포함한다.
- Cloud 계정에서 같은 PC를 가리키는 canonical instance ID가 바뀌는 정책이 생기거나 한 Android 앱에서 보호 정책을 PC별로 달리해야 할 요구가 생기면 이 결정을 재검토한다.
