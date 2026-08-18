# 0176. Dev 전용 Android 페어링 payload 주입 — 카메라 없는 에뮬레이터 페어링

- Status: Proposed
- Date: 2026-08-18
- Source: 사용자 요구("dev 에서 pairing 은 할 수 있게 dev 전용으로는 qr 키 확보 가능하게 laymux dev mcp 풀어줘야 할거 같은데") · [ADR-0144](0144-android-signed-hybrid-client-e2e-foundation.md)
- Extends: ADR-0144(페어링 기반), MCP dev 툴 2계층 분리

## Context

Android 페어링은 데스크톱이 QR(`laymux://pair/v2?...&secret=...`)을 화면에 그리고 폰이 Google Code Scanner 로 스캔하는 경로뿐이다. payload 텍스트는 어떤 API 에도 노출되지 않고(시크릿 보호), 앱 입력은 카메라 스캔뿐이다. 그 결과 에뮬레이터에서는 페어링을 완주할 수 없고, E2E 세션이 필요한 기능(ADR-0175 OAuth 릴레이의 네이티브 경로 등)은 실기 검증이 늘 "미룸"으로 남았다(ADR-0144/0145/0146/0149 의 검증 절).

## Decision

**dev 빌드에 한해 payload 를 꺼내는 MCP 툴과, debug 앱에 한해 스캔 없이 payload 를 주입하는 딥링크를 연다.**

- 데스크톱: dev 전용 MCP 툴 `create_android_pairing_payload` — 기존 `create` 와 동일한 페어링 세션을 만들고 QR payload 텍스트를 함께 반환한다. 뒷받침 함수 `android_pairing::create_with_payload` 는 `cfg!(debug_assertions)` 가 아니면 즉시 거부하므로 release 에서는 툴이 목록에 안 보일 뿐 아니라 호출 경로 자체가 막힌다. 기존 `AndroidPairingQr` 직렬화에 시크릿이 새지 않는 계약은 그대로다(테스트로 고정).
- 앱: debug manifest 오버레이에만 `laymux://pair` VIEW intent-filter 를 추가하고, MainActivity 는 `FLAG_DEBUGGABLE` 재확인 후 payload 를 **스캐너 성공 콜백과 동일한 검증·저장 경로**(`PairingPayload.parse` → instance 일치 → vault 저장 → ack)로 넘긴다. 진입 가드(busy/보호정책/생체 가용성)도 스캔과 동일한 `preparePairingPolicy()` 를 공유한다.
- 사용법: `adb shell am start -a android.intent.action.VIEW --activity-single-top -d "<payload>"`.

## Alternatives Considered

- **에뮬레이터 가상 카메라에 QR 이미지 주입**: 가능하지만 취약(포커스·해상도·Play 서비스 UI 자동화), CI 부적합. 기각.
- **release 에도 수동 payload 입력 UI**: 시크릿을 클립보드/화면 텍스트로 노출하는 정식 경로가 됨. 기각 — 정식 경로는 QR 스캔 유지.
- **테스트 전용 별도 앱 flavor**: 유지비 대비 이득 없음. debug 오버레이로 충분.

## Consequences

- 에뮬레이터에서 dev 데스크톱과의 페어링·E2E 세션·Remote 문서 구동을 자동화할 수 있다 — ADR-0144 계열이 미뤄온 실기 검증이 가능해진다.
- 시크릿 노출 면적: dev MCP(로컬 automation 포트, dev 인스턴스 한정) 호출자에게 payload 가 텍스트로 나간다. 그 호출자는 이미 dev 머신의 터미널 제어권을 가진 주체다. release 바이너리에는 코드 게이트로 존재하지 않는다.
- 딥링크는 debug 빌드에서만 manifest 에 존재하고, 코드도 FLAG_DEBUGGABLE 을 재확인한다.
