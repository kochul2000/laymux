# 0225. Android OAuth loopback listener는 redirect 주소 패밀리를 따른다

- Status: Accepted
- Date: 2026-09-01
- Source: 사용자 요구("저 oauth url 이 가르키는 루프백이 항상 저값이라는 보장은 있어? 그것도 고려해야하지 않니?") · PR #980 · [architecture/api-contracts.md §13.3.2](../architecture/api-contracts.md)
- 관계:
  - **Corrects** — [ADR-0175](0175-remote-oauth-loopback-relay.md)의 Android listener를 `127.0.0.1`로 고정한 조항만 주소 패밀리 선택 규칙으로 정정한다. 1회용 세션·TTL·lease·forward 계약은 유지한다.

## Context

Remote OAuth relay는 데스크톱 CLI가 auth URL의 `redirect_uri`에 넣은 loopback listener를 폰에서 대신 열고, 브라우저가 받은 callback을 인증된 Remote 채널로 PC에 돌려보낸다. ADR-0175는 데스크톱 `begin`에서 `localhost`, `127.0.0.1`, `[::1]`을 허용하고 literal 주소 패밀리를 forward까지 보존하지만, Android listener는 `127.0.0.1:{port}` 고정으로 서술했다.

실제 구현은 이 서술과도 달랐다. `InetAddress.getLoopbackAddress()`에 바인딩했는데 Android는 이 API에서 항상 IPv6 `::1`을 반환한다. 따라서 AWS OIDC처럼 `redirect_uri=http://127.0.0.1:{port}/...`를 발급하는 provider의 브라우저 callback은 IPv4로 향하고, IPv6에만 열린 listener에 도달하지 않는다. 반대로 listener를 IPv4로만 고정하면 `[::1]` redirect를 깨뜨린다. 특정 주소 패밀리를 모든 provider에 가정할 수 없다.

네이티브 bridge의 `port`, `expectedPath`, `authUrl`은 Remote 문서 입력이다. 데스크톱 `begin`이 먼저 같은 auth URL을 검증하더라도, Android가 전달값만 신뢰해 bind 주소를 선택하면 bridge 경계의 fail-closed 성질이 사라진다. 반면 host를 새 bridge 인자로 추가하면 PC가 제공하는 Remote 문서와 설치된 APK 사이의 호환 계약을 넓히고 구버전 APK 호출을 깨뜨릴 수 있다.

범위는 Android 네이티브 listener의 bind 주소 선택과 bridge 입력 재검증이다. 데스크톱 endpoint, lease, 1회용 session, TTL, callback path 검증, 앱 복귀 후 forward 순서는 비목표다.

## Decision

**Android 네이티브 relay는 기존 `authUrl`의 `redirect_uri`를 다시 파싱해 등록된 포트·경로와 일치하는 loopback host의 주소 패밀리에만 listener를 바인딩한다.**

- `authUrl`은 HTTPS, `redirect_uri`는 HTTP여야 한다.
- `redirect_uri`의 port와 encoded path는 Remote 문서가 전달한 `port`·`expectedPath`와 정확히 일치해야 한다.
- `localhost`와 `127.0.0.1`은 `127.0.0.1`, `[::1]`은 `::1`에 바인딩한다. 이는 데스크톱 `begin`의 `localhost`→IPv4 정규화와 같은 규칙이다.
- 그 밖의 host, 파싱 실패, scheme·port·path 불일치는 listener와 브라우저를 열기 전에 fail closed한다.
- 주소는 auth URL에서 네이티브가 도출한다. JavaScript bridge 인자를 추가하지 않고, `OauthLoopbackRelay`는 검증이 끝난 `InetAddress`만 받는다.
- listener의 loopback-only, 1회용, 절대 deadline 10분, exact callback path, 앱 복귀 후 forward 불변식은 ADR-0175를 그대로 따른다.

## Alternatives Considered

- **항상 `127.0.0.1`에 바인딩**: 제공된 AWS 사례는 고치지만 `[::1]` redirect를 깨고, 이미 데스크톱이 허용한 주소 패밀리 계약을 Android에서 축소한다. 기각.
- **`InetAddress.getLoopbackAddress()` 유지**: 코드가 가장 짧지만 Android에서 항상 `::1`이라 IPv4 literal redirect가 재현 가능하게 실패한다. 기각.
- **IPv4와 IPv6 listener를 항상 둘 다 열기**: `localhost` resolver 차이까지 흡수할 수 있다. 그러나 IP literal redirect는 이미 목적 패밀리를 명시하며, 두 socket의 bind 실패·수명·첫 callback 경쟁을 새로 조율해야 한다. 현재 계약은 `localhost`를 데스크톱과 동일하게 IPv4로 정규화하고 IPv6가 필요하면 `[::1]` literal을 사용하므로 추가 동시성 비용을 들이지 않는다.
- **Remote 문서가 redirect host를 별도 bridge 인자로 전달**: 파싱을 줄이지만 PC-served 문서와 APK의 bridge 계약을 바꾸고, 네이티브가 untrusted host를 다시 검증해야 하므로 실제 검증 비용도 없어지지 않는다. 기존 `authUrl`을 네이티브에서 파싱하는 쪽을 선택한다.

## Consequences

- `127.0.0.1`을 사용하는 AWS OIDC와 `[::1]`을 사용하는 IPv6 flow가 각자 같은 주소 패밀리의 폰 listener에 도달한다.
- `localhost`는 기존 데스크톱 규칙과 같이 IPv4로 정규화된다. IPv6-only provider는 `[::1]` literal을 명시해야 한다.
- 네이티브가 auth URL과 port/path를 다시 결속하므로 수정이 임의 local host·port로 향하는 bridge나 SSRF primitive를 만들지 않는다.
- 이미 설치된 OkHttp URL parser를 재사용하며 새 의존성·설정·마이그레이션은 없다.
- JVM 테스트는 AWS 형태 IPv4, `localhost`, IPv6 literal, port/path 불일치와 non-loopback 거부를 고정한다. Android 전체 unit suite와 debug APK build로 bridge 호출부까지 컴파일 검증한다.

