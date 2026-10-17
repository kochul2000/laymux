# 0327. Remote pane action 키는 PC 컨트롤 바 동작을 아이콘으로 실행한다

- Status: Accepted (Remote Stack behavior superseded by [0339](0339-remote-stack-creates-enterable-terminal.md))
- Date: 2026-10-15
- Source: 사용자 요구(Remote 키바의 `Alt+L` 표기를 빗자루 아이콘 Clear pane으로, 아이콘 동작은 아이콘 + 설명으로, Close pane·Stack 키 추가, PC 모드는 키바 액션에서 제외), [ADR-0277](0277-remote-pane-clear-soft-key.md), [ADR-0297](0297-pane-stack-slot-layer-model.md), [ADR-0322](0322-remote-item-management-menus.md), [ADR-0237](0237-remote-floating-input-controls.md), [api-contracts §13](../architecture/api-contracts.md#134-terminal-control)
- Amends: ADR-0277의 label·설명(`Alt+L`, `Alt+L (clear pane)`). ADR-0237이 입력 행·플로팅 선택지에 넣은 PC 모드를 뺀다. 나머지는 유지한다.

## Context

Remote 키바의 pane clear 키는 `Alt+L`로 표기된다. 실제로는 Alt+L 바이트를 보내지 않고 PC `pane.clearTerminal`을 실행하는데, 이름은 물리 단축키를 가리킨다. PC pane 컨트롤 바는 같은 동작을 빗자루 아이콘으로 보여 준다. Add keys 목록과 Actions 그룹은 메뉴·pane ID 복사 같은 동작도 텍스트로만 보여 준다. 이 동작들은 바에서 헤더 버튼의 아이콘으로 표시된다. 그래서 목록에서 고른 것과 바에 올라오는 것이 서로 다르게 보인다. PC 컨트롤 바의 Stack·Delete pane은 Remote에서 쓸 수 없다. PC 모드는 Remote 화면 자체를 바꾸는 헤더 전용 토글이라 입력 동작이 아니다.

범위는 Remote 키바, Add keys 표시, Remote pane 동작 API다. PC 컨트롤 바, PC 단축키, 헤더의 PC 모드 버튼은 바꾸지 않는다.

## Decision

**Remote pane action 키(Clear pane·Stack·Close pane)는 PC 컨트롤 바와 같은 동작을 같은 아이콘으로 실행한다. 바에는 아이콘만, Add keys에는 아이콘과 흐린 이름을 표시한다.**

- 내장 키 `soft:clearPane`(BrushCleaning), `soft:stackPane`(Layers), `soft:closePane`(X)를 Add keys의 Pane actions에 둔다. 아이콘은 PC `ClearTerminalBtn`·`StackBtn`·Delete pane 버튼과 같은 Lucide 아이콘이다. 이름은 `Clear pane`·`Stack`·`Close pane`이다. 키 id와 저장 배치는 바뀌지 않으므로 기존 기본값 `soft:clearPane` 배치는 그대로 이어진다.
- 실행은 키 바이트가 아니라 동작이다. 세 키 모두 navigation queue에서 순서대로 실행하고 대상은 열린 터미널의 pane이다.
  - Clear pane은 기존 `runRemoteClear("pane")`를 그대로 쓴다(ADR-0277).
  - Close pane은 PC Delete pane / Close layer와 같다. 확인 없이 열린 레이어 하나를 `POST /remote/v1/panes/{id}/close`(ADR-0322)로 닫는다. pane manager의 `canClose`가 거짓이면 키를 비활성화한다. 마지막 슬롯의 마지막 레이어가 그런 경우이며, PC는 이때 버튼을 숨긴다.
  - Stack은 PC Stack 버튼과 같다. 새 lease-gated route `POST /remote/v1/panes/{id}/stack`가 bridge `panes.stackById`를 호출한다. bridge는 활성 workspace에서 그 레이어가 있는 슬롯을 찾아 `stackPaneAt`을 실행한다. 그래서 EmptyView 레이어가 생기고, 그 레이어가 활성화·포커스된다. 열린 터미널이 활성 workspace의 grid pane이 아니면 키를 비활성화한다. dock에서 열었거나 비활성 workspace의 pane이면 이 경우다.
- 아이콘이 있는 입력 동작은 Add keys와 행 편집기 칩에서 아이콘 + 이름으로 표시한다. 이름은 `--muted`로 흐리게, 아이콘은 본문 색으로 그린다. 대상은 Keyboard·Send·Composer·Attach file·Menu·Copy pane ID·Viewer·Skip pane과 pane action 키다. 바와 플로팅 버튼에는 아이콘만 올리고 이름은 `aria-label`·`title`로 둔다. 아이콘이 없는 키(Keys, `^C`, F키, 사용자 키)는 지금처럼 텍스트로 둔다.
- PC 모드(`desktop`)는 입력 동작 목록, `actionCatalog`, 플로팅 선택지에서 뺀다. 헤더 버튼과 그 기능은 유지한다. 저장된 배치에 남은 `desktop`은 알 수 없는 id로 정규화되어 개별 제거된다.

## Alternatives Considered

- `Clear pane (Alt+L)`처럼 단축키를 병기한다: 물리 단축키는 PC에서 재바인딩할 수 있다. 그러면 표기가 틀릴 수 있고, 아이콘으로 동작을 보이라는 요구와도 맞지 않는다.
- Stack이 Remote에서만 기본 프로필 터미널을 바로 만든다: Remote에서 바로 쓸 수 있지만 PC와 다르다. 사용자가 PC와 같은 동작을 택했다. Remote에는 EmptyView에서 뷰를 고르는 UI가 없으므로 새 레이어의 뷰는 PC에서 고른다.
- Close pane에 두 번 탭 확인을 둔다: PC 컨트롤 바는 확인 없이 닫는다. PC와 같은 동작을 택했다.
- Automation `POST /api/v1/panes/stack`(index 기반)을 Remote에 노출한다: Remote는 콘텐츠 ID로 대상을 고르므로(ADR-0322) index는 이동·재배치 사이에 어긋난다.

## Consequences

PC와 Remote의 pane 동작이 같은 아이콘·의미를 갖고, Add keys에서 고른 모양이 바에 그대로 올라온다. Remote에 lease-gated route 하나와 bridge 메서드 하나가 추가된다. Android E2E 내부 allowlist도 같은 정확한 경로를 허용한다. Close pane은 확인 없이 실행되므로 잘못 누르면 PC와 마찬가지로 레이어가 닫힌다. Stack으로 생긴 EmptyView 레이어는 Remote에서 `---`로만 보인다. Remote에서 뷰를 고를 수 있게 되면 이 결정을 다시 검토한다. Remote 화면에서 PC 모드를 키바에 두던 기기는 그 버튼을 잃고 헤더 버튼을 쓴다. 검증은 bridge 단위 테스트(`stackById`), Rust route 테스트, Remote e2e로 한다. e2e는 아이콘 표시, 흐린 이름, 요청 경로·lease, PC 모드 부재를 확인한다.
