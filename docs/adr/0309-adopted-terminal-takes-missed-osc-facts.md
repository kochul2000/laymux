# 0309. 재결합한 GUI가 놓친 출력의 OSC 사실을 단일 패스로 처리한다

- Status: Proposed
- Date: 2026-10-09
- Source: [PTY 데몬 후속 계획](../pty-daemon/followup-plan.md) §3.7 단계 G, [ADR-0001](0001-osc-rust-single-pass.md), [ADR-0303](0303-pty-daemon-mode-tracking-and-adoption-preamble.md), [ADR-0307](0307-pty-daemon-adoption-screen-redraw.md)

## Context

GUI가 없는 동안(crash, 업데이트 설치)에도 데몬 세션의 셸과 에이전트는 계속 출력한다. 데몬은 그 출력을 최근 1 MiB까지 backlog로 보관한다. 그런데 재결합은 replay 없는 attach이고, backlog는 버린다(ADR-0303). backlog를 그대로 xterm에 흘리면 그 안의 device query에 xterm이 다시 답하기 때문이다. 화면은 ADR-0307의 redraw로 복원되지만, redraw에는 OSC가 없다. 그래서 GUI가 없는 동안 나온 OSC 사실은 모두 사라진다.

- OSC 0/2 title: Claude·Codex·Grok의 title 상태 기계와 interactive app 판정이 다음 title까지 옛 상태에 머문다.
- OSC 7, 9;9 CWD: 재결합한 터미널의 CWD는 요청된 시작 디렉터리로 시작해 다음 OSC 7까지 틀린 값이다.
- OSC 133: 명령 상태(실행 중/성공/실패)가 갱신되지 않는다.
- OSC 9/99/777 알림: 사용자가 없는 동안 온 알림이 사라진다.

에이전트 훅 이벤트도 GUI가 없는 동안에는 전달되지 않는다. 다만 훅 처리 계약이 실시간을 전제로 한다. 수신은 30초보다 오래된 이벤트를 거절하고, 상태 판정은 60초 안의 phase만 신뢰한다. GUI가 없는 동안에는 사용자가 에이전트에 입력할 수 없으므로 대화 전환도 일어나지 않는다. 재결합 뒤 다음 훅이 상태를 다시 세운다.

레퍼런스는 다음과 같다.

- Orca: 숨은 pane의 알림성 OSC fact를 데몬이 미리 뽑아 순서대로 보낸다. 앱이 없을 때 온 훅은 잃는다.
- VS Code ptyHost: headless shell integration이 명령 상태를 구조화해 넘긴다.
- tmux: hook과 alert가 서버에서 돈다.

## Decision

**재결합하는 GUI는 놓친 출력(데몬 backlog)을 렌더링하지 않고, GUI의 Rust OSC 단일 패스에만 통과시킨다. 데몬은 OSC를 해석하지 않는다.**

- **wire.** attach 요청에 선택 필드 `missedOutput`을 둔다. 이 필드가 있고 replay가 없으면, 데몬은 `Attached` 다음에 `missedOutputBegin`, backlog data frame들, `missedOutputEnd`를 보내고 나서 redraw를 보낸다. 이 필드를 모르는 이전 build 데몬은 무시하고 지금처럼 backlog를 버린다. 순서는 모두 sink lock 안에서 정해지므로 놓친 출력은 항상 redraw와 live 출력보다 앞선다.
- **GUI 수신.** 데몬 client는 두 표지 사이 data의 바이트 수를 출력 스트림과 함께 센다. 터미널 출력 callback은 받은 바이트 중 그 수만큼을 "놓친 출력"으로 떼어 낸다. 스트림 순서가 그대로이므로 놓친 부분과 live 부분의 경계가 정확하다.
- **등록 전에는 기다린다.** 놓친 출력은 attach 즉시 도착하는데, 그때는 터미널이 아직 상태 표(`AppState.terminals`)에 등록되기 전이라 OSC 사실을 반영할 곳이 없다. 그래서 재결합을 시도하는 터미널은 OSC 단일 패스를 등록이 끝날 때까지 막아 두고, 그 사이 출력을 놓친 것과 live 순서대로 모았다가 등록 직후 차례로 처리한다. 화면 출력(ring·delivery)은 기다리지 않는다.
- **놓친 출력의 처리.**
  - xterm에 보내지 않고, ring·delivery·`TerminalProtocolState`·startup query guard·출력 activity 이벤트도 거치지 않는다. 그래서 그 안의 query에 아무도 다시 답하지 않는다(ADR-0068).
  - OSC 단일 패스(ADR-0001)는 그대로 돈다. title 상태 기계, CWD, OSC 133 명령 상태, OSC hook preset이 live 출력과 같은 코드로 처리된다.
  - 예외는 `SyncCwd`다. 같은 sync group의 다른 터미널에 `cd`를 입력하므로, 지나간 CWD 변경으로 지금 다른 pane을 움직이지 않는다. 자기 터미널의 CWD는 갱신한다.
  - OSC 알림은 늦게라도 전달한다. 사용자가 없는 동안 온 알림이기 때문이다.
- **범위.** backlog가 1 MiB를 넘어 앞부분이 버려졌으면(`droppedBytes`) 그 부분의 사실은 잃는다. backlog 처음에서 잘린 OSC sequence도 버린다.
- **훅 이벤트는 저장하지 않는다.** 위 Context의 실시간 계약을 바꾸지 않는다. 재결합 뒤 다음 훅이 상태를 세운다.

## Alternatives Considered

- **데몬이 OSC fact를 뽑아 journal로 보관(Orca):** ADR-0001의 단일 패스를 데몬과 GUI로 나눈다. 같은 OSC 해석이 두 곳에 생긴다.
- **backlog를 xterm에 replay하고 query 응답만 막기:** 이미 redraw로 그린 화면 위에 같은 출력이 다시 그려진다. query 응답을 막으려면 delivery 계약 전반에 guard가 필요하다(ADR-0303, ADR-0307의 기각 사유).
- **훅 이벤트 spool:** 훅 수신의 30초 freshness와 60초 phase 신뢰 창을 늦은 이벤트에 맞게 다시 정해야 한다. 그런데 사용자가 없는 동안에는 대화가 바뀌지 않으므로 얻는 것이 적다.

## Consequences

- 재결합 직후 title 기반 에이전트 상태, CWD, 명령 상태가 GUI가 없던 동안의 마지막 값으로 맞춰진다. 그동안 온 OSC 알림도 받는다.
- 놓친 출력은 최대 1 MiB이고, 재결합 때 한 번 OSC 파서를 거친다.
- 이전 build 데몬의 세션(ADR-0308)은 이 필드를 모르므로 지금처럼 놓친 OSC를 잃는다.
- 검증:
  - 데몬 세션 테스트: `missedOutput` 요청 시 표지 사이에 backlog가 오고 그 뒤에 redraw가 오며, 요청이 없으면 지금처럼 버린다.
  - client 테스트: 표지 사이 바이트 수가 정확히 집계된다.
  - GUI 테스트: 놓친 부분은 delivery에 들어가지 않고 OSC 사실(title·CWD·알림)은 처리되며, `SyncCwd`는 다른 터미널에 쓰지 않는다.
  - dev 실기: GUI를 끈 동안 셸에서 `cd`와 OSC 9 알림을 내고, 재결합 뒤 CWD와 알림이 반영되는지 확인한다.
