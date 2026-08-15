# 0158. Android E2E 터미널 출력은 스트림별 AEAD WebSocket으로 전송한다

- Status: Accepted
- Date: 2026-08-15
- Source: 사용자 요구("두 개가 되도록 동일", "암호계층은 별도", "1번 방식으로 구현") · [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md) · [architecture/api-contracts.md §13](../architecture/api-contracts.md)
- Supersedes in part: [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md)의 `terminalOutputOpen`/`terminalOutputPoll`, 120ms 고정 지연 polling, terminal output의 단일 RPC in-flight 직렬화 결정. Pairing, session handshake, control/resource RPC, session inactivity deadline 결정은 유지한다.
- Supersedes in part: [ADR-0150](0150-desktop-owned-cloud-remote-access-policy.md)의 `androidE2eOnly`에서 모든 WebSocket을 거부하는 allowlist 결정. 일반 Remote WebSocket은 계속 거부하고 fixed encrypted output WebSocket 하나만 추가한다.

## Context

브라우저 PWA는 terminal output을 실제 WebSocket의 JSON text header와 binary body 쌍으로 즉시 받는다. Android E2E wrapper는 같은 PC 소유 Remote UI를 실행하지만, native가 `terminalOutputOpen`과 `terminalOutputPoll`을 AEAD RPC로 호출하고 120ms 고정 지연마다 다음 출력을 확인한 뒤 JSON/base64를 `evaluateJavascript`로 넘겼다. 따라서 유휴 시간에도 polling 비용이 발생하고, 활성 출력은 최대 한 poll 주기만큼 늦으며, 큰 snapshot과 delta가 AEAD·base64·JSON·JavaScript 문자열 계층을 중복 통과했다.

Android가 일반 Remote WebSocket을 WebView에서 직접 열면 성능은 좋아지지만 session key 또는 복호화된 네트워크 권한이 JavaScript 계층으로 올라간다. 반대로 relay가 기존 terminal output header를 해석한 뒤 필드별로 암호화하면 browser와 Android가 서로 다른 application protocol을 계속 소유하게 된다. 요구 범위는 terminal output transport이며 control/resource RPC와 pairing UI는 바꾸지 않는다.

## Decision

**Android E2E terminal output은 browser와 동일한 Remote v1 text-header/binary-body 계약을 사용하되, Android native와 desktop Rust 사이의 장기 WebSocket에 스트림별 AEAD record layer를 두고 relay와 WebView bridge는 application payload를 해석하지 않는다.**

- Relay public origin은 cookie가 필요 없는 고정 WSS `/api/android/e2e/output`만 추가한다. query는 정확히 `instanceId`, `sessionId`, `streamNonce` 세 필드이며 relay는 이를 고정 desktop path `/remote/v1/e2e/output`으로 전달한다. 임의 path/header/query 전달을 허용하지 않고 기존 IP·instance rate limit과 proxy concurrency limit을 적용한다.
- Relay는 encrypted binary record를 양방향으로 그대로 전달한다. terminal id, lease id, Remote v1 header, snapshot/delta bytes는 보지 못한다. relay가 관찰 가능한 값은 routing metadata, 연결·record 시각과 ciphertext 크기, close/error 상태다.
- Android는 output 연결마다 OS CSPRNG 32-byte `streamNonce`를 만들고 desktop은 한 E2E session에서 같은 canonical nonce를 한 번만 허용한다. 기존 session의 a2d/d2a key에서 HKDF-SHA-256으로 stream별 directional key를 파생한다. salt는 output domain과 instance/session/stream nonce의 length-prefix framing을 SHA-256한 값이고 info는 방향별 output domain이다.
- encrypted record는 `version:u8 || sequence:u64-be || AES-256-GCM(ciphertext||tag)`다. 방향별 sequence는 0부터 정확히 증가하며 기존 JSON-safe 상한을 유지한다. GCM nonce는 `0x00000000 || sequence`이고 AAD는 방향 domain, version, instance id, session id, stream nonce, sequence를 인증한다. 첫 a2d plaintext record는 type `OPEN`과 `{terminalId,leaseId}`이며 이후 d2a plaintext record는 type `TEXT` 또는 `BINARY`와 Remote v1 frame bytes다.
- Desktop은 encrypted `OPEN`을 복호화한 뒤에만 lease와 terminal을 확인하고 render checkpoint를 attach한다. 그 뒤 browser WebSocket과 같은 `TerminalOutputFrameHeaderV1` text record와 exact binary record를 보낸다. reconnect는 새 stream nonce와 새 snapshot으로 시작한다. terminal/lease 내부 오류는 relay에 상세 내용을 공개하지 않고 연결을 닫는다.
- Android native가 OkHttp WebSocket, stream key, sequence, AEAD를 소유한다. session key와 ciphertext는 WebView에 전달하지 않는다. WebView에는 exact local Remote origin으로 제한한 `WebViewCompat.addWebMessageListener`를 설치하고 `JavaScriptReplyProxy.postMessage(ByteArray)`로 origin-aware ArrayBuffer만 전달한다. `WEB_MESSAGE_LISTENER`와 `WEB_MESSAGE_ARRAY_BUFFER`가 없으면 output bridge를 노출하지 않고 fail closed한다.
- WebView adapter는 복호화된 TEXT/BINARY를 표준 WebSocket 모양의 `onmessage`로 바꿀 뿐 Remote header와 terminal 상태를 별도로 정의하지 않는다. output bytes에는 JSON/base64와 `evaluateJavascript`를 사용하지 않는다.
- Native bridge는 2 MiB bounded queue와 한 record in-flight ACK를 사용한다. TEXT header는 parser가 수락한 뒤, BINARY body는 대응하는 xterm write promise가 끝난 뒤 ACK한다. AEAD와 network callback은 UI thread 밖에서 실행한다.
- `terminalOutputOpen`과 `terminalOutputPoll`은 encrypted RPC union에서 제거한다. session status/claim/heartbeat/release, navigation, terminal input/resize, resource는 기존 sequential AEAD RPC를 유지한다.

