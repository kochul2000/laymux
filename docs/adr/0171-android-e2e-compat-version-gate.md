# 0171. Android E2E 는 비호환 시에만 올리는 호환 번호로 연결을 게이트한다

- Status: Proposed
- Date: 2026-08-17
- Source: 사용자 요구("버전이 안 맞다고 표시해라, 비호환일 때만 하나씩 올리는 버저닝") · 실사고(구 APK + 신 데스크톱의 폰트 gzip 비호환으로 "접속하자마자 꺼짐") · [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md) · [ADR-0169](0169-remote-client-hashed-immutable-assets-and-gzip.md)
- Extends: ADR-0146

## Context

desktop 과 Android 앱은 같은 릴리즈로 함께 배포되는 하나의 계약이지만(ADR-0169), 실제로는 한쪽만 업데이트된 조합이 생긴다. 그 조합의 실패는 원인 없이 보이는 증상(자원 해제 실패 → 세션 종료 → 대시보드 튕김)으로 나타나 사용자가 디버깅할 수 없었다. 릴리즈 버전(semver)은 호환 여부를 말해주지 않는다 — 대부분의 릴리즈는 호환이고, 가끔의 계약 변경만 비호환이다.

## Decision

**desktop 과 앱은 공유 호환 번호(compat version) 하나를 갖고, 비호환 변경이 실릴 때만 1씩 올리며(릴리즈마다 아님), challenge 응답으로 광고해 앱이 자기 번호와 다르면 방향에 맞는 안내("PC를 업데이트하세요" / "앱을 업데이트하세요")로 연결을 거부한다. 시작 값은 1 — 이 게이트 도입 자체가 첫 비호환 변경이다.**

- 정본 상수 두 곳: desktop `android_e2e/mod.rs::COMPAT_VERSION`, 앱 `E2eProtocol.COMPAT_VERSION`. 비호환 변경 PR 은 두 값을 같이 올린다.
- 전달: challenge 응답의 `compatVersion` 필드. HMAC proof 에 넣지 않는 표시 전용 필드다 — 위조 효과는 "버전 불일치 오류로 연결 거부"뿐이라 relay 가 이미 가진 연결 거부 능력을 넘지 않는다. proof 에 넣으면 proof 프레이밍 자체가 비호환 변경이 되는 순환이 생긴다.
- 앱은 strict 응답 검증에서 이 필드만 optional 로 둔다(그 밖의 미지 필드는 계속 fail closed). 필드 부재(0)는 버저닝 도입 전 desktop = PC 구버전으로 안내한다.
- 게이트는 handshake 의 challenge 단계에서 작동한다 — 세션·키가 만들어지기 전, 사용자에게 보이는 첫 실패 지점에서 명확한 원인을 준다.
- 무엇이 비호환인가: 한쪽만 배포됐을 때 연결·자원·출력이 조용히 깨지는 모든 변경(wire 스키마, 인코딩, 상한, 필수 필드). UI·성능·신규 optional 필드는 호환이다.

## Alternatives Considered

- **릴리즈 버전 문자열 비교.** 모든 릴리즈가 불일치가 되어 호환 릴리즈끼리도 강제 동시 업데이트를 요구한다. 호환 번호는 비호환일 때만 움직인다.
- **compatVersion 을 proof 에 포함.** 필드를 인증하지만 proof 프레이밍 변경 자체가 비호환 변경이라 도입 시점의 닭-달걀이 생기고, 얻는 것은 relay 의 기존 DoS 능력과 동일한 위협의 방어뿐이다.
- **challenge 요청에 앱 버전 포함(데스크톱이 판정).** desktop 요청 스키마가 `deny_unknown_fields` 라 구 desktop 이 신 앱 요청을 거부한다 — 신 앱 + 구 desktop 조합이 더 나쁘게 깨진다. 응답 방향은 앱이 lenient 하게 만들 수 있다.
- **버저닝 없이 그때그때 오류 메시지 개선.** 실패 지점이 변경마다 달라(폰트, 자산, 출력) 일반화가 안 된다.

## Consequences

- 앞으로의 비호환 배포는 "PC/앱을 업데이트하세요" 한 줄로 자가 진단된다.
- 이 게이트가 실린 릴리즈와 그 이전 조합: 구 앱 + 신 desktop 은 게이트 이전 앱이라 기존 strict 검증의 일반 오류("보안 응답 필드가 올바르지 않습니다")로 실패한다 — 소급 불가, 수용한다. 신 앱 + 구 desktop 은 "PC 구버전" 안내를 받는다.
- 비호환 변경 시 두 상수를 같이 올리는 규율이 필요하다. 리뷰에서 wire 계약 변경 PR 에 compat bump 유무를 확인한다.
- 검증: 앱 단위 테스트가 부재(구 desktop)→PC 안내, 더 큰 값→앱 안내, 일치→통과를 고정한다.
