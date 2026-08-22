# 0188. Workspace selector는 마지막 사용자 입력 표시 모드를 제공한다

- Status: Accepted
- Date: 2026-08-21
- Source: 사용자 요구(기본은 terminal pane별 2줄, 선택 시 pane은 한 줄이고 workspace별 최신 제출 입력 한 줄); [architecture/data-flow.md §9](../architecture/data-flow.md); [architecture/api-contracts.md §13.3](../architecture/api-contracts.md); [ADR-0005](0005-display-state-raw-separation-compute.md); [ADR-0151](0151-remote-workspace-selector-information-parity.md)의 하단 상태 행 결정 정정

## Context

Workspace selector는 pane별 환경·activity·경로·결과 아이콘 한 줄 아래에 workspace 전체에서 가장 최근인 명령 또는 알림을 다시 한 줄로 모아 표시했다. 에이전트 pane에서는 이 하단 문구가 PTY 출력의 assistant bullet에서 갱신되는 `activityMessage`를 사용했다. 답변이 스트리밍되거나 TUI가 같은 줄을 다시 그릴 때 미완성 출력이 짧은 주기로 바뀌어, 사용자가 수행 중인 작업을 식별하려는 selector가 raw PTY 토큰처럼 흔들렸다.

workspace 단위 통합 행은 어느 pane의 문맥인지 바로 알기 어렵고, pane별 CWD와 상태가 이미 있는 화면에서 정보를 중복했다. 반면 사용자가 해당 pane에 마지막으로 제출한 질문이나 명령은 작업 문맥을 안정적으로 식별한다. 기본 화면은 pane 소유권을 드러내는 2줄 배치가 적합하지만, pane이 많은 workspace에서는 높이를 줄이고 workspace의 가장 최근 문맥 하나만 보고 싶은 수요도 있다. 두 경우 모두 PTY 출력·알림이 아닌 제출 입력만 써야 안정성이 유지된다. 다만 입력 문자열은 비밀번호 등 민감 정보를 포함할 수 있으므로 세션이나 디스크에 새로 영속하면 안 된다.

이 결정은 selector의 정보 배치와 런타임 표시 상태만 다룬다. PTY 출력 기반 `activityMessage` 감지, notification 생성, 명령 결과 판정, terminal input wire protocol은 바꾸지 않는다.

## Decision

**Desktop과 Remote workspace selector는 `workspaceSelector.lastInputMode`에 따라 `perPane` 또는 `workspaceLatest`로 마지막 제출 입력을 표시하며, 기본값은 pane별 2줄인 `perPane`이다.**

- `TerminalInstance.lastUserInput`과 `lastUserInputAt`은 사용자 입력의 런타임 원시 상태다. Composer는 structured input 성공 뒤 전송한 snapshot을 기록하고, Direct 모드는 xterm의 human `onData`만 bounded line editor로 조립해 CR/LF 제출이 성공한 때 기록한다. PTY 출력과 assistant 응답은 이 필드를 쓰지 않는다.
- Direct 모드는 activity가 일반 셸인지 interactive app인지와 무관하게 사람의 CR/LF 제출을 `lastUserInput`에 기록한다. 기존 OSC 133 `lastCommand`/`lastCommandAt`은 shell integration이나 backend summary에서 얻는 보완 원시 상태다. 공용 계산 함수는 두 값 중 timestamp가 더 최신인 비어 있지 않은 값을 pane 둘째 줄로 선택한다.
- 여러 줄 입력은 공백을 한 칸으로 접어 한 줄로 표시하며 화면 폭에서 ellipsis 처리한다. 제출 전 draft나 글자별 Direct 입력은 selector에 노출하지 않는다.
- `lastUserInput`은 Zustand 메모리에만 두며 session/settings/localStorage/디스크에 저장하지 않는다. backend summary만 있는 lazy placeholder는 `lastCommand`로 폴백한다.
- `workspaceSelector.lastInputMode`는 `"perPane" | "workspaceLatest"` 열거형이며 누락되거나 유효하지 않으면 `perPane`으로 정규화한다. 설정 UI에서 즉시 변경할 수 있고 Desktop과 Remote가 같은 값을 따른다.
- `perPane`에서는 첫째 줄의 환경·activity·branch·CWD·결과 아이콘과 unread ring/dot을 유지하고, 둘째 줄에 해당 pane의 마지막 제출 입력을 표시한다. 입력이 없어도 둘째 줄 높이를 유지해 terminal pane이 항상 두 줄이 되게 한다. workspace pane 목록 뒤에는 별도 입력 행을 렌더하지 않는다.
- `workspaceLatest`에서는 각 terminal pane을 기존 메타데이터 한 줄로 줄이고, visible terminal pane들의 마지막 제출 입력 중 timestamp가 가장 최신인 값을 pane 목록 아래 한 줄에 표시한다. 값이 없으면 빈 한 줄 높이를 유지한다. hidden pane의 입력은 보이는 목록의 workspace 문맥을 대표하지 않으므로 집계에서 제외한다.
- 어느 모드에서도 과거의 최신 명령·상대 시간·최신 unread 알림 통합 상태 행을 복원하지 않는다. unread 알림은 workspace count badge와 pane result ring/dot으로 계속 표시한다.
- Remote navigation의 `selectorDisplay`에는 additive `lastInput`과 `lastInputAt`을 포함한다. Remote는 PC가 계산한 문자열과 timestamp로 설정 모드의 배치를 렌더하고 provider 상태를 재계산하지 않는다. 기존 `selectorSummary` payload는 호환성을 위해 유지하지만 bundled Remote page는 하단 행에 사용하지 않는다.

