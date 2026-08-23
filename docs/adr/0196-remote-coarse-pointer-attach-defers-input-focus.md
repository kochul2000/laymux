# 0196. 터치 기기의 Remote attach 는 입력 surface focus 를 선점하지 않는다

- Status: Proposed
- Date: 2026-08-23
- Source: 사용자 실기 신고("리모트 최초 진입 시 컴포저가 켜져 있어도 입력이 안 되고, Keyboard 버튼을 껐다 켜야 입력된다"); [architecture/api-contracts.md §13](../architecture/api-contracts.md) Remote 입력 상태 전이 계약 — 정정 대상 문장("입력 포커스는 … 사용자가 시작한 진입만 변경한다")은 PR [#744](https://github.com/kochul2000/laymux/pull/744) 가 도입했다; PR [#882](https://github.com/kochul2000/laymux/pull/882)(APK 가 native view focus 만 복원하고 DOM editor 자동 focus·IME 열기를 하지 않는다는 계약)
- 선행 수정: PR [#848](https://github.com/kochul2000/laymux/pull/848)(`52522414`)이 **부팅 autoConnect 한 경로만** `focusInput: false` 로 막았다(에뮬레이터+CDP 계측으로 확정). 이 ADR 은 같은 원인을 pointer 축의 일반 규칙으로 승격한다.
- 관계: [ADR-0034](0034-single-send-terminal-composer.md)(coarse pointer 축의 선례 — 소프트 키보드 기기와 데스크톱을 pointer 로 갈랐다)와 [ADR-0036](0036-remote-composer-layout-rule.md)(Enter gesture 는 pointer 가 아니라 layout 축 `mobileLayout = coarsePointer || localAppMode` 로 판정한다)의 **축 구분을 정정하지 않고 확장**한다 — 입력 focus 는 layout 이 아니라 pointer 축에 속한다는 것을 명시한다. [ADR-0186](0186-remote-input-action-three-zone-layout.md)의 `Keyboard` action 과 pointer focus 보존 계약, [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)(APK 는 데스크톱 소유 Remote UI 를 그대로 띄운다 → 이 페이지 결정이 APK 에도 그대로 적용된다)를 전제로 한다.

## Context

Remote 입력 상태 전이 계약은 지금까지 "입력 포커스는 Connect·terminal 선택·Keyboard 버튼처럼 **사용자가 시작한 진입**만 변경한다"였다(PR #744). 이 규칙은 자동 복구(transport 재접속, snapshot replay, heartbeat reclaim)가 내려둔 키보드를 되살리지 못하게 막는 데는 충분했지만, 사용자가 시작한 진입을 모두 한 덩어리로 취급했다.

터치 기기에서는 이 구분이 부족하다. 소프트 키보드(IME)는 DOM focus 로 열리지 않고 **transient user activation 이 살아 있는 동안의 focus** 로만 열린다. 그리고 activation 은 gesture 를 처리하는 task(와 그 직후 animation frame) 를 넘어 네트워크 왕복을 기다리는 동안 유지되는 것이 보장되지 않는다. Remote 의 attach 는 lease claim → navigation → chrome settle → pre-attach resize → WebSocket open 이라는 여러 번의 `await` 를 지나서 완료되므로, Connect 나 pane 선택 탭에서 시작했더라도 focus 시점에는 그 창을 벗어나 있다. Android secure WebView 도 같아서, PR #882 는 native view focus 만 복원하고 "DOM editor 를 자동 focus 하거나 IME 를 열지는 않는다"를 APK 계약으로 못박았다. 그러나 Remote 페이지(JS)는 attach 완료 시 여전히 입력 surface 를 `focus()` 했다.

그 결과 터치 기기의 attach 는 **"DOM focus 는 composer 에 있는데 IME 만 닫힌"** 상태로 착지한다. 사용자에게는 컴포저가 켜져 있는데 입력이 안 되는 상태로 보인다. 게다가 `Keyboard` 버튼은 "지금 키보드가 올라와 있나"를 DOM focus 로 판정하므로 위상이 뒤집힌다 — 첫 탭이 키보드를 올리는 대신 editor 를 접고, 두 번째 탭에서야 실제 gesture 안의 focus 로 IME 가 열린다. Keyboard 버튼을 두 번 눌러야 하는 이유가 이것이다.

이 인과는 PR #848 이 이미 에뮬레이터+CDP 로 계측해 확정했다(수정 전 `activeElement=composerInput` + `mInputShown=false`). 다만 그 수정은 **부팅 autoConnect 호출 하나만** `focusInput: false` 로 막았다. 그래서 APK 진입과 cloud 대시보드 진입(둘 다 `autoConnect=1`)은 이미 focus 를 선점하지 않지만, **모바일 브라우저에서 Connect 를 직접 누르는 진입과 drawer 에서 pane 을 탭해 일어나는 attach 는 여전히 선점한다.** 같은 원인이 남은 경로에서 그대로 재현되므로, 호출부별 예외가 아니라 pointer 축의 규칙으로 승격할 시점이다.

범위는 **attach 완료 시점의 입력 surface focus** 다. 비목표: `Keyboard` 버튼 토글의 의미 변경, IME 가시성을 직접 관측·추적하는 새 상태 도입, 자동 복구 경로의 기존 no-focus 규칙 변경, VirtualKeyboard API 도입, 그리고 **첨부 업로드 완료 후의 focus 복원** — 그 경로는 자기 자신이 만든 blur(업로드 중 editor `disabled`)를 되돌리는 것이고 대기 시간도 동일 오리진 POST 하나라 attach 와 성질이 달라, 별도 결정으로 다룬다.

## Decision

**coarse pointer 기기에서는 attach 완료가 입력 surface 를 focus 하지 않는다 — Connect·terminal 선택으로 시작한 attach 도 마찬가지다. 그 기기에서 attach 뒤 입력 focus 를 만드는 것은 gesture 창 안의 경로(`Keyboard` 버튼, 입력 surface 직접 탭, 명시적 모드 전환, Send 직후 복귀, 파일 뷰어 닫기)뿐이다.**

- **불변식**: user gesture 로 시작한 focus 는 그 gesture 의 transient activation 창 안에서 수행한다 — 같은 task 또는 그 직후 `requestAnimationFrame` 까지만 허용하고, 네트워크 왕복(`await`) 뒤에서는 focus 하지 않는다. 이 경계가 결정의 전제이므로, gesture 경로에 왕복을 끼워 넣으면 이 결정이 조용히 무효화된다. 이름 규약만으로는 지켜지지 않으므로 attach 경로가 pointer gate 를 통과한다는 사실을 `remote_server::page` 의 source assertion 으로 pin 한다.
- 판정 축은 layout(`mobileLayout`)이 아니라 **pointer**(`coarsePointer`)다. ADR-0036 은 Enter gesture 를 layout 축으로 판정했지만, 입력 focus 는 소프트 키보드의 존재 여부에 달렸으므로 pointer 축이다. `localApp=1` PC 임베드 모바일 뷰는 모바일 layout 이지만 하드웨어 키보드로 조작되므로 attach 직후 focus 가 그대로 이득이고, 소프트 키보드가 없어 위상 문제도 없다.
- fine pointer(데스크톱 브라우저, PC 임베드 뷰)의 attach-focus 는 그대로 유지한다. Connect 직후 바로 타이핑할 수 있어야 한다.
- Composer 와 Direct 모드에 동일하게 적용된다. Direct 모드의 xterm helper textarea 도 프로그램적 focus 로는 IME 를 못 열고, 같은 방식으로 `Keyboard` 버튼 위상을 뒤집는다.
- 자동 복구 경로(재접속·snapshot replay·reclaim)의 기존 no-focus 규칙은 그대로다. 이번 결정은 "사용자가 시작한 진입"이라는 예외를 pointer 축에서 한 번 더 좁힌다.
- `Keyboard` 버튼은 계속 DOM focus 를 키보드 상태의 proxy 로 쓴다. IME 가시성은 웹에서 관측할 수 없으므로, 추정 상태를 하나 더 만들어 관리하지 않고 **선점 focus 라는 원인을 제거하는 쪽**을 택한다.

## Alternatives Considered

- **`Keyboard` 버튼에 "user gesture 로 focus 를 잡은 적 있음" 플래그를 도입** — attach-focus 는 유지하고 토글이 그 플래그를 보게 한다. attach 가 만든 focus 를 "가짜 focus"로 계속 들고 있어야 하고, 무효화 조건(직접 탭, blur, 모드 전환, 재접속, 시스템 키보드 내리기)을 모두 나열해야 한다. 실제 IME 상태를 관측할 수 없으므로 이 플래그는 영원히 추정치고, 시스템 dismiss 는 어차피 감지할 수 없어 완결되지도 않는다. 상태를 늘려 위상을 관리하는 대신 원인을 제거하는 쪽이 단순해 기각.
- **`VirtualKeyboard` API 나 `focus()` 직후 합성 탭으로 IME 를 직접 올린다** — Android Chrome 일부 버전 전용이고 iOS Safari 와 WebView 에 없다. 합성 gesture 는 브라우저가 user activation 으로 인정하지 않는다. 크로스플랫폼 보장이 없어 기각.
- **attach 후 focus 를 유지하되 `Keyboard` 버튼 첫 탭에서 blur→focus 재순환** — 두 번째 탭이 하던 일을 한 탭에서 하는 셈이지만, DOM focus 를 잃고 되찾는 동안 진행 중 IME 조합·selection 이 깨진다. 데스크톱에도 같은 코드가 걸려 회귀 위험만 늘어 기각.
- **`mobileLayout` 로 게이트** — `localApp=1` PC 임베드 뷰까지 attach-focus 를 잃는다. 하드웨어 키보드라 손해만 있고 얻는 게 없어 기각.
- **호출부별 `focusInput: false` 를 계속 늘린다(PR #848 방식의 연장)** — attach 진입점마다 예외를 붙이는 방식은 새 진입점이 생길 때마다 같은 결함을 새로 만든다. #848 이후 남아 있던 수동 Connect·pane 탭 경로가 그 증거다. 공유 attach 경로 한 곳에서 pointer 로 판정하는 쪽을 택했다.
- **첨부 업로드 중 editor 를 `disabled` 로 만들지 않아 blur 자체를 없앤다** — 첨부 경로의 focus 복원이 필요한 근본 이유를 제거하는 더 싼 수정이지만, 업로드 중 draft 편집·재전송을 어디까지 허용할지는 ADR-0181 의 in-flight guard 계약을 건드리는 별개 결정이다. 이 ADR 의 범위 밖으로 두고 후속으로 남긴다.

## Consequences

- 터치 기기에서 수동 Connect 로 진입하거나 pane 을 탭해 attach 한 뒤에는 아무 입력 surface 도 focus 되지 않고, 사용자의 첫 `Keyboard` 탭(또는 컴포저 직접 탭)이 곧바로 IME 를 올린다 — 탭 두 번이 한 번으로 줄고, "컴포저는 켜져 있는데 입력이 안 되는" 상태가 사라진다. `autoConnect=1` 진입(APK·cloud 대시보드)은 #848 이후 이미 이 상태였으므로 이 결정으로 달라지지 않는다.
- 비용 1: pane 전환 뒤에도 focus 가 돌아오지 않으므로, 키보드를 다시 올리려면 `Keyboard` 탭이 한 번 필요하다. 이전에도 그 focus 로 IME 가 열리지는 않았으니 실질 입력 능력의 손실은 아니지만, 위상이 맞은 탭 1회가 새로 보인다.
- Direct 모드로 attach 하면 첫 탭까지 xterm 커서가 inactive `outline` 로 남는다. 이전에는 attach-focus 가 곧바로 활성 커서를 만들었다. 입력 능력과 무관한 표시 차이지만 눈에 보이는 변화다.
- 첨부 업로드 완료의 focus 복원은 pointer 와 무관하게 유지된다(위 Alternatives). 따라서 coarse 에서도 긴 paste·파일 첨부 뒤에는 editor 가 focus 를 되찾는다 — 업로드 중 `disabled` 가 만든 blur 를 되돌리는 것이므로 이 결정과 충돌하지 않는다.
- 비용 2: 터치 기기에서 **하드웨어 키보드**(블루투스)를 쓰는 사용자는 진입 직후 바로 타이핑할 수 없고 한 번 탭해야 한다. 웹에서 하드웨어 키보드 유무를 신뢰할 수 있게 감지할 수 없으므로 조건을 더 좁히지 않는다.
- 수용된 한계: 사용자가 시스템 Back·브라우저 동작으로 키보드를 내리면 DOM focus 는 입력 surface 에 남고 IME 만 닫히므로, 그 뒤 첫 `Keyboard` 탭은 여전히 "접기"로 간다. api-contracts §13 이 이미 인정하는 상태이고, 감지할 수 없는 전이라 이 결정으로 없앨 수 없다. 이 결정이 없애는 것은 **모든 진입에서 항상 재현되던** 위상 반전이다.
- headless 브라우저는 IME 를 관측할 수 없으므로 e2e 는 IME 자체가 아니라 그 전제 상태를 고정한다 — coarse 진입에서 입력 surface 가 focus 되지 않고, `Keyboard` 첫 탭이 editor 를 접는 대신 focus 를 잡는다. fine pointer 의 attach-focus 유지도 같은 층에서 회귀로 고정한다.
- 재기준화 대상은 coarse pointer 로 도는 시나리오뿐이다 — `matchMedia("(pointer: coarse)")` 를 참으로 주입하는 스펙과 `hasTouch`/`isMobile` describe 가 그것이다. fine pointer 시나리오는 손대지 않고 attach-focus 유지 회귀로 남긴다. e2e 는 최초 attach 와 pane 전환 attach 를 덮고, gesture 창 안의 경로(파일 뷰어 닫기 등)는 이전 커버리지를 그대로 쓴다.
- `api-contracts.md` §13 의 입력 포커스 문장을 pointer 축으로 정정한다. APK 의 PR #882 계약(native view focus 만 복원)과 페이지 계약이 이제 서로 어긋나지 않는다.
- 승인 전제: headless 는 IME 를 못 보므로, 실기(에뮬·폰)에서 첫 탭에 IME 가 실제로 올라오는지 확인한 뒤 이 ADR 을 Accepted 로 전환한다.
- 재검토 조건: 브라우저가 user activation 없이 IME 를 열 수 있는 신뢰할 수 있는 표준 경로를 제공하거나, 터치 기기 + 하드웨어 키보드 조합을 안정적으로 감지할 수 있게 되는 경우.
