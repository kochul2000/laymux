# 0049. Git drop-in 플러그인은 신뢰된 self-contained HTML에 read-only hook API를 제공한다

- Status: Deferred (2026-07-24 — v1 render-only 가치 대비 신뢰 모델·hook protocol 고정 비용이 큼. 재검토 조건: 외부 플러그인 수요 발생 또는 Tauri multi-webview 안정화)
- Date: 2026-07-23
- Source: 사용자 요구, issue #464, [overview.md §6](../architecture/overview.md), [ADR-0001](0001-osc-rust-single-pass.md), [ADR-0003](0003-cwd-single-source-syncgroup.md), [ADR-0004](0004-settings-vs-ui-state-separation.md)
- Extends: [ADR-0003](0003-cwd-single-source-syncgroup.md)의 “새 View는 SyncGroup CWD를 구독한다”는 소비자 계약

## Context

현재 View 목록과 `ViewType`은 built-in으로 닫혀 있다. 새 View를 추가하려면 Rust 설정,
프론트 타입·renderer·picker를 함께 수정하고 laymux를 다시 빌드해야 한다. issue #464는
공용 hook으로 호출되고, Git checkout을 디렉터리에 추가하는 것만으로 등록되며, 외부
서버 없이 HTML로 그릴 수 있고, PWD(CWD) 전파를 hook 입력으로 받을 수 있는 플러그인
경계를 요구한다.

이 경계에는 서로 다른 force가 있다.

- Git에서 받은 HTML/JavaScript는 코드다. manifest·경로·호환성 오류가 다른
  플러그인이나 앱 시작을 깨뜨려서는 안 된다.
- CWD의 SoT는 ADR-0003의 Rust `TerminalSession.cwd`이며, OSC 파싱과 전파 판정은
  ADR-0001의 Rust 단일 패스를 벗어나면 안 된다. 플러그인이 별도 셸이나 두 번째 group
  CWD를 만들면 기존 가드와 경로 변환 정책이 갈라진다.
