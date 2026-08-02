# 0121. 단일 pane 클리어는 사용자가 가리킨 pane 하나를 범위로 삼고, dock 을 포함한다

- Status: Proposed
- Date: 2026-08-02
- Source: 사용자 요구(issue #741 "클리어 기능 고도화"), [ADR-0113](0113-workspace-clear-activity-owned.md)(워크스페이스 클리어 — activity handler 가 클리어 방법을 소유)의 범위 확장

## Context

[ADR-0113](0113-workspace-clear-activity-owned.md) 은 "워크스페이스의 모든 터미널 pane 을 한 번에" 클리어하는 동작을 정했다. 실제로 쓰다 보면 대부분의 순간에 정리하고 싶은 대상은 **지금 보고 있는 pane 하나**다. 지금은 전부(`Ctrl+Alt+L`) 아니면 그 pane 에 포커스를 두고 손으로 `clear`/`/clear` 를 치는 두 선택뿐이고, 후자는 pane 이 무엇을 돌리는지 사용자가 매번 판단해야 한다 — ADR-0113 이 앱으로 옮긴 바로 그 판단이다.

여기서 정해야 할 것은 하나다. **ADR-0113 이 dock 을 범위에서 뺀 이유가 단일 pane 클리어에도 그대로 적용되는가.** ADR-0113 의 근거는 두 가지였다: (1) "워크스페이스 클리어"인데 `workspace.panes` 에 없는 표면까지 건드리면 이름과 동작이 어긋난다, (2) `restart` 정책의 복구 경로가 워크스페이스 pane 조회에 의존한다.

비목표: 클리어할 텍스트의 판정 규칙, busy 정책의 갈래, 미등록 interactive app skip 은 ADR-0113 의 결정이며 이 ADR 에서 다시 정하지 않는다. 여러 pane 을 골라 클리어하는 선택 UI 도 비목표다.

## Decision

**단일 pane 클리어(`pane.clearTerminal`, 기본 `Alt+L`)의 범위는 "사용자가 가리킨 pane 하나"이고, 격자와 dock 을 구분하지 않는다. 판정과 실행은 ADR-0113 의 것을 그대로 재사용하며, pane id → 클리어 가능 여부·복구용 view 의 조회는 `workspace-clear.ts` 한 곳이 소유한다.**

- **dock pane 은 대상이다.** ADR-0113 이 dock 을 뺀 근거는 "워크스페이스라는 범위"였다. 이 동작의 범위는 워크스페이스가 아니라 포커스이므로 그 근거가 성립하지 않는다. 사용자가 dock 터미널에 포커스를 두고 클리어를 눌렀는데 아무 일도 일어나지 않는 것은, 같은 키가 격자에서만 동작하는 설명 불가능한 예외가 된다.
- **판정·실행 경로를 공유한다.** `clearPane()` 은 `planWorkspaceClear([paneId], …)` 로 계획하고 `clearWorkspace()` 와 같은 `executeClear()` 로 제출·interrupt·restart 한다. "한 pane 일 때는 이렇게"라는 두 번째 규칙을 만들지 않는다 — 두 벌이 되는 순간 handler 계약 변경이 한쪽에만 반영되는 부채가 생긴다.
- **pane 조회의 소유자는 `workspace-clear.ts` 다.** `findTerminalPaneView(paneId)` 가 모든 워크스페이스 격자와 모든 dock 을 훑어 `TerminalView` 일 때만 view 를 돌려준다. pane id 는 전역 유일하므로 이 조회는 모호하지 않고, ADR-0113 의 두 번째 근거(restart 복구 경로)는 이 조회 하나로 해소된다. 호출자마다 view 를 인자로 나르게 하는 대안은 같은 사실의 소유자를 호출자 수만큼 늘린다.
- **터미널이 아닌 pane 은 실패로 답한다.** `clearPane()` 은 터미널 pane 이 아니면 throw 한다. 단축키 경로는 애초에 포커스 판정에서 걸러 no-op 이고, Automation 경로는 이 실패를 에러로 받는다. 빈 결과로 답하면 "busy 라서 skip 됐다"와 "그 pane 은 클리어 대상이 아니다"가 구분되지 않는다 — ADR-0113 이 결과 보고를 계약에 넣은 것과 같은 이유다.
- **Automation 은 pane id 로 받는다.** `POST /api/v1/panes/{paneId}/clear`. 기존 `panes/{index}/*` 라우트는 활성 워크스페이스의 격자 인덱스를 받지만, dock pane 에는 인덱스가 없다. 대기 캡(`waitCapped`·`interruptRounds`·`settleMs` 보고)은 워크스페이스 클리어와 같은 헬퍼를 공유한다.

## Alternatives Considered

- **워크스페이스 클리어에 "포커스된 pane 만" 옵션을 추가한다.** 설정 한 축이 늘고, 같은 키가 설정에 따라 하나 또는 전부를 지우게 된다. 되돌릴 수 없는 쓰기에서 "이 키가 지금 무엇을 지우는가"가 설정 상태에 의존하면 안 된다. 별도 키가 답이다.
- **`Ctrl+Alt+L` 의 수식키를 줄인 `Alt+L` 대신 다른 키.** `Alt+L` 은 readline 의 `downcase-word` 와 겹친다. 그래도 이 조합을 고른 이유는 전체 클리어(`Ctrl+Alt+L`)와의 관계가 키에서 바로 읽히기 때문이고, 겹침이 문제인 사용자는 keybinding 설정으로 옮길 수 있다.
- **dock 을 제외해 ADR-0113 과 표면 범위를 맞춘다.** 일관성은 얻지만, 사용자가 실제로 가리킨 pane 에서 동작하지 않는 단축키가 된다. 두 동작은 이름이 다르고 범위의 근거도 다르므로, 표면 목록을 억지로 맞추는 것은 잘못된 일관성이다.
- **격자 인덱스로 Automation 라우트를 받는다.** 기존 `panes/{index}` 와 표기가 일치하지만 dock pane 을 표현할 수 없어, 이 결정이 포함한 범위의 절반을 API 에서 잘라낸다.
- **`findTerminalPaneView` 를 활성 워크스페이스로 한정한다.** 조회 비용은 줄지만, 비활성 워크스페이스 pane 을 가리킨 Automation 호출이 "없는 pane"과 구분되지 않는다. pane id 가 전역 유일하다는 사실을 굳이 버릴 이유가 없다.

## Consequences

- ADR-0113 의 "Dock 은 대상이 아니다"는 **워크스페이스 클리어에 한정된 진술**로 좁혀진다. living doc(`architecture/overview.md §4.1.1`)에 두 동작의 표면 범위가 다른 이유를 함께 적는다. ADR-0113 본문은 append-only 이므로 고치지 않는다.
- `Alt+L` 이 pass-through 로 앱에 잡히므로 shell 의 readline `downcase-word` 는 기본 설정에서 터미널에 도달하지 않는다. 되돌리는 수단은 keybinding 재설정이다.
- 단일 pane 클리어도 `busyPolicy: "restart"` 에서는 PTY 를 새로 만든다 — 스크롤백이 사라진다. 전체 클리어와 같은 트레이드오프이고 같은 설정 하나가 지배한다.
- `POST /api/v1/panes/{paneId}/clear` 가 생겨 자율 검증 루프가 pane 하나만 클리어한 뒤 스크린샷으로 판정할 수 있다. 워크스페이스 클리어와 마찬가지로 human-control lease 게이트를 우회하지 않는다 — 원격이 제어권을 쥐면 write 가 거부되고 `failed` 로 보고된다.
- 결과 보고는 여전히 `console.warn` 이다. pane 하나짜리 클리어가 skip 되면 화면에는 아무 변화가 없으므로, 알림 표면이 생겼을 때 사용자에게 알려야 할 우선순위는 전체 클리어보다 오히려 높다.
- 재검토 조건: 여러 pane 을 골라 클리어하는 요구가 나오면 "가리킨 pane 하나" 범위를, dock 에서만 다른 busy 정책을 쓰고 싶다는 요구가 나오면 전역 정책 하나라는 ADR-0113 의 결정을 각각 다시 정한다.
