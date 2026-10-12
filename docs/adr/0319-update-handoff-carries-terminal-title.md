# 0319. 업데이트 인계는 터미널의 마지막 title을 새 GUI에 넘긴다

- Status: Accepted
- Date: 2026-10-12
- Source: 사용자 신고("업데이트 이후 상태 표시는 —인데 Remote Alt+L이 terminal is busy로 거절된다"), [ADR-0308](0308-pty-daemon-generations-across-updates.md), [ADR-0309](0309-adopted-terminal-takes-missed-osc-facts.md), [ADR-0158](0158-activity-aware-single-pane-clear.md)
- 보완: ADR-0309 Context의 "다음 title까지 옛 상태에 머문다"

## Context

업데이트 뒤 새 GUI는 데몬 세션을 다시 붙이고(ADR-0308), GUI가 없는 동안의 출력은 OSC 단일 패스로만 처리한다(ADR-0309). 그런데 에이전트가 **인계 전에** 설정한 title은 이전 GUI가 이미 받아 갔으므로 놓친 출력(backlog)에 없다. redraw에도 OSC가 없다(ADR-0307).

대기 중인 Claude는 새 title을 내지 않는다. Claude의 대기 상태를 알려 주는 신호는 `✳` title 하나뿐이고, 훅 관찰은 60초가 지나면 만료되며 다음 턴이 시작돼야 다시 온다(ADR-0309 Context). 그래서 업데이트 직후 대기 중인 Claude pane은 다음 턴까지 작업 상태가 "모름"이다.

- 상태 표시는 "—"이다.
- 실제 clear(ADR-0158)는 상태를 모르는 Claude·Codex·Grok을 작업 중일 수 있다고 보고 건너뛴다. 이때 사유를 `busy`로 보고해서 Remote에 "the terminal is busy"가 떴다. 실제로는 작업 중이라는 관찰이 없었다.

## Decision

**업데이트로 데몬 세션을 넘기는 GUI는 에이전트가 실행 중인 터미널마다 마지막 OSC 0/2 title을 남기고, 같은 세션을 다시 붙인 GUI는 그 title을 놓친 출력의 맨 앞에 두고 처리한다.**

- **기록.** GUI의 OSC 패스는 터미널마다 마지막 OSC 0/2 title을 `TerminalSession.osc_title`에 둔다. live 출력과 놓친 출력의 title 모두 기록한다.
- **인계 대상.** 백엔드 activity 판정이 Claude·Codex·Grok 실행 중인 데몬 터미널만 넘긴다. 종료 title 없이 끝난 에이전트의 title이 `osc_title`에 남아 있어도, 셸 pane을 새 GUI에서 에이전트로 잘못 분류하지 않게 하기 위해서다.
- **인계.** 업데이트 인계를 시작하는 세 경로(Windows 설치기 teardown, Linux 재시작, dev `update-handoff`)가 `{terminalId, childPid, title}`를 cache 디렉터리의 `update-handoff-titles.json`에 쓴다.
  - 대상과 pid는 인계 표시 직후, PTY handle을 정리하기 전에 고른다.
  - title은 프로세스가 끝나기 직전에 그 시점 값으로 쓴다. Windows teardown은 handle 정리 뒤 설치 디렉터리가 풀리기를 최대 10초 기다리는데, 분리된 세션은 그동안에도 이전 GUI에 출력을 보내므로 그 사이 바뀐 title은 backlog에 남지 않기 때문이다.
  - 설치가 실패해 인계를 취소하면 파일을 지운다.
- **적용.**
  - 새 GUI는 시작할 때 파일을 한 번 읽고 바로 지운다. 재결합이 하나도 없어도 지우므로, 남은 파일이 나중의 무관한 재결합에 쓰이지 않는다.
  - 재결합한 터미널의 id와 자식 pid가 모두 같을 때만 title을 꺼낸다. 다른 자식(재결합이 거절돼 새로 띄운 자식)에는 적용하지 않는다.
  - 꺼낸 title은 `OSC 2` sequence로 만들어 OSC gate가 모아 둔 출력의 맨 앞에 놓친 출력으로 넣는다. 놓친 출력은 그 자식이 인계 뒤에 낸 출력 전부이므로, 인계 시점의 title을 맨 앞에 두면 출력 순서가 실제와 같다. 그 뒤에 title이 바뀌었으면 놓친 출력의 title이 덮어쓴다.
  - title은 live title과 같은 코드로 처리된다. title 상태 기계, interactive app 판정, `terminal-title-changed` 이벤트를 거치고, 프론트는 Claude `✳` title을 대기 상태 관찰로 받는다.