- 메인 WebView 안의 iframe은 강한 권한 경계가 아니다. 특히 Tauri는 Linux에서 embedded
  iframe의 IPC 요청과 상위 window의 요청을 구분할 수 없다고 명시한다
  ([Tauri capabilities](https://v2.tauri.app/security/capabilities/)). 따라서 sandbox/CSP만으로
  임의 Git 코드를 “무권한”으로 실행한다고 약속할 수 없다.
- iframe 내부 입력은 부모 React document로 버블되지 않아 pane focus와 중앙
  keybinding을 우회한다. opaque-origin iframe은 현재 html2canvas screenshot에도 자동으로
  합성되지 않는다.
- Windows와 Linux에서 같은 package·경로·실패 계약이 필요하며, release와 dev 설치는
  기존 config root처럼 분리돼야 한다.

v1 범위는 로컬 plugin 발견·검증, 한 개의 render-only View, versioned host-to-plugin
hook API, CWD 수신, 진단과 자율 검증이다. 공식 plugin API를 통한 plugin-to-host action,
사용자 입력, native/sidecar 실행, 파일시스템·클립보드·Automation/MCP 호출, Remote UI 투영,
marketplace·서명·자동 update, plugin별 설정·영속 상태, 기존 OSC/ActivityHandler 교체는
비목표다.

## Decision

**laymux v1 플러그인은 사용자가 메인 frontend와 동급으로 신뢰해 config root에 checkout한
디렉터리이며, Rust가 검증한 self-contained HTML을 generic `PluginView`의 opaque sandbox
iframe에서 render-only로 실행하고 UI host가 versioned read-only hook API를 제공한다.
CWD는 기존 `TerminalSession.cwd` snapshot과 gate를 통과한 SyncGroup 전파 event의
read-only projection이다.**

### Package와 registry

플러그인 설치의 SoT는 `settings.json` 목록이 아니라 다음 direct-child 디렉터리다.

```text
Windows  %APPDATA%/laymux[-dev]/plugins/<plugin-id>/
Linux   ~/.config/laymux[-dev]/plugins/<plugin-id>/
  laymux-plugin.json
  dist/index.html
  .git/                    # 선택 사항; runtime은 읽거나 실행하지 않음
  README.md                # 선택 사항
```

- Git은 배포 수단일 뿐 runtime protocol이 아니다. 사용자는 repository를 위 위치에
  checkout/copy하며 laymux는 v1에서 clone, pull, submodule, hook, package install, build
  script를 실행하지 않는다. checkout 결과에 실행용 산출물이 이미 포함돼야 한다.
- 앱 시작과 명시적 `reload`에서 direct child를 전체 scan하고, 검증된 manifest와 entry
  bytes를 immutable snapshot으로 만든 뒤 catalog를 한 revision으로 교체한다. `reload`는
  checkout/pull 완료 뒤 호출하는 계약이다. 두 번의 metadata/content hash 확인 사이에
  파일이 바뀌면 **reload 전체를 실패**시키고 직전 catalog를 유지한다. 안정적으로 읽힌
  invalid/missing/conflict package는 새 catalog에 진단 상태로 반영하고 실행 가능한
  contribution에서는 제거한다. laymux 밖에서 동시에 수행한 Git update 자체의 원자성은
  보장하지 않는다. 안정적으로 재현되는 ID 충돌은 중간 변경 실패가 아니므로 이전
  executable snapshot을 유지하지 않는다.
- package directory와 manifest의 `id`는 일치해야 한다. ID는 소문자 ASCII의 점으로
  구분된 namespace이며 Windows/Linux의 case 차이와 무관하게 유일해야 한다. 중복 ID는
  first/last wins로 고르지 않고 충돌한 package를 모두 catalog에서 제외한다.
- Rust plugin domain이 JSON schema, UTF-8, manifest/entry 크기 상한, API 호환성,
  canonical containment를 검증한다. 절대 경로, `..`, plugin root를 벗어나는 symlink,
  non-file entry는 거부한다. 한 package의 실패는 다른 package catalog를 막지 않는다.
- catalog와 진단의 SoT는 Rust이며 frontend store는 revision, plugin별 content digest가
  붙은 비영속 projection만 가진다. reload에서 digest가 바뀌면 해당 visible runtime을
  폐기하고 새 generation으로 remount한다. valid→invalid/missing/conflict 전이는 runtime을
  폐기하고 placeholder로, 다시 valid가 되면 remount로 원자 전환한다. 이를 참조하는 pane
  config는 지우거나 `EmptyView`로 고치지 않는다.

manifest v1의 최소 계약은 다음과 같다.

```json
{
  "manifestVersion": 1,
  "apiVersion": 1,
  "id": "example.cwd-dashboard",
  "name": "CWD Dashboard",
  "version": "1.0.0",
  "entry": "dist/index.html",
  "locations": ["workspace", "dock"],
  "hooks": ["cwd.changed", "theme.changed", "view.focus-changed"]
}
```

`entry`는 단일 UTF-8 HTML document다. runtime에 필요한 JavaScript/CSS/font/image는
inline 또는 `data:`/runtime-generated `blob:`으로 포함하고 상대 asset, custom protocol,
HTTP server, CDN을 요구하지 않는다. `manifestVersion`은 directory schema, `apiVersion`은
hook protocol의 major version이며 host가 지원하지 않는 값은 fail closed한다.

### View identity와 lifecycle

동적 문자열을 `ViewType`으로 열지 않고 built-in wrapper 하나만 추가한다.

```json
{
  "type": "PluginView",
  "pluginId": "example.cwd-dashboard",
  "syncGroup": "",
  "cwdReceive": true
}
```

- `pluginId`는 catalog contribution을, 안정 `paneId`는 runtime instance를 식별한다.
  effective group은 `viewConfig.syncGroup || workspaceId || ""`이다. 따라서 workspace의
  기본 group은 workspace ID이고 dock은 explicit group 없이는 CWD가 없으며, custom group은
  workspace를 넘을 수 있다. CWD 관점의 valid effective group은 빈 문자열과 `"none"`이
  아닌 값이며 `"none"`은 CWD hook을 끈다. effective `cwdReceive`는 pane override가 있으면
  그 값, 없으면 해당 workspace/dock의 `syncCwdDefaults.receive`다.
- pane/workspace/dock/layout round-trip은 위 config를 그대로 보존한다. manifest의 이름,
  entry 경로, hook 목록을 pane config에 복제하지 않는다.
- 현재 lazy-mounted workspace/dock 정책과 달리 plugin runtime은 **visible surface에서만**
  존재한다. workspace가 비활성화되거나 dock/pane이 숨으면 best-effort unmount를 보낸 뒤
  iframe을 폐기하고, 다시 보이면 새 generation으로 mount하면서 최신 snapshot을 준다.
  plugin DOM·timer·메모리 상태는 휘발하며 background hook을 받지 않는다.
- v1 iframe은 `inert`, `tabIndex=-1`, `pointer-events:none`인 render-only surface다. 클릭은
  pane wrapper에 도달한다. host는 `document.activeElement === iframe`인 focus 탈취를
  감지하면 현재 pane wrapper로 즉시 복구하고 반복 위반 시 runtime fault로 teardown한다.
  이 경로를 WebView2·WebKitGTK에서 검증해 parent keybinding 경로를 보존한다. interactive
  control과 child-to-host action은 새 focus/action/key-routing 결정을 거친 뒤에만 추가한다.

### HTML runtime과 신뢰 경계

Rust가 읽은 entry를 frontend host가 `srcdoc`으로 만들고, plugin document보다 먼저 고정
bootstrap과 완화할 수 없는 CSP를 삽입한다.

- iframe sandbox는 `allow-scripts`만 허용한다. `allow-same-origin`, top navigation,
  popup, form, download, modal 권한은 주지 않고 `referrerPolicy="no-referrer"`와 빈
  permission policy를 적용한다.
- CSP는 `default-src 'none'`, `connect-src 'none'`, `frame-src 'none'`,
  `worker-src 'none'`, `object-src 'none'`, `form-action 'none'`, `base-uri 'none'`을
  기본으로 하고 inline script/style과 `data:`/필요한 `blob:` image/font만 연다.
  `unsafe-eval`은 허용하지 않는다.
- host DOM, Tauri API, filesystem, process, clipboard, network credential을 plugin SDK로
  노출하지 않는다. parent는 bootstrap 때 확인한 `contentWindow`에 전용 `MessagePort`를
  한 번 전달하고 이후 전역 `message`를 protocol transport로 쓰지 않는다.
- entry의 explicit navigation/new-window 시도는 protocol 위반이다. host는 initial
  `about:srcdoc` 이외 navigation을 허용하지 않고 감지 즉시 instance를 teardown한다.
  CSP가 차단하는 subresource/connect 채널은 WebView2·WebKitGTK에서 외부 request가 0건인지
  smoke test로 고정한다. 다만 악성 trusted code가 navigation 요청 자체나 Tauri IPC를
  시작할 수 없다는 강한 격리는 아래 신뢰 모델의 보장 범위가 아니다.
- 그러나 이 제한은 defense in depth와 offline package contract이지 적대적 코드에 대한
  강한 권한 격리가 아니다. config root에 package를 설치하는 행위는 해당 Git 코드를
  **메인 frontend와 동급으로 완전히 신뢰한다는 grant**다. `read-only`는 지원하는 hook
  API의 방향일 뿐 security capability가 아니다. 특히 현재 Linux iframe 구분 한계와 app
  command 등록 방식에서는 plugin이 ambient Tauri IPC를 구성해 settings/file/terminal 등
  host mutation을 시도할 기술적 가능성이 남는다. 이는 contract 위반이지만 sandbox가
  차단한다고 주장하지 않는다. 향후 untrusted marketplace가 필요하면 별도-label WebView와
  command ACL을 재설계하거나 script-free 선언형 renderer를 채택하는 새 ADR이 필요하다.
- uncaught error, rejected promise, readiness timeout은 해당 instance의 진단 overlay로
  격리한다. config는 보존하고 retry/remount할 수 있다. iframe의 무한 loop·과도한 메모리
  사용은 main WebView를 방해할 수 있으므로 신뢰 모델 밖에서 완전히 방어한다고 약속하지 않는다.

### Common hook protocol

host bootstrap은 plugin script보다 먼저 `window.laymuxPlugin`을 주입한다. `view.mount`는
manifest에 쓰지 않는 implicit mandatory hook이고, 그 밖의 hook은 manifest가 선언한 것만
`on(hook, handler)`로 등록할 수 있다. plugin은 handler 등록을 마친 뒤 `ready()`를 정확히
한 번 호출한다. host는 임의 전역 함수명이나 `eval`로 handler를 찾지 않는다. envelope는
JSON으로 직렬화 가능한 다음 형태다.

```json
{
  "protocol": "laymux-plugin/v1",
  "generation": 3,
  "sequence": 12,
  "hook": "cwd.changed",
  "context": {
    "pluginId": "example.cwd-dashboard",
    "paneId": "pane-abcd1234",
    "workspaceId": "ws-main",
    "location": "workspace",
    "syncGroup": "ws-main"
  },
  "payload": { "cwd": "D:\\repo", "cause": "propagation", "force": false }
}
```

- iframe load 뒤 parent는 `contentWindow` identity를 확인해 `MessagePort`를 한 번 전달한다.
  plugin의 `ready()`와 port 연결이 모두 끝나면 bootstrap이 ready를 보내고, host는 그
  시점의 최신 raw state를 한 번 snapshot해 sequence 1의 `view.mount`를 보낸다. port 연결
  뒤 제한 시간 안에 ready가 없거나 `ready()`를 두 번 호출하면 instance fault다. ready 전
  변화는 별도 queue로 replay하지 않고 최신 mount snapshot에 흡수한다.
- `view.mount`는 manifest가 선언한 hook의 current state만 포함한다. 특히 CWD는
  `cwd.changed` 선언, effective `cwdReceive=true`, 유효 group을 모두 만족할 때만 포함한다.
  이후 선언된 `cwd.changed`, `theme.changed`, `view.focus-changed`만 보낸다. 알 수 없는
  hook 이름은 manifest 검증에서 거부한다. payload의 v1 최소 schema는 다음과 같고 새
  optional field는 additive하게만 추가한다.

  | Hook                 | Payload                                                                                                            |
  | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
  | `view.mount`         | `{ state: { cwd?: { value, cause: "snapshot" }, theme?, focused? } }` — 선언·권한이 있는 현재 값만                 |
  | `cwd.changed`        | `{ cwd, cause: "propagation" \| "force", force }`                                                                  |
  | `theme.changed`      | `{ id, colors: { bgBase, bgSurface, bgOverlay, border, textPrimary, textSecondary, accent, green, red, yellow } }` |
  | `view.focus-changed` | `{ focused }`                                                                                                      |

  unmount는 best-effort이며 cleanup의 성공 조건으로 삼지 않는다.

- instance generation 안에서 `sequence`는 단조 증가하고 전달 순서를 보장한다.
  delivery는 at-most-once이고 ack/retry/영속 replay를 제공하지 않는다. plugin handler별
  예외는 dispatcher가 잡아 이후 hook 전달을 계속한다. handler 완료를 host 상태 전이의
  전제나 다른 plugin의 barrier로 삼지 않으며 remount의 `view.mount`가 복구 snapshot이다.
- plugin이 보내는 메시지는 bootstrap ready/error와 host가 시작한 inspection의 응답만
  허용한다. 그 밖의 action/request는 protocol error로 무시한다.

### CWD/PWD hook

`cwd.changed`는 새 CWD 수집기가 아니라 ADR-0003 흐름의 read-only projection이다. mount의
`cause="snapshot"`은 현재 group을 대표하는 local session CWD이며 전파가 승인됐다는 뜻이
아니다. live `cwd.changed`만 source gate를 통과한 전파를 뜻한다.

- Rust는 source activity/loop/`cwdSend` gate와 target scope 계산을 끝낸 뒤 기존
  `sync-cwd` 구조화 event를 live CWD의 canonical event로 한 번 발행한다. event에는
  `scope: { kind: "groups", groupIds: string[] } | { kind: "all" }`을 additive하게 넣어
  automatic group, `--group`, `--all`의 실제 대상 group을 표현한다. 기존 `groupId`는 기존
  consumer 호환을 위해 유지하되 plugin host는 `scope`만 사용한다.
- plugin host는 gate보다 먼저 발행되는 `terminal-cwd-changed`를 live hook으로 사용하지
  않는다. valid effective group이고 `cwdReceive=true`이며, 그 group이 `scope.groupIds`에
  포함되거나 `scope.kind="all"`일 때만 canonical event 하나를 `cwd.changed` 하나로
  전달한다. backend terminal `targets` membership은 요구하지 않는다. normal event는
  `cause="propagation"`, `force=true` event는 `cause="force"`이며 force도 valid group과
  receiver gate를 우회하지 않는다. plugin은 raw PTY/OSC를 보거나 파싱하지 않고 background
  shell, `lx`, filesystem probe를 실행하지 않는다.
- target `cwdReceive=false`와 `syncGroup="none"`은 mount snapshot을 포함해 CWD를 주지
  않는다. normal 전파는 Rust의 기존 Shell/activity/loop/`cwdSend` gate를 통과해야 한다.
- mount의 representative snapshot은 같은 group의 non-empty `TerminalSession.cwd` projection을
  `(isFocused desc, lastActivityAt desc, terminalId lexical asc)`로 정렬한 첫 terminal에서
  고른다. custom group에 focused terminal이 여러 개여도 나머지 두 key로 결정적이다.
  `cwdSend=false`인 local CWD도 snapshot 후보가 될 수 있으며 이는 live propagation과
  의도적으로 다른 의미다. group 전용 CWD state를 새로 영속하지 않는다.
- `cwd`는 Rust가 승인한 Unicode path를 opaque string으로 전달한다. Windows host에서도
  POSIX, drive, UNC 경로일 수 있다. plugin layer에서 slash, drive, UNC, WSL distro를
  정규화·변환하지 않으며 값이 없으면 `null`이다.

### Automation과 screenshot

- `GET /api/v1/plugins`와 release MCP `list_plugins`는 catalog revision, valid contribution,
  bounded diagnostic code를 반환한다. absolute install path와 entry source는 반환하지 않는다.
- `POST /api/v1/plugins/reload`와 release MCP `reload_plugins`는 동일한 Rust scan→validate→
  atomic publish 경로를 호출한다. 이를 통해 Git checkout fixture를 앱 재시작 없이 결정적으로
  등록할 수 있다.
- existing pane view mutation API는 `PluginView` config를 받아 별도 선택 경로를 만들지 않는다.
  dev 전용 `GET /api/v1/plugins/instances/:paneId`와 MCP `inspect_plugin_view`는 pane의
  generation, ready/error, last sequence/hook, bounded `innerText` snapshot을 반환하며
  release route/`tools/list`와 direct call에서 숨긴다([ADR-0017](0017-mcp-dev-only-tools.md)).
- opaque iframe의 픽셀은 parent html2canvas가 직접 읽을 수 없다. v1 screenshot API는
  plugin pane의 host wrapper와 loading/error placeholder만 보존하며, 정상 plugin 내부 픽셀의
  완전한 캡처를 보장하지 않는다. 캡처를 위해 `allow-same-origin`을 추가하지 않는다.
- 정상 render와 hook 반영은 dev inspection endpoint의 bounded `innerText`, ready/error,
  generation·sequence와 WebView2/WebKitGTK component/e2e test로 프로그래밍적으로 검증한다.
  native/compositor 수준의 plugin 픽셀 캡처는 후속 요구이며 별도 보안·크로스플랫폼 결정을
  거친다. 구현과 문서는 그 전까지 plugin screenshot을 pixel-complete라고 주장하지 않는다.

## Alternatives Considered

- **`plugin:<id>`를 동적 ViewType으로 사용:** picker에는 단순하지만 Rust/UI의 닫힌 union,
  layout, dock, override 생명주기 곳곳에 외부 문자열을 퍼뜨린다. generic `PluginView`가
  동적 identity를 config 한 곳에 격리하므로 기각한다.
- **laymux가 Git URL을 clone/pull하고 dependency build까지 실행:** 설치 UX는 짧지만
  credential, prompt, supply-chain, partial update, Windows console, 임의 build script 실행을
  runtime 책임으로 끌어온다. v1은 checkout directory 계약과 명시적 reload만 소유한다.
- **native executable/Node/Tauri command plugin:** filesystem·process 기능은 강력하지만
  권한·서명·ABI·lifecycle·크로스플랫폼 계약이 먼저 필요하고 “offline HTML renderer”보다
  권한이 크게 넓다. v1 비목표다.
- **같은 origin iframe 또는 `allow-same-origin`을 추가:** relative asset과 parent capture는
  쉬워지지만 `allow-scripts`와 결합할 때 host DOM/IPC 격리가 약해진다. single-file bundle과
  dev inspection을 선택하고 plugin 내부 픽셀의 screenshot 보장은 v1에서 제외한다.
- **script-free sanitized HTML/template만 허용:** 강한 비신뢰 경계와 parent-side screenshot은
  단순하지만 hook에 반응하는 일반 renderer를 표현하기 어렵다. v1은 명시적으로 신뢰된
  JavaScript를 허용하고 공격 코드 격리를 약속하지 않는다.
- **별도 native child WebView에 무권한 capability 부여:** 권한 경계는 강해지지만 pane
  geometry, clipping/z-order, focus/keybinding, lazy visibility, html2canvas 합성의 Windows/Linux
  계약이 새로 필요하다. untrusted plugin 요구가 생기면 이 대안을 새 ADR로 재검토한다.
- **hidden workspace에서도 runtime 유지:** DOM 상태는 보존되지만 보이지 않는 timer와 hook이
  계속 CPU를 쓰고 background side effect를 만든다. visible-only remount를 선택한다.
- **plugin이 OSC 또는 terminal output을 직접 파싱:** provider별 확장은 쉬워도 ADR-0001의
  단일 패스와 ADR-0003의 CWD SoT를 깨뜨리므로 금지한다.

## Consequences

- 사용자는 repository를 정해진 directory에 checkout하고 reload하면 laymux 재빌드 없이
  plugin View를 선택할 수 있다. package는 network가 끊겨도 동일하게 렌더된다.
- author는 dependency를 한 HTML에 bundle해 commit해야 한다. runtime relative asset,
  package manager install, server API는 사용할 수 없다.
- 설치된 plugin은 신뢰 코드다. CSP/sandbox가 실수로 발생하는 network·navigation·DOM 접근을
  줄이지만 악성 plugin, WebView 취약점, CPU/memory denial을 막는 security boundary는 아니다.
- 공식 v1 SDK는 read-only라 form/button/editor와 host mutation을 제공하지 않는다. 다만
  신뢰된 plugin code가 ambient Tauri IPC에 기술적으로 접근할 가능성은 남는다. 지원되는
  interactive plugin, storage/config, filesystem/process capability는 각각 명시적 권한과
  routing 결정이 필요하다.
- iframe은 사용자 입력·접근성 focus·수동 scroll을 받지 않으므로 entry는 주어진 viewport에
  responsive하게 맞아야 한다. 접근 가능한 interactive plugin과 overflow navigation은 v1의
  render-only 범위를 넓히는 후속 결정이다.
- 비가시 전환마다 runtime state가 사라지고 재표시 때 `view.mount` snapshot으로 재구성한다.
  plugin은 unmount callback에 영속성이나 정확한 cleanup을 의존할 수 없다.
- missing/invalid/incompatible plugin은 pane 구성을 파괴하지 않고 진단 가능하다. 한 plugin의
  manifest/hook 오류는 sibling plugin과 앱 시작을 중단하지 않는다.
- 후속 구현 PR은 `overview.md` §4·§6·§7, `data-flow.md`의 View/CWD 흐름,
  `api-contracts.md`의 directory/manifest/hook/Automation/security 계약, roadmap을 함께
  갱신한다. 구현 전인 이 ADR PR에서는 living doc의 “built-in only” 서술을 바꾸지 않는다.
- 테스트는 Rust manifest/path/size/collision/atomic catalog, settings round-trip과 missing
  reference, iframe CSP/protocol/order/error/lifecycle, SyncGroup normal/force/none/receive gate,
  Windows WebView2·Linux WebKitGTK offline/network-denial smoke, reload/inspect e2e와 host
  placeholder screenshot 회귀 검증을 포함한다.
- 재검토 조건은 untrusted marketplace, interactive control, plugin-to-host capability,
  multi-file runtime asset, background execution, Remote UI projection 중 하나가 필요해질 때다.