## Alternatives Considered

- **assistant 최종 출력이 안정될 때까지 debounce**: 갱신 빈도는 줄지만 완료 경계를 신뢰할 수 없고 provider별 TUI redraw 형식을 계속 추적해야 한다. 작업을 식별하는 정보도 사용자 입력보다 덜 직접적이다.
- **workspace 하단 통합 행만 마지막 사용자 입력으로 교체**: pane별 문맥이라는 기본 요구를 충족하지 못한다. 다만 밀도를 선호하는 사용 사례에는 유효하므로 기본값이 아닌 `workspaceLatest` 모드로 제공한다.
- **workspace root를 별도 행으로 추가**: workspace 모델에 독립 root SoT가 없고 pane CWD를 임의로 승격하면 SyncGroup의 실제 상태와 어긋난다. 기존 pane CWD를 첫째 줄에 유지한다.
- **입력 내용을 backend와 세션에 영속**: 재시작·Remote 간 공유는 쉬워지지만 민감 입력의 저장 범위를 넓힌다. selector 편의를 위해 그 보안 비용을 만들지 않는다.
- **PTY 출력에서 에이전트 prompt를 역파싱**: Remote 등 모든 입력원을 관찰할 수 있지만 cursor redraw·wrap·부분 chunk 때문에 원래의 불안정성을 다른 marker로 옮긴다. 입력 경로에서 제출 intent를 아는 경우만 기록한다.

## Consequences

- assistant 응답 토큰이 빠르게 바뀌어도 selector의 마지막 입력 문구는 다음 사용자 제출 전까지 안정적이다.
- 기본 `perPane`은 terminal pane마다 한 줄 높이가 늘어 pane이 많은 workspace의 전체 높이가 커질 수 있다. `workspaceLatest`는 pane을 한 줄로 되돌리고 workspace당 한 줄만 더해 이 비용을 줄이지만, 최신 입력이 어느 pane의 것인지는 표시하지 않는다.
- Direct 입력 조립기는 common line editing만 지원한다. 복잡한 애플리케이션별 편집 escape sequence는 무시하므로 극단적인 편집에서 표시 문자열이 실제 제출과 다를 수 있지만 PTY 전송 자체에는 관여하지 않는다.
- Remote나 Automation이 에이전트에 raw 입력을 보낸 사실을 PC 메모리 상태가 관찰하지 못하는 경우 둘째 줄은 이전 값에 머물 수 있다. 일반 셸 명령은 OSC `lastCommand`로 수렴한다. 이 한계 때문에 민감 입력을 포함하는 새 backend 계약은 추가하지 않는다.
- store/summary 계산 단위 테스트, Desktop component/input 통합 테스트, Rust 설정/Remote contract와 Playwright layout 테스트가 기본 모드·두 배치·과거 통합 상태 행 부재를 고정한다.
