# 0149. Android는 Cloud 계정 표면과 PC 소유 Remote UI를 분리하는 얇은 E2E wrapper다

- Status: Accepted
- Date: 2026-08-12
- Source: 사용자 요구("앱은 굉장히 얇은 wrapper", "laymux-server cloud는 철저히 중계만", "기존 클라우드 페이지를 WebView로", "내 Google 계정으로 로그인", "터미널은 사용자 PC에 설치된 Laymux가 제공") · laymux-server `ARCHITECTURE.md` §3~5 · [architecture/api-contracts.md §13](../architecture/api-contracts.md)
- Supersedes in part: [ADR-0144](0144-android-signed-hybrid-client-e2e-foundation.md)의 APK Remote UI 소유 결정, [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md)의 APK xterm/Kotlin Remote 도메인 상태 소유 결정
- Extends: [ADR-0024](0024-cloud-native-wss-tunnel.md), [ADR-0145](0145-android-pairing-authenticated-one-time-ack.md), [ADR-0146](0146-android-e2e-session-and-encrypted-remote-rpc.md)의 E2E session·transport 결정

## Context

원격으로 조작할 terminal과 그 기능의 신뢰 원천은 사용자의 PC에서 사용자 권한으로 실행 중인 Laymux다. Cloud relay는 사용자와 PC의 presence를 연결하고 ciphertext를 전달해야 하며 terminal UI, 명령, lease 또는 plaintext를 새로 소유해서는 안 된다. Android APK가 terminal 선택기와 xterm UI를 별도로 구현하면 PC와 권한·기능 해석이 갈리고, Remote 기능을 두 제품에서 계속 복제해야 한다.

동시에 앱은 익명 QR 도구가 아니다. 사용자는 기존 Laymux Cloud 계정으로 로그인해 자기 PC 목록과 online 상태를 보고 PC를 선택해야 한다. 기존 브라우저 Cloud의 landing/dashboard와 PC 등록·로그인 흐름도 유지해야 한다. 그러나 Google OAuth authorization endpoint를 embedded WebView에서 직접 여는 것은 Google 정책과 안전한 사용자-agent 경계에 맞지 않으며, Cloud가 제공한 JavaScript에 pairing seed나 E2E transport bridge를 노출하면 Cloud surface 침해가 terminal plaintext 침해로 확대된다.

따라서 세 표면의 소유권을 분리해야 한다. Cloud는 identity와 PC 목록을, Android native는 Google credential·QR·Keystore·생체 인증·E2E key를, 선택된 PC의 Laymux는 실제 Remote 문서와 terminal UX를 소유한다. 범위는 Android Cloud 로그인/선택, QR/ACK, 15분 비활성 E2E session, PC Remote resource/API/output transport다. iOS, background push, 다중 Android pairing, 범용 브라우저 E2E 전환과 향후 `앱 E2E만 허용` 설정은 비목표다.

## Decision

**Android는 기존 Cloud landing/dashboard를 전용 Cloud WebView에 표시하되 Google 인증과 PC 선택만 좁은 native bridge로 위임하고, QR·Keystore·생체 인증·E2E transport는 별도 native/secure WebView 경계에 두며, 실제 terminal UI는 선택된 PC Laymux의 `/remote/` 문서와 자산을 E2E로 받아 실행한다.**

- 앱은 서로 다른 두 WebView를 사용한다. Cloud WebView는 설정된 Laymux Cloud HTTPS origin 하나만 top-level navigation으로 허용하고 `LaymuxCloud.signInWithGoogle(nonce)`와 `LaymuxCloud.selectInstance(instanceId)`만 노출한다. Android app-mode 문서는 `frame-src 'none'`·`frame-ancestors 'none'` CSP와 `X-Frame-Options: DENY`를 적용해 all-frame JavaScript interface를 nested document가 호출하지 못하게 한다. 이 WebView에는 pairing metadata, QR, seed, session key, encrypted RPC 또는 Remote HTTP/output bridge를 노출하지 않는다.
- Cloud WebView의 entry는 public origin의 `/app/android`다. 서버는 기존 landing/dashboard template을 재사용하고 앱 모드의 online PC Connect 버튼만 instance UUID 선택 호출로 바꾼다. 기존 브라우저 `/login`, `/dashboard`, `/app/connect`와 데스크톱 Cloud pairing은 그대로 유지한다.
- Google 로그인은 WebView에서 OAuth authorization page를 열지 않는다. Android Credential Manager의 명시적 Sign in with Google flow가 server Web client ID를 audience로 하는 ID token을 발급받는다. Cloud가 anonymous signed session에 만든 32-byte base64url nonce를 credential 요청에 포함하고, native가 token을 JavaScript나 WebView/service worker에 반환하지 않은 채 별도 native HTTPS stack으로 같은 Cloud origin의 고정 form endpoint에 POST한다. native는 Cloud WebView의 anonymous HttpOnly session cookie를 request에 결합하고, 성공 응답의 bounded `Set-Cookie`와 고정 dashboard redirect만 받는다. cookie store의 비동기 설치 성공 callback과 flush가 끝나기 전에는 dashboard를 열지 않고 설치 거부는 실패 닫힘한다. Cloud는 Google 서명·issuer·audience·expiry와 session-bound single-use nonce를 검증한 뒤 기존 `laymux_session` HttpOnly cookie를 발급한다. body와 IP rate를 제한한다.
- Cloud dashboard가 넘긴 instance UUID는 연결 의도일 뿐 capability가 아니다. native는 저장된 confirmed pairing의 `instanceId`와 일치할 때만 생체 인증 후 session을 열고, pairing이 없거나 다른 PC면 QR scan을 요구한다. 스캔한 QR의 instance도 선택값과 정확히 같아야 저장·ACK할 수 있다. Cloud JavaScript는 seed나 proof를 읽지 못하며, 다른 instance ID만으로는 연결할 수 없다.
- pairing 관리 화면과 E2E Remote WebView는 APK local/synthetic origin만 사용하며 Cloud cookie를 공유하지 않는다. APK에는 xterm, terminal catalog, navigation 또는 controller UI를 포함하지 않는다. 명시적 disconnect와 15분 비활성 만료는 key를 폐기하고 Cloud dashboard로 돌아가며, pairing 자체는 유지한다.
- native는 confirmed seed로 challenge→establish를 수행해 방향별 AEAD key를 만들고 seed와 key를 JavaScript에 전달하지 않는다. foreground의 인증된 traffic은 15분 비활성 deadline을 갱신한다. background에서는 traffic과 갱신을 중지하지만 현재 deadline까지 key와 exact pending request를 보존하고, 15분 안에 돌아오면 같은 session을 재개한다.
- secure WebView main document는 Cloud relay URL에서 직접 실행하지 않는다. native가 app 전용 synthetic HTTPS origin 요청을 가로채 고정 public Android E2E RPC를 통해 PC Laymux의 resource를 가져오고 AEAD 검증 후 status·제한 header·body를 제공한다. PC의 동일 `page.html`은 wrapper mode에서 `remoteFetch`와 output socket만 native bridge로 바꾸며 terminal 선택·navigation·composer·lease 해석은 계속 PC 소유 코드가 담당한다.
- relay는 Cloud plane에서 Google account/session과 선택 가능한 instance presence를 알지만, E2E data plane에서는 outer instance/session/sequence, 크기와 timing만 본다. Remote UI bytes, terminal metadata·입출력, controller lease와 E2E key는 알거나 저장하지 않는다.
- 기존 browser Cloud/Direct Remote는 호환을 위해 기존 session/relay cookie와 평문 tunnel transport를 계속 사용한다. PC의 Cloud 로그인·등록도 제거하지 않는다. 향후 사용자가 browser Remote를 허용할지 Android E2E만 허용할지는 별도 설정 결정으로 남긴다.

