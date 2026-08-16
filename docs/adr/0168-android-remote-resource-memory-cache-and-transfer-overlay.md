# 0168. Android는 Cache-Control 을 존중하는 메모리 전용 원격 자원 캐시와 전송 진행 오버레이를 둔다

- Status: Proposed
- Date: 2026-08-16
- Source: 사용자 요구("보안 세션 여는 중이 너무 오래 걸린다 — 오가는 것을 보여주고, 두 번째 연결은 캐싱으로 빨라야 한다") · [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md) · [ADR-0077](0077-remote-terminal-font-serving.md)
- Extends: ADR-0146, ADR-0149

## Context

E2E handshake 자체는 8 KiB 이하 POST 두 번이지만, 세션이 열린 직후 WebView가 PC 소유 Remote 문서를 적재하면서 main document·vendor script·CSS·터미널 폰트가 전부 암호화 resource RPC로 relay를 거쳐 들어온다. 세션은 한 번에 하나의 요청만 in-flight 로 허용하므로(ADR-0146) 자원 전송은 직렬이고, 폰트는 MB 단위다. 그동안 화면에는 교체 전 문서(페어링 페이지의 "보안 세션 여는 중…")가 그대로 남아 있어 사용자는 어떤 진행도 볼 수 없다.

또한 secure WebView는 `cacheMode = LOAD_NO_CACHE` 이고 앱 계층 캐시도 없어서 재연결마다 같은 바이트를 다시 받는다. WebView HTTP 캐시는 디스크 영속이라 복호화된 E2E 자원을 담기에 부적절해 꺼둔 것이므로, 재연결 속도는 다른 계층에서 해결해야 한다. 범위는 Android 앱 내부 UX·캐시 계층이며, RPC wire 계약·desktop route·relay 는 바꾸지 않는다. 조건부 요청(ETag)·디스크 캐시·vendor 자산의 캐시 정책 변경은 비목표다.

## Decision

**Android는 (1) Remote 문서 적재 동안 전송 상태(수신 개수·바이트·현재 파일·캐시 적중)를 표시하는 네이티브 오버레이를 띄우고, (2) desktop 이 `Cache-Control: max-age` 로 명시적으로 캐시를 허용한 resource RPC 응답만 프로세스 메모리에만 보관하는 인스턴스 단위 LRU 캐시로 재연결 전송을 줄인다.**

- 오버레이는 WebView 문서가 아닌 네이티브 뷰다. 문서 교체 중의 진행 표시는 이전 문서의 JS 에 의존할 수 없고, Remote 문서 자체는 PC 소유(ADR-0149)라 APK 가 주입하지 않는다. Remote 표면 진입 시 표시하고 main document `onPageFinished` 또는 표면 이탈 시 감춘다. 전송 카운터는 UI 스레드가 소유한다.
- 캐시는 opt-in 이다. 응답 status 200 이고 `Cache-Control` 에 `max-age>0` 이 있으며 `no-store`/`no-cache` 가 없을 때만 저장한다. 헤더가 없는 자원(vendor script 등)은 브라우저식 휴리스틱 없이 캐시하지 않는다 — desktop 업데이트로 언제든 바뀔 수 있고 신선도 신호가 없기 때문이다. 실질 대상은 콘텐츠 해시 URL 폰트(`max-age=31536000, immutable`, ADR-0077)와 PWA 아이콘(`max-age=86400`)이다.
- 캐시는 AEAD 검증을 통과한 평문만 담고, 메모리 전용이며 디스크에 절대 쓰지 않는다. 프로세스 종료로 소멸하고, 키는 `instanceId + path` 로 인스턴스에 격리하며, 해당 pairing 해제 시 그 인스턴스 항목을 즉시 비운다. 총량은 상한(기본 16 MiB)으로 묶고 초과 시 LRU 를 축출한다. TTL 은 max-age 를 따르되 1년으로 상한한다.
- 세션·연결 실패·백그라운드 전환은 캐시를 비우지 않는다 — 재연결을 빠르게 하는 것이 목적이며, 자원 평문은 세션 키와 달리 세션 수명에 묶일 이유가 없다(같은 pairing 이 다시 받을 수 있는 공개 정도의 데이터다).

## Alternatives Considered

- **WebView HTTP 캐시(`LOAD_DEFAULT`) 재활성화.** 구현이 가장 짧지만 복호화된 E2E 자원이 디스크 캐시에 영속된다. 메모리 전용 원칙과 충돌해 기각.
- **모든 자원을 세션 수명 동안 캐시.** vendor script·main document 까지 커버하지만 desktop 업데이트 직후 stale UI 와 신선한 API 가 섞이는 위험이 있고, 신선도 신호 없는 자원의 TTL 을 앱이 임의로 정하게 된다. desktop 이 명시한 정책만 따르는 쪽을 택했다.
- **ETag 조건부 resource RPC 추가.** 모든 자원을 안전하게 재검증할 수 있지만 RPC plaintext 계약과 desktop route 확장이 필요하다. 폰트가 전송량을 지배하므로 계약 변경 없는 opt-in 캐시로 충분하고, 측정 후에도 느리면 후속 ADR 대상.
- **진행 표시를 페어링 페이지 JS 로 전달.** 문서 교체 중 이전 문서의 수명이 보장되지 않고 `loadUrl` 이후 `evaluateJavascript` 대상이 모호하다. 네이티브 오버레이가 문서 상태와 무관하게 동작한다.

## Consequences

- 두 번째 연결부터 폰트·아이콘 바이트가 relay 를 다시 건너지 않아 재연결이 빨라지고, 첫 연결도 무엇이 오가는지 보인다. main document·vendor script 는 계속 매번 전송된다 — 남은 지연이 문제로 측정되면 vendor 자산에 desktop 이 캐시 정책을 명시하는 변경(콘텐츠 해시 URL 또는 조건부 RPC)을 별도 ADR 로 결정한다.
- 복호화된 자원 평문이 프로세스 메모리에 세션보다 오래(최대 앱 수명) 남는다. 폰트·아이콘 수준의 데이터라 수용하고, 디스크 영속·인스턴스 간 공유는 계속 금지한다.
- desktop 이 이미 보내는 `Cache-Control` 이 실질 계약이 된다 — 새 자원에 max-age 를 붙이면 Android 캐시 대상이 되므로, 캐시되면 안 되는 자원은 지금처럼 `no-store` 또는 무헤더를 유지해야 한다.
- 검증: 캐시 TTL 파싱·opt-in 규칙·LRU·인스턴스 격리·만료는 JVM 단위 테스트로 고정한다. 오버레이 표시·해제와 실기기 체감은 emulator/실기기 수동 확인 대상이다.
