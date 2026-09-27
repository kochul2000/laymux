# 0269. Remote 물리 키보드는 PC 키바인딩을 공유하고, Composer 키만 PC·Remote 로 나눈다

- Status: Accepted
- Date: 2026-09-27
- Source: 사용자 요구(Remote 에서 물리 키보드로 pane 전환·클리어·Composer 전송, Composer 키는 PC·Remote 별도 바인딩), [api-contracts.md §15.5](../architecture/api-contracts.md#155-키보드-단축키-설계-원칙), [ADR-0034](0034-single-send-terminal-composer.md), [ADR-0036](0036-remote-composer-layout-rule.md), [ADR-0039](0039-remote-spatial-notification-step-navigation.md), [ADR-0158](0158-activity-aware-single-pane-clear.md)
- 관계: ADR-0036 일부 대체 — Remote Composer 의 layout 기반 Enter 규칙을 Remote 전용 키바인딩으로 바꾼다. Send 버튼 등 나머지는 유지.

## Context

Remote(휴대폰·태블릿·브라우저)에 물리 키보드를 붙여도 키보드로 할 수 있는 게 거의 없다.

- Remote 에는 단축키 계층이 없다. pane·알림 이동은 소프트키 버튼으로만 되고, 실제 클리어는 경로가 없다.
- Composer 의 Enter 뜻은 layout 이 정한다(ADR-0036). 터치 기기에선 Enter 가 줄바꿈이고 키보드로 전송할 방법이 없다. Send 버튼뿐이다.
- 직접 입력 모드에서 Alt+화살표 같은 조합은 그대로 PTY 로 간다.

비목표: 기기별 단축키 재바인딩, Cmd(Meta) 키, 워크스페이스 생성·삭제 같은 파괴적 단축키.

## Decision

**Remote 는 PC 와 같은 키바인딩(같은 액션 ID, 같은 사용자 설정)을 쓴다. 입력 조건이 다른 Composer 전송·줄바꿈만 PC 용과 Remote 용 바인딩으로 나눈다.**

1. **키바인딩 정본은 PC.** 기본값은 PC·Remote 가 함께 쓰는 순수 모듈에, 재바인딩은 PC `settings.json` 의 `keybindings` 에 있다. Remote 는 navigation 응답으로 재바인딩 목록을 받는다.
2. **단축키는 항상 켜져 있다.** "물리 키보드 모드" 스위치도 자동 감지도 없다. 수식키 조합은 소프트 키보드로 거의 눌리지 않아 충돌하지 않는다.
3. **Remote 지원 액션** — 목록에 없는 PC 액션은 Remote 가 무시하고 키를 그대로 흘려보낸다.

   | 액션 | 기본키 | Remote 동작 |
   |---|---|---|
   | `pane.focus` | Alt+화살표 | 그 방향 터미널 pane 으로 이동 |
   | `pane.clearTerminal` | Alt+L | 보고 있는 터미널 실제 클리어 |
   | `workspace.clearTerminals` | Ctrl+Alt+L | 워크스페이스 클리어 |
   | `workspace.1~8`·`last`·`next`·`prev` | Ctrl+Alt+숫자·↑↓ | 워크스페이스 전환 |
   | `notifications.recent`·`oldest` | Ctrl+Alt+←→ | 알림 pane 이동 |
   | `terminal.toggleInputMode` | Ctrl+Alt+M | 직접 입력 ↔ Composer |
   | `pane.copyIdentifier` | Ctrl+Alt+C | pane ID 복사 |
   | `sidebar.toggle`·`notifications.toggle`·`fileViewer.open` | Ctrl+Shift+B·I·O | 메뉴·알림 패널·Files |
   | `terminal.zoomIn`·`zoomOut`·`zoomReset` | Ctrl+= · - · 0 | 이 기기 터미널 글자 크기 |

4. **방향 이동은 PC 와 같은 계산.** PC 의 `findPaneInDirection` 을 쓴다. 기준은 호스트 포커스 pane, 후보는 활성 워크스페이스의 터미널 pane 이다. dock 은 빠지고(ADR-0020), 순회 제외 목록(ADR-0046)은 순회 전용이라 적용하지 않는다. 끝에서는 멈춘다(워크스페이스를 넘지 않는다). ADR-0039 와 같은 방식으로 새 endpoint 와 bridge action 을 둔다.
5. **클리어는 기존 경로를 중계한다.** 새 Remote endpoint(lease 필수)가 PC 의 pane 클리어·워크스페이스 클리어를 부른다. 입력·busy 정책은 ADR-0158·ADR-0137 이 그대로 소유한다.
6. **Composer 키는 PC·Remote 별도 바인딩이다.**

   | 액션 | 기본키 | 적용 |
   |---|---|---|
   | `composer.pc.send` | Enter | PC Composer |
   | `composer.pc.newline` | Shift+Enter | PC Composer |
   | `composer.remote.send` | Ctrl+Enter | Remote Composer |
   | `composer.remote.newline` | Enter | Remote Composer |

   - Remote 는 layout(터치 기기·PC 임베드 뷰·PC 브라우저)과 상관없이 이 바인딩만 따른다. 터치 기기의 Send 버튼은 그대로 있다.
   - Remote 기본값은 소프트 키보드에서도 안전하다. Ctrl 을 못 누르니 실수 전송이 없고 Enter 는 줄바꿈이다. 소프트·물리 키보드를 구분할 필요가 없다.
   - `composer.remote.send` 를 plain Enter 로 바꾸면 소프트 키보드 Enter 도 전송이 될 수 있다. 사용자가 고른 결과다.
7. **가로채기 규칙**
   - window capture 단계 keydown 하나가 처리한다. 매치되면 기본 동작과 전파를 막아 PTY·브라우저로 새지 않게 한다.
   - IME 조합 중(`isComposing`, keyCode 229)은 무시한다. Composer 바인딩도 마찬가지다.
   - 호스트를 바꾸는 액션은 lease 가 있어야 하고, 키 반복(`repeat`)은 무시한다.
   - Composer·터미널이 아닌 입력칸에 포커스가 있거나 모달(파일 뷰어·GitHub·메모·설정)이 열려 있으면 처리하지 않는다.
8. **키 매칭 보강 (PC 도 적용)** — 수식키 조합에서 `e.key` 가 영문·숫자가 아니면(Mac Option+L 의 `¬`, 한글 `ㅣ`, AZERTY `&`) `e.code`(`KeyL`, `Digit1`)로 다시 맞춘다. `e.key` 가 영문·숫자면 그대로 써서 Dvorak 같은 배열의 뜻을 지킨다.
9. **보이기** — Remote 설정 패널에 현재 단축키를 읽기 전용으로 보여준다. 재바인딩은 PC Settings 에서 한다.

## Alternatives Considered

- **물리 키보드 모드 스위치(또는 자동 감지)로 단축키를 켠다** — 수식키 조합은 충돌이 없어 끌 이유가 없고, 꺼져 있으면 "안 된다"는 혼란만 생긴다. 브라우저에는 물리 키보드 감지 API 가 없어 자동 감지는 추측이다.
- **layout 규칙 위에 Enter 기기 설정(auto·send·newline)을 얹는다** — 규칙이 두 겹이라 어떤 키가 무엇을 하는지 예측하기 어렵다.
- **PC·Remote 공통 전송·줄바꿈 바인딩 한 쌍** — 한 벌이면 PC 에서 Enter 전송을 원하는 사용자와 폰 소프트 키보드 사용자가 부딪힌다. 소프트·물리 Enter 를 자동 구분해 풀려면 브라우저·IME 마다 다른 이벤트 모양에 기대야 한다.
- **Remote 전용 키바인딩 전체** — 두 벌 관리, 설정 화면도 두 곳이 된다. 조건이 실제로 다른 Composer 키만 나눈다.
- **Alt+화살표를 기존 1D 순회(prev/next)에 연결** — 구현은 싸지만 마지막 pane 에서 다음 워크스페이스로 넘어가 PC 와 뜻이 다르다.
- **Ctrl+Enter 전송 하드코딩** — §15.5 위반, ADR-0036 에서 이미 기각. 재바인딩 가능한 액션으로만 둔다.

## Consequences

- 물리 키보드를 쓰는 Remote 에서 PC 와 같은 손 기억으로 pane 이동·클리어를 하고, Ctrl+Enter 로 전송한다.
- PC 브라우저로 여는 Remote 도 기본이 Enter 줄바꿈·Ctrl+Enter 전송으로 바뀐다. 예전처럼 쓰려면 `composer.remote.send`=Enter, `composer.remote.newline`=Shift+Enter 로 바꾼다.
- Remote 바인딩은 PC 설정 한 벌이라 모든 Remote 기기에 같이 적용된다.
- 직접 입력 모드에서 셸의 Alt+화살표·Alt+L 을 laymux 가 가져간다. PC 와 같은 트레이드오프이고 재바인딩으로 피한다.
- 데스크톱 브라우저 탭에서는 브라우저 예약키(Ctrl+W·T·N)를 못 가로채고, Ctrl+Shift+I·O·B 는 브라우저가 먼저 가져갈 수 있다. Android 앱·PWA·PC 임베드 뷰는 영향이 없다.
- Remote endpoint 가 3개(방향 이동, pane 클리어, 워크스페이스 클리어) 늘어난다 → api-contracts 갱신, route 테스트.
- 키 매칭 보강과 PC Composer 바인딩 전환은 PC 동작도 건드린다 → PC 회귀 테스트로 고정한다.
- Cmd(Meta) 는 여전히 못 쓴다. iPad·Mac 에서는 Ctrl 조합을 쓴다. 요구가 생기면 따로 결정한다.
- 구현 PR 에서 api-contracts §15.5(Remote 적용 범위)와 Remote 입력 흐름 living doc 을 함께 갱신한다.
