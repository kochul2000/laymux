# 0162. Android Remote의 터미널 링크는 native bridge를 통해 OS 브라우저로 연다

- Status: Proposed
- Date: 2026-08-16
- Source: 사용자 요구("현재 remote 에서는 url 이 클릭되면 브라우저 바로 여는 동작이 없니?") · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md) · [architecture/api-contracts.md §13](../architecture/api-contracts.md)
- Extends: [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)

## Context

PC가 소유한 `page.html`은 터미널의 OSC 8 hyperlink, 평문 URL, `#123` 이슈 토큰을 하나의 `openRemoteUrl(uri)`로 모아 `window.open(url.href, "_blank", "noopener,noreferrer")`으로 연다. 데스크톱 Tauri UI는 같은 지점을 OS 기본 브라우저로 보내고, 브라우저에서 Remote를 열면 새 탭이 뜬다.

Android wrapper는 같은 문서를 secure WebView에서 실행하지만 그 WebView는 `setSupportMultipleWindows(false)`와 `javaScriptCanOpenWindowsAutomatically = false`이며 `WebChromeClient.onCreateWindow`를 구현하지 않는다. 또한 `LocalContentWebViewClient`는 APK local origin과 AEAD resource용 synthetic origin 외의 모든 top-level navigation을 거부한다. 따라서 앱에서 링크를 탭하면 새 창도 뜨지 않고 같은 문서 navigation도 차단되어 아무 일도 일어나지 않는다. 사용자에게는 "Remote에서 링크가 죽어 있다"로 보인다.

WebView 정책을 완화해 링크를 열 수는 없다. 다중 창을 켜면 relay가 볼 수 없는 secure 문서 옆에 통제되지 않은 WebView 창이 생기고, navigation allowlist를 넓히면 임의 웹 페이지가 E2E bridge를 가진 origin 경계 안에서 실행된다. 링크 URL 자체도 터미널 출력이 만든 비신뢰 문자열이므로 어떤 경로로든 그대로 신뢰해서는 안 된다.

범위는 Android wrapper에서 Remote 터미널 링크를 여는 방법이다. 데스크톱·브라우저 Remote의 기존 동작 변경, 앱 내 웹 브라우징 UI, Custom Tabs 도입, 파일/디렉터리 링크와 pairing 표면의 링크는 비목표다.

## Decision

**Android wrapper에서 Remote 문서는 링크를 스스로 열지 않고, scheme을 검증한 URL을 좁은 native bridge 메서드 하나로 넘긴다. native가 URL을 다시 검증한 뒤 `Intent.ACTION_VIEW`로 OS 브라우저를 시작한다.**

- `openRemoteUrl`은 `http`/`https` 검사를 먼저 수행한 뒤, `androidE2eMode`일 때만 `window.LaymuxNative.openExternalUrl(url.href)`를 호출하고 반환한다. 다른 모든 표면은 기존 `window.open(..., "noopener,noreferrer")` 경로를 그대로 쓴다. bridge 메서드가 없는 구버전 APK에서는 호출을 생략해 기존 무동작을 유지하며, Remote 문서를 링크 URL로 navigate시키는 fallback은 만들지 않는다.
- `openExternalUrl(url)`은 PC 제공 Remote 문서에 설치되는 `RemoteBridge`에만 존재한다. pairing manager의 `NativeBridge`에는 노출하지 않으며, 이 메서드는 pairing metadata·seed·session key·transport 상태를 읽거나 바꾸지 않는다.
- native는 WebView의 검사를 신뢰하지 않고 `ExternalUrlPolicy`로 다시 판정한다. 절대 URI, opaque 아님, scheme이 `http` 또는 `https`, host 비어 있지 않음, userinfo 없음을 모두 만족해야 한다. scheme만 소문자로 정규화하고 나머지 문자열은 터미널이 만든 그대로 둔다. 판정에 실패하면 조용히 무시한다.
- Intent는 `ACTION_VIEW` + `CATEGORY_BROWSABLE` + `FLAG_ACTIVITY_NEW_TASK`로 만들고, 현재 local surface가 Remote일 때만 시작한다. 처리할 activity가 없으면 toast로 알리고 실패 닫힘한다. 앱은 `http`/`https` intent filter를 선언하지 않으므로 링크가 앱 자신으로 되돌아오지 않는다.
- 열린 페이지는 별도 앱의 별도 task다. Remote session, lease, E2E key는 영향을 받지 않으며 앱이 background로 가면 기존 background lease grace 규칙([ADR-0155](0155-android-background-remote-lease-grace.md))이 그대로 적용된다.

## Alternatives Considered

- **secure WebView에 `setSupportMultipleWindows(true)`와 `onCreateWindow`를 켠다.** 코드 변경은 작지만 E2E 문서 옆에 통제되지 않은 WebView 창을 만들고, 열린 페이지가 앱 프로세스 안에서 실행되므로 기각했다.
- **navigation allowlist를 넓혀 링크를 같은 WebView에서 연다.** 임의 웹 콘텐츠가 secure surface를 대체하고 뒤로 가기 상태가 Remote 문서와 섞이므로 기각했다.
- **Custom Tabs를 사용한다.** UX는 더 매끄럽지만 의존성과 서비스 바인딩이 늘고, 사용자의 기본 브라우저 선택을 존중하는 `ACTION_VIEW`로도 요구를 충족하므로 지금은 선택하지 않았다. 앱 내 브라우징 UX가 필요해지면 재검토한다.
- **URL 검증을 WebView JavaScript에만 맡긴다.** 링크 문자열은 터미널 출력이 만들고 bridge는 프로세스 경계를 넘으므로, native가 `intent:`·`file:`·`content:` 같은 scheme을 스스로 거부하도록 두 번 검증한다.
- **native가 항상 chooser(`createChooser`)를 띄운다.** 매 링크마다 선택을 요구해 일상 사용이 번거롭고, 기본 브라우저 설정을 무시하므로 기각했다.

## Consequences

- Android에서 터미널 링크·OSC 8 hyperlink·`#123` 이슈 참조가 데스크톱·브라우저 Remote와 같은 대상을 연다. 표면별 동작 차이는 "새 탭" 대 "OS 브라우저"뿐이다.
- APK의 JavaScript 노출 표면이 메서드 하나 늘어난다. 이 메서드는 `http`/`https` URL을 사용자 기본 브라우저에 넘기는 것 외의 권한을 갖지 않으며, bridge surface 테스트가 Remote/pairing 각각의 허용 메서드 집합을 고정한다.
- PC의 `page.html`과 APK는 독립 배포된다. 새 PC + 구버전 APK는 링크가 계속 열리지 않고, 구버전 PC + 새 APK는 bridge 메서드가 호출되지 않는다. 두 조합 모두 기존 동작으로 안전하게 축퇴한다.
- 자동 검증은 URL 정책 단위 테스트, bridge surface 테스트, `page.html` 자산 문자열 테스트, Remote 문서를 Android wrapper 모드로 구동해 링크 탭이 bridge를 호출하고 새 탭을 만들지 않음을 확인하는 e2e다. 실기 검증은 실제 브라우저 실행과 복귀 후 session 유지다.
- 재검토 조건은 앱 내 브라우징(Custom Tabs)이 필요해지거나, Remote가 파일·디렉터리처럼 브라우저 대상이 아닌 링크 종류를 Android에서 열어야 할 때다.