## Alternatives Considered

- **120ms AEAD polling을 유지하거나 간격만 줄인다.** 지연을 줄이면 request·AEAD·JSON 비용과 배터리 사용이 증가하고, 늘리면 체감 지연이 악화된다. browser와 transport가 계속 달라지므로 기각한다.
- **WebView가 WSS와 WebCrypto를 직접 소유한다.** 구현은 단순하지만 session/stream key와 network authority가 PC 제공 JavaScript 계층으로 이동해 ADR-0149의 native key boundary를 깨므로 기각한다.
- **Android local loopback WebSocket을 열고 WebView가 접속한다.** WebSocket API 호환은 좋지만 별도 local server, port lifecycle, origin/auth, background 정책이 생기며 AndroidX binary message bridge로 같은 계약을 더 좁은 권한으로 제공할 수 있어 기각한다.
- **기존 relay terminal-output metadata를 유지하고 header/data를 각각 암호화한다.** relay와 Android 전용 application framing이 Remote v1 위에 중복되고 browser와 Android의 계약이 다시 갈라지므로 기각한다.

## Consequences

- 활성 출력은 120ms polling floor와 output의 base64/JSON/`evaluateJavascript` 복사를 제거한다. Android native↔WebView 경계와 AEAD 비용은 남으므로 Chrome PWA와 완전히 같은 엔진 경로는 아니지만, transport 지연 모델과 Remote parser는 같아진다.
- 배포는 relay가 fixed public WSS를 지원하고 desktop이 encrypted output path를 지원한 뒤 Android를 배포하는 순서를 따른다. 구버전 Android는 기존 RPC를 호출하지만 새 desktop은 이를 거부하므로 이 개발 단계에서는 마이그레이션이나 polling fallback을 만들지 않는다.
- `laymux`와 `laymux-server`가 같은 wire contract를 함께 구현해야 한다. 두 저장소의 테스트는 exact query/path, opaque binary forwarding, key direction/nonce binding, nonce reuse rejection, Remote page binary ACK를 각각 고정한다.
- WebView feature 미지원 기기는 control UI를 열 수 있어도 terminal output 연결은 실패한다. 보안 경계를 낮추는 JS interface/base64 fallback은 제공하지 않는다.
- queue가 2 MiB를 넘거나 ACK가 진행되지 않으면 연결을 닫고 기존 Remote reconnect/snapshot 경로로 복구한다. sustained output에서 이 상한이 반복적으로 부족하다는 측정이 나오면 record batching 또는 credit 크기를 별도 결정으로 재검토한다.
