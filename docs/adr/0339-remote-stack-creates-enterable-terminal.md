# 0339. Remote Stack은 바로 진입 가능한 터미널을 만든다

- Status: Proposed
- Date: 2026-10-17
- Source: 사용자 요구(Remote Stack으로 만든 레이어에 진입할 수 없고 스킵 버튼도 없음), [ADR-0327](0327-remote-pane-action-keys-mirror-pc-control-bar.md), [data-flow.md 스택](../architecture/data-flow.md#스택)
- Amends: ADR-0327의 Remote Stack이 EmptyView를 만들고 PC에서 뷰를 선택하도록 한 부분. 다른 pane action과 PC Stack 동작은 유지한다.

## Context

Remote Stack은 PC 버튼과 동일하게 EmptyView를 만들지만 Remote에는 빈 레이어의 뷰를 선택하는 UI가 없다. 그래서 새 레이어는 `---`로 남고 터미널 진입·출력 연결·탐색 스킵을 모두 사용할 수 없다. PC에 접근할 수 없는 원격 작업에서는 Stack의 목적을 달성하지 못한다. 기존 lease, 콘텐츠 ID, 시작 큐, 레이어 활성화 소유권을 유지하면서 원격 조작만으로 사용 가능한 터미널을 만들어야 한다.

## Decision

**Remote Stack은 열린 터미널의 프로필과 CWD를 이어받는 TerminalView 레이어를 만들고 새 터미널에 연결한다.**

- 기존 `POST /remote/v1/panes/{id}/stack`의 인증·Origin·활성 lease gate와 활성 workspace 제한을 유지한다. 대상 콘텐츠 ID가 터미널이 아니거나 없으면 오류로 거부한다.
- bridge는 대상 레이어의 실제 프로필(아직 세션이 없으면 설정 프로필)과 CWD를 해석한다. 대상이 비활성 레이어여도 호스트의 현재 표시 레이어에서 상속하지 않는다. CWD는 기존 runtime 우선·저장값 차선 규칙과 재시작 요청 버스를 사용한다. 대화 ID·startup command·syncGroup 등의 실행 상태는 복제하지 않는다.
- `stackPaneAt`과 기존 활성화 소유자로 레이어를 표시·포커스한다. 응답은 기존 `stacked`·`layerId`에 `terminalId`를 더한다. PTY 시작은 기존 시작 큐가 소유한다.
- Remote는 응답의 터미널을 기존 `selectTerminal`의 host focus·readiness·navigation 갱신 경로로 선택한다. 그 사이 lease가 바뀌면 연결하지 않는다. 기존 터미널 행이므로 진입·스킵·관리 버튼은 공통 경로로 제공한다.
- PC Stack은 EmptyView를 만들고, Automation stack은 기존 표시 레이어를 유지한다(ADR-0328). 이미 저장된 EmptyView는 자동 변환하지 않는다.

## Alternatives Considered

- **EmptyView에서 뷰·프로필 선택 UI 추가:** 모든 뷰의 원격 사용 계약과 별도 lease-gated 편집 API가 필요하다. 터미널을 쌓으려는 현재 결함보다 범위가 크다.
- **기본 프로필만 사용:** WSL 터미널에서 PowerShell을 만들면 CWD 형식과 실행 환경이 바뀐다. 열린 터미널의 프로필을 이어받는다.
- **빈 레이어에 스킵만 추가:** 진입 불가를 해결하지 못하고 터미널 탐색 제외의 기존 의미도 넓힌다.

## Consequences

Remote만으로 Stack 직후 입력과 레이어 재진입·스킵을 사용할 수 있다. Remote와 PC의 Stack 기본 뷰가 달라지는 비용이 있다. 실행 환경만 이어받으므로 실행 중인 에이전트나 대화는 복제되지 않는다. 기존 빈 레이어는 PC에서 뷰를 고르거나 Remote 관리 메뉴로 닫는다. Windows·WSL CWD 상속, 비활성 원본 레이어, lease 변경, 생성 실패, 리모트 출력 연결과 스킵을 테스트한다. 기능 추가 없는 기존 Stack의 사용 불가 수정으로 버전 영향은 patch다. 원격 뷰 선택이 필요해지면 별도 결정으로 검토한다.
