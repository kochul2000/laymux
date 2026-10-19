# 0344. 원격 알림은 Cloud 구독으로 브라우저와 Android 시스템에 전달한다

- Status: Proposed
- Date: 2026-10-19
- Source: 사용자 요구(웹·앱 휴대전화 시스템 알림, 합의한 설계의 ADR·구현 PR 요청), architecture/data-flow.md 알림 시스템, architecture/api-contracts.md §13, ADR-0019·0250·0146·0149·0183·0209
- 관계: ADR-0019의 원격 알림 소비를 백그라운드 전달로 확장한다. ADR-0146·0149의 E2E 키 및 WebView 경계는 유지한다. ADR-0183 및 Cloud architecture의 service worker 금지에는 아래의 좁은 푸시 전용 예외를 추가한다.

## Context

PC 프론트엔드가 알림과 읽음의 정본이고 Remote는 목록을 조회한다. Android는 background에서 원격 통신을 중지하고 생체 인증으로 보호한 E2E 키를 만료시킨다. polling이나 WebSocket만으로는 잠금화면 알림을 제공할 수 없다. PC 활성 workspace의 알림은 도착 즉시 읽음이 될 수 있어 unread 목록만 전달해서도 안 된다.

범위는 CLI/OSC·작업 전이 알림의 Web Push·FCM 전달, 기기/PC별 종류·상세 표시 선택, 중복 방지, 읽음 연동과 인증 후 대상 이동이다. PC 종료 중 새 작업 관측, 정시·완전한 푸시 배달은 보장하지 않는다. provider 계정·키와 배포는 운영 설정이다.

## Decision

**PC가 만든 알림의 식별자와 전이를 Cloud가 구독별로 중계하고, 브라우저의 푸시 전용 service worker와 Android native가 시스템 알림을 표시한다.**

- **정본.** 본문·대상·읽음은 기존 PC notification store가 소유한다. 알림 ID는 UUID다. 새 생성은 PC 도착 시점 자동 읽음과 독립적으로 한 번 전달하며 이후 사용자 읽음·삭제를 별도 전달한다. 기존 목록은 구독 시작 때 재발행하지 않는다. 전송 실패는 PC 알림·PTY를 막지 않는다.
- **발행.** PC는 기존 Cloud device credential로 고정 HTTPS endpoint에 발행한다. 서버가 credential로 instance·현재 소유자를 결정한다. 이벤트에는 UUID·종류·생성/읽음 전이와 revision을 넣고 늦은 생성이 읽음을 되돌리지 못하게 한다. 구독·중복 방지 상태는 DB에 저장한다. 수·크기·동시성·재시도·보존 기간은 유한하며 전달은 best effort다.
- **권한.** 구독은 명시적 사용자 동작으로 만든다. 웹은 현재 relay credential의 PC·소유자에, Android는 Cloud 로그인과 현재 소유 PC에 결합한다. 변경에는 same-origin 검증과 body 제한을 적용한다. 구독 endpoint/token은 다른 기기·계정에 노출하지 않는다. PC 등록 해제·소유권 변경·구독 취소 뒤에는 발송하지 않고 폐기된 provider token은 지운다. Web Push 목적지는 알려진 provider의 HTTPS origin으로 제한해 SSRF를 막는다.
- **웹.** relay origin의 고정 `/remote/push/sw.js`를 `/remote/push/` scope로 등록한다. worker에는 fetch listener·offline cache를 두지 않고 push·notificationclick만 처리한다. public 로그인 origin에는 worker를 설치하지 않는다. Cloud는 이 경로를 tunnel보다 먼저 제공하고 scope 확대를 허용하지 않는다. CSP·Caddy에 이 스크립트에 필요한 예외를 둔다. iOS는 지원 OS의 홈 화면 웹앱에서 사용자 gesture로 권한을 요청한다. Direct HTTP는 미지원 이유와 Cloud 경로를 안내한다.
- **Android.** FCM·알림 권한·channel·PendingIntent는 native가 소유한다. Cloud bridge에는 수신 설정 action만 추가하고 secure Remote에는 FCM token·Cloud cookie·pairing seed를 노출하지 않는다. provider 미설정 빌드도 빌드되며 수신 불가 이유를 표시한다. 토큰 회전 때 등록을 갱신한다.
- **내용.** 기본 푸시는 일반 안내와 비밀이 아닌 instance/notification 식별자만 가진다. 본문·경로·workspace 이름은 기본으로 Cloud/provider에 보내지 않는다. 상세 표시를 켠 구독에만 본문을 전달하고 Cloud/provider에 내용이 공개됨을 설명한다. E2E 키를 생체 인증 없이 꺼내지 않는다.
- **소비.** 클릭은 고정 Cloud 연결 경로에서 현재 소유권·인증을 재확인하고 기존 lease 획득 뒤 PC의 알림 ID를 찾아 기존 대상 이동·읽음 동작을 실행한다. ID는 인증을 대체하지 않는다. 삭제·offline·인증 실패는 안내와 정상 재연결 경로를 유지한다. 읽음 전이는 같은 tag를 닫고 권한 요청이나 소리를 만들지 않는다. Android OS의 background 제한에 따른 지연은 foreground 재동기화로 보완한다.
- **선택.** 입력/승인 요청·실패·완료·일반을 기기/PC 구독별로 선택한다. 앱·브라우저는 별도 구독이며 물리 기기를 추측하지 않고 수신 경로를 사용자가 선택한다.

## Alternatives Considered

- polling/WebSocket 유지: 잠금과 OS 프로세스 정지 때 전달되지 않고 Android 전력 정책과 충돌한다.
- Web Push만 사용: Android WebView/native background 수신을 같은 방식으로 지원할 수 없다.
- 기존 E2E session으로 상세 푸시 복호화: 만료·생체 인증 정책에 어긋난다.
- public origin 전체의 service worker: 로그인/native bridge 문서를 지속적으로 가로챌 수 있다.
- unread 목록의 반복 발송: 도착 자동 읽음 때문에 새 알림이 빠지고 재접속 때 과거 알림이 재발행된다.

## Consequences

웹과 앱에 같은 알림 의미를 제공하며 PC 정본과 E2E 수명을 유지한다. 선택 기능 추가이므로 버전 영향은 minor다. 대응 Cloud PR과 함께 배포한다. 키 미설정·권한 거절은 기존 원격 기능을 방해하지 않는다.

비용은 Cloud 영속 저장과 provider 운영 설정, PC 순서 보존 발행, 좁은 CSP 예외, Android 의존성·권한·토큰 회전이다. OS는 배달과 읽음 반영의 즉시성을 보장하지 않는다. 테스트는 계정 격리·CSRF/SSRF·중복/역순·취소·토큰 만료·본문 비공개·대상 이동·provider 장애를 검증한다. UI는 dev API/스크린샷으로, 실제 provider 배달은 자격 증명이 있을 때 실기기로 검증한다. living doc과 Cloud 운영 문서를 갱신한다.