- **실제 clear의 사유.** 작업 상태가 관찰된 적 없는 Claude·Codex·Grok(출력도 활발하지 않음)은 계속 건너뛰지만, 사유를 `stateUnknown`으로 보고한다. Remote는 "the agent's state is not known yet"으로 표시한다. 작업 중이라는 관찰이 있거나 출력이 활발하면 지금처럼 `busy`다. 셸의 판정과 사유는 바꾸지 않는다.
- **데몬은 바꾸지 않는다.** 데몬은 세대마다 따로 살아 있고(ADR-0308), 이미 실행 중인 이전 세대 데몬의 세션에도 적용되어야 하기 때문이다.

## Alternatives Considered

- **데몬이 화면 모델에서 title을 추적해 재결합 때 넘기기:** crash 재결합까지 덮는다. 하지만 이전 세대 데몬이 실행 중인 세션에는 적용되지 않는다. 그 세션들은 사용자가 pane을 닫을 때까지 이전 세대 데몬에 남는다. 이번 결함은 업데이트 인계에서 생기므로, 업데이트하는 GUI가 넘기는 쪽이 모든 세션에 적용된다.
- **훅 관찰 registry를 인계:** 훅 관찰은 60초 신뢰 창을 지나면 쓰지 않는다(ADR-0309). 대기 중인 에이전트의 마지막 훅은 대개 그보다 오래되었다.
- **프론트의 작업 상태를 저장했다가 복원:** 작업 상태는 관찰에서 파생된 값이다. 복원한 값은 관찰 순서와 sequence 계약 밖에 있다. title은 원래 관찰 입력이라 같은 경로로 다시 처리하면 된다.
- **상태를 모르는 에이전트도 clear 허용:** 작업 중인 에이전트에 `/clear`를 보낼 수 있다. 실제 clear는 작업을 보호하는 쪽을 택한다([ADR-0137](0137-workspace-clear-ctrl-l-broadcast.md)).

## Consequences

- 업데이트 직후에도 대기 중인 Claude pane은 `✳` title로 대기 상태가 확정되어 실제 clear가 바로 된다. 작업 중이던 pane은 spinner title로 작업 중이 된다.
- **이 결정을 가진 GUI에서 업데이트할 때부터 적용된다.** 인계 파일은 업데이트를 설치하는 이전 GUI가 쓰기 때문이다. 그 전 버전에서 업데이트한 직후에는 상태가 여전히 "모름"이고, clear 사유만 `stateUnknown`으로 보인다.
- crash 뒤 재결합에는 인계 파일이 없으므로 적용되지 않는다.
- title을 쓴 뒤 프로세스가 끝나기까지(설치기 실행) 바뀐 title은 이전 GUI가 받아 가므로 잃는다. 이 구간은 설치기를 띄우는 짧은 시간이다.
- 백엔드 activity 판정이 실패하면(등록 중인 터미널의 출력 ring이 없을 때 등) title을 넘기지 않는다. 그 경우는 이 결정 전과 같이 "모름"이다.
- 검증:
  - Rust 단위 테스트: Claude·Codex·Grok만 인계 대상이다. title이 없거나 사라진 터미널은 넘기지 않는다. 인계 파일은 한 번만 읽히고 지워진다. 다른 터미널 id나 다른 pid에는 적용되지 않는다. 깨진 파일은 무시한다. 만든 sequence가 같은 title로 다시 parse된다. gate는 인계된 title을 이미 모은 출력 앞에 두고, 열린 뒤에는 넣지 않는다.
  - 프론트 단위 테스트: 관찰되지 않은 Claude·Codex·Grok의 skip 사유는 `stateUnknown`, 출력이 활발하면 `busy`다.
  - dev 실기: Claude pane을 대기 상태로 두고 `POST /api/v1/dev/update-handoff`로 재시작한 뒤, 재결합한 pane의 작업 상태가 대기로 확정되고 실제 clear가 되는지 확인한다.
