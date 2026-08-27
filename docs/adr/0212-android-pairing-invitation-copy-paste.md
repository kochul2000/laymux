# 0212. Android 페어링 초대는 QR과 명시적 복사·붙여넣기를 함께 제공한다

- Status: Accepted
- Date: 2026-08-27
- Source: 사용자 요구("QR 값 복사·붙여넣기로 QR이 안 되는 상황도 지원") · [ADR-0145](0145-android-pairing-authenticated-one-time-ack.md) · [ADR-0178](0178-android-pairing-native-material-bottom-sheet.md) · [architecture/api-contracts.md §13](../architecture/api-contracts.md)
- Extends: ADR-0145, ADR-0178
- Corrects: ADR-0176의 release UI payload 비노출 범위. dev MCP·debug deep-link 제한은 유지한다.

## Context

기존 Android 페어링은 데스크톱이 5분짜리 `laymux://pair/v2` bearer secret을 QR로만 표시하고 앱은 Google Code Scanner로만 받았다. 카메라를 사용할 수 없거나 Google Play scanner가 준비되지 않은 기기, 원격 데스크톱·화면 공유처럼 QR을 같은 기기로 보고 있는 환경에서는 유효한 초대가 있어도 페어링할 수 없다. QR 이미지가 인코딩하는 값과 ACK·E2E key 계약에는 카메라 자체가 보안 근거로 들어가지 않으므로, 이를 해결하기 위해 별도 인증 프로토콜을 만들 이유는 없다.

반면 payload에는 32바이트 seed가 들어 있다. 자동 클립보드 읽기, 화면 텍스트 표시, 상태 조회 재노출, 로그 기록은 초대의 노출 면적과 수명을 불필요하게 넓힌다. 복사·붙여넣기는 사용자가 명시적으로 선택한 순간에만 작동하고 기존 5분 만료·first-winner·instance binding을 그대로 통과해야 한다.

범위는 데스크톱 Remote Access 모달의 초대 복사와 Android native pairing sheet의 붙여넣기다. Cloud/Remote WebView bridge, ACK wire schema, seed 저장 형식, QR 형식과 session key schedule은 비목표다.

## Decision

**하나의 5분짜리 `laymux://pair/v2` 초대를 QR과 명시적 복사·붙여넣기 두 입력 표면으로 제공하고, 두 경로를 동일한 Android 검증·저장·ACK 파이프라인에 수렴시킨다.**

- 데스크톱 `create_android_pairing_qr` 응답은 `status`, `qrSvg`와 함께 `pairingPayload`를 반환한다. payload는 생성 응답에만 있고 status·revoke 응답이나 설정에는 추가하지 않는다.
- Remote Access 모달은 payload를 DOM 텍스트·접근성 이름·로그에 넣지 않는다. pending 초대에 대한 사용자의 `페어링 값 복사` 동작만 system clipboard에 기록한다. 새 발급·폐기 요청을 시작한 즉시 이전 QR SVG와 payload를 숨기며, 확인·만료 또는 모달 unmount 뒤에도 더 이상 복사할 수 없다.
- Rust 응답 객체는 payload를 zeroizing storage에 두고 직렬화 뒤 폐기하며 `Debug`는 QR과 payload를 redaction한다. IPC를 지난 JavaScript 문자열과 system clipboard는 zeroize할 수 없다는 잔여 위험을 인정한다.
- Android native pairing sheet는 `페어링 값 붙여넣기` action을 제공한다. action을 누른 때만 첫 clipboard item을 text로 읽고 양끝 공백을 제거한다. 빈 값은 거부하고 4 KiB를 넘는 값은 URI 파싱 전에 거부한다.
- 붙여넣은 값은 QR scanner 결과와 같은 `PairingPayload.parse` → 선택 instance exact match → 보호 정책/Keystore 저장 → authenticated ACK 경로를 사용한다. Cloud WebView나 secure Remote WebView에는 payload를 전달하지 않는다.
- 앱은 clipboard를 자동 감시·읽기·삭제하지 않는다. 사용자가 다른 용도로 복사한 값을 앱이 덮어쓰거나 지우지 않으며 OS clipboard history/동기화 정책은 플랫폼 소유다.
- QR과 붙여넣기는 동일한 300초 만료, first valid client nonce winner, HMAC proof, 새 발급 시 key rotation 정책을 공유한다. 입력 경로는 보안 수준이나 protocol version을 바꾸지 않는다.

## Alternatives Considered

- **짧은 숫자 코드를 별도로 발급한다.** 입력은 쉽지만 code를 seed에 안전하게 교환할 새 relay 계약, online guessing 제한과 추가 상태가 필요하다. 이미 충분한 entropy와 만료를 가진 URI를 안전한 clipboard로 전달하는 현재 문제보다 범위가 크다.
- **QR screenshot·이미지 가져오기를 지원한다.** 일부 카메라 문제는 해결하지만 같은 기기 화면, scanner module 부재와 접근성 문제는 남고 이미지 선택 권한과 decoder를 추가한다.
- **Android에 payload 텍스트 필드를 항상 표시한다.** 사용자가 직접 수정할 수 있지만 긴 bearer secret을 화면·접근성 tree와 편집 상태에 더 오래 남긴다. 명시적 clipboard action이면 필요한 복사·붙여넣기 흐름을 더 좁게 제공한다.
- **dev deep-link 주입을 release에도 연다.** 외부 앱이 intent를 보내는 새 exported 진입점이 되고 일반 사용자 흐름과 lifecycle이 분리된다. native sheet의 foreground action으로 한정한다.

## Consequences

- 카메라·Google Code Scanner가 없어도 PC에서 복사한 초대를 Android에 붙여넣어 페어링할 수 있다. QR과 수동 경로의 protocol·테스트 벡터는 갈라지지 않는다.
- 사용자가 복사한 동안 system clipboard와 OS clipboard history/기기간 동기화에 bearer secret이 존재할 수 있다. UI는 이 사실을 명시하고, 5분 만료·새 발급 회전·first-winner가 노출 시간을 제한한다. 더 짧은 TTL이나 clipboard 민감도 API 적용은 실제 플랫폼 지원과 사용성 자료가 생기면 재검토한다.
- production Tauri IPC가 payload를 프론트엔드에 전달하므로 trusted desktop WebView 경계가 seed를 잠시 포함한다. CSP 없는 임의 remote content를 이 WebView에 적재하지 않는 기존 desktop 신뢰 모델이 전제다.
- 자동 검증은 Rust serialized response/redacted debug, React의 명시적 clipboard write와 DOM 비노출, Android native action 존재, 4 KiB 입력 상한과 기존 parser/instance/ACK 테스트를 포함한다. 실제 기기에서는 PC→Android clipboard 전송, 빈 clipboard, 만료·다른 PC 값, 생체 인증 전환을 확인한다.