## Alternatives Considered

- **APK에 terminal 선택기와 xterm UI를 구현한다.** relay 변조를 막을 수 있지만 PC가 이미 소유한 Remote 제품을 복제하고 기능·권한이 갈리므로 기각했다.
- **Cloud dashboard와 `/remote/`를 한 WebView에서 실행하고 하나의 native bridge를 둔다.** 구현은 작지만 Cloud script/XSS가 E2E bridge와 key 사용 oracle에 접근하므로 기각했다.
- **기존 `/login` Google OAuth를 embedded WebView에서 그대로 연다.** 기존 서버 변경은 적지만 embedded user-agent OAuth 정책과 사용자 신뢰 경계에 맞지 않아 기각했다.
- **Google 로그인 전체를 외부 browser와 app link callback으로 처리한다.** 안전하지만 app link/브라우저 왕복과 callback 배포가 더 크고, 명시적 앱 로그인에는 Credential Manager가 더 얇으므로 선택하지 않았다.
- **Cloud WebView에 ID token을 JavaScript로 돌려주거나 `postUrl`로 제출한다.** 전자는 bearer credential을 page JavaScript에 노출하고 후자는 same-origin service worker가 request body를 볼 수 있으므로, native HTTPS stack이 고정 endpoint에 제출하고 bounded cookie만 WebView store로 넘긴다.
- **인증된 뒤 Cloud `/remote/` HTML을 그대로 실행한다.** 전달된 script를 relay가 바꿀 수 있어 E2E plaintext가 노출될 수 있으므로 PC resource의 AEAD 검증 전 실행을 허용하지 않는다.
- **PC Cloud 로그인을 제거하고 QR만 사용한다.** 사용자의 기존 Cloud 등록 정책과 향후 browser 허용 선택을 없애며, PC presence를 계정에 귀속할 방법도 사라지므로 유지한다.

## Consequences

- APK 공용 표면은 Cloud WebView, local pairing 화면, native Google/QR/Keystore/biometric/E2E 계층, PC resource를 실행하는 secure WebView로 제한된다. Remote 기능 변경은 PC Laymux가 배포하며 APK가 terminal 기능을 복제하지 않는다.
- Cloud 서버에는 `/app/android`와 native Google token endpoint, app-mode dashboard 분기가 추가된다. production APK 빌드는 Cloud HTTPS origin과 server Web client ID를 주입해야 하며 Google Cloud Console에서 Android package/signing certificate 설정을 관리해야 한다.
- Cloud session cookie와 E2E pairing은 독립 수명이다. Cloud logout은 PC 목록 session을 끝내지만 pairing seed를 지우지 않고, E2E disconnect/expiry는 Cloud login을 지우지 않는다. 사용자가 pairing 삭제를 명시해야 seed가 폐기된다.
- 한 APK는 현재 pairing 하나만 저장한다. 다른 PC를 선택하면 그 PC의 QR을 새로 스캔해 기존 pairing을 교체한다. 다중 PC keyring은 별도 결정이 필요하다.
- 자동 검증은 Cloud origin/bridge input, nonce 단회성·Google token 검증·rate limit, app-mode template, 선택 PC와 QR instance 일치, resource allowlist·encrypted body, wrapper adapter, output framing, background/expiry를 포함한다. emulator/실기에서는 Credential Manager account chooser, HttpOnly cookie redirect, QR→biometric→PC page, terminal 입출력과 15분 background 복귀를 추가 검증해야 한다.
- 재검토 조건은 WebView에 key를 노출하지 않는 표준 secure transport가 생기거나, authenticated resource 지연이 허용 불가능하거나, 다중 PC/다중 Android session을 지원해야 할 때다.
