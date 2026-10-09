# 0307. 재결합할 때 데몬이 화면을 다시 그린다

- Status: Proposed
- Date: 2026-10-09
- Source: [ADR-0301](0301-pty-daemon-default-adoption.md) Consequences "화면", [ADR-0303](0303-pty-daemon-mode-tracking-and-adoption-preamble.md), [PTY 데몬 후속 계획](../pty-daemon/followup-plan.md) §3.6 단계 F
- 정정: [ADR-0300](0300-detached-pty-daemon-core.md)과 ADR-0303의 데몬 책임 범위("PTY와 그 출력에서 도출한 모드 상태")

## Context

재결합(ADR-0301)은 replay 없는 attach이고, 새 GUI의 화면은 비어 있다. ADR-0303으로 모드는 복원되지만 셀 내용은 앱이 다시 그릴 때까지 비어 있다.

dev 실기에서 실제로 측정한 결과는 다음과 같다.

- PowerShell 셸 pane은 재결합 뒤 프롬프트까지 비어 있다. 번들 ConPTY(ADR-0067)는 resize 때 화면을 다시 칠하지 않고, PSReadLine은 크기 변화만으로는 프롬프트를 다시 그리지 않는다.
- 같은 크기로 resize를 두 번 보내 앱이 다시 그리도록 유도해도(Superset v2 방식의 nudge) PowerShell pane은 비어 있었다. Codex는 nudge가 없어도 다시 그렸다.
- Codex 0.128+는 SIGWINCH를 받을 때마다 전체 transcript를 다시 출력한다(ADR-0038 관련 메모). 그래서 nudge는 오히려 중복 출력 위험만 늘린다.

GUI가 crash하기 전 출력은 이전 GUI에만 전달됐다. 데몬 backlog에는 client가 없던 동안의 출력만 남으므로, backlog replay로는 이전 화면을 복원할 수 없다.

레퍼런스는 다음과 같다.

- VS Code ptyHost·Orca·Superset v1: 호스트가 headless xterm으로 화면 모델을 유지하고, 붙을 때 SerializeAddon snapshot을 보낸다.
- Superset v2: 화면을 합성하지 않고 정확한 seq catch-up과 resize nudge를 쓴다. 그러나 laymux에서는 위 측정처럼 nudge가 셸을 복원하지 못했다.
- tmux·WezTerm: 서버가 grid를 소유한다.

## Decision

**데몬 세션은 PTY 출력으로 화면 모델(`vt100`)을 유지하고, replay 없는 attach에서는 모드 preamble(ADR-0303) 뒤에 현재 화면을 그리는 바이트를 첫 출력으로 보낸다.**

- **화면 모델.**
  - 세션마다 `vt100::Parser`를 둔다. scrollback은 0이고 크기는 PTY 크기다. spawn할 때 크기를 정한다. resize는 PTY에 적용하기 전에 새 크기를 기록하고(실패하면 되돌린다), 모델은 sink lock 안에서 그 뒤 출력을 parse하기 직전에 그 크기를 적용한다. resize가 멈춘 client 때문에 sink lock을 기다리지 않게 하기 위해서다.
  - 출력은 attach 여부와 상관없이 모두 이 모델을 거친다.
  - **모델은 세션을 멈추게 할 수 없다.** `vt100` 0.16은 일부 resize 뒤 쓰기에서 panic한다(좁아진 grid가 자른 wide 문자 위에 쓰기, 1행 grid의 줄바꿈). 모델 호출은 모두 `catch_unwind`로 감싸고, panic한 모델은 같은 크기의 빈 모델로 바꾼다. 그래서 sink lock이 poison되지 않고 PTY 출력 중계는 계속된다. 모델 크기는 최소 2×2이고, 0 크기의 spawn·resize는 거부한다.
  - 크기를 바꾸기 전에 터미널처럼 보정한다. 행이 줄면 main 화면의 위쪽을 밀어 올려 커서 행을 남긴다(`vt100`은 아래 행을 버려 셸 프롬프트를 잃는다). 이때 scroll region과 origin mode는 해제한다. 열이 줄면 새 마지막 열에 걸려 반으로 잘릴 wide 문자를 지운다(`vt100`은 앞 절반을 남겨, redraw의 이후 행이 한 줄씩 밀리고 그 셀에 다시 쓰면 panic한다).
  - 보정 바이트는 화면 사본을 담은 새 parser에서 처리한 뒤 화면만 되돌린다. resize는 두 PTY read 사이에 오므로 원래 parser는 escape sequence나 UTF-8 문자의 중간에 있을 수 있고, 그 상태를 건드리지 않기 위해서다.
  - PTY가 이미 그 크기면 resize를 건너뛴다(자식에게 크기 변경 신호만 보낸다). resize가 거부되면 PTY가 아직 가진 크기를 모델에 기록한다.
- **redraw.** 내용은 `contents_formatted()`(화면 지우기, 셀·속성, 커서 숨김 상태)와 `cursor_state_formatted()`(커서 위치·표시)로 만든다.
  - **OSC와 device query는 넣지 않는다.** 셀, 속성, 커서, 모드 설정만 담는다. 그래서 GUI의 OSC 단일 패스(ADR-0001)가 업무 이벤트를 다시 처리하지 않고, xterm이 응답할 것도 없다(ADR-0068).
  - 순서는 alt screen 진입, redraw, 나머지 모드(ADR-0303), 커서 표시 여부, 그다음 live 출력이다. redraw는 새 터미널의 autowrap과 replace 모드를 전제로 그리므로(`vt100`은 DECAWM을 처리하지 않아 wrap된 행을 자동 줄바꿈에 맡긴다), 그 모드를 바꾸는 `?7l`·IRM은 redraw 뒤에 온다. 커서 표시는 모드 추적 결과로 마지막에 명시한다(DECSTR 뒤 xterm.js는 커서를 보이고 `vt100`은 숨긴 채로 둔다).
  - 모델과 모드가 활성 버퍼를 다르게 볼 때(`vt100`이 무시하는 `?1047`)는 redraw 없이 모드만 복원한다. main 화면을 alt 버퍼에 그리지 않기 위해서다.
  - 모두 sink lock 안에서, 한 frame 한도를 넘지 않게 나눠 보낸다(true color로 가득 찬 화면은 수백 KB다).
- **크기.** 재결합하는 GUI는 attach 요청에 자기 grid 크기를 싣는다. 데몬은 adoption을 확정한 뒤 PTY와 모델을 그 크기로 바꾸고 나서 redraw를 만든다. redraw는 절대 좌표로 그리므로 GUI grid와 크기가 다르면 행이 접히고 커서가 엇나간다. 이 필드는 선택이라 이전 빌드 데몬은 무시하고, GUI는 attach 뒤에도 resize를 보낸다.
- **보존 범위.** 지금 보이는 화면만 복원한다. alt screen이 활성이면 alt 화면이 복원되고, 그 뒤의 main buffer와 scrollback은 복원하지 않는다.
- **resize nudge는 쓰지 않는다.** 위 측정에서 셸 복원에 효과가 없었고 Codex 중복 출력 위험이 있다.
- **책임 경계.**
  - 데몬은 출력을 해석해 "PTY, 모드, 보이는 화면"까지 소유한다. 출력 바이트는 그대로 중계하고, OSC 해석·응답·업무 상태는 여전히 GUI가 맡는다.
  - ADR-0303의 "모드만 추적"을 이 범위로 넓힌다.

## Alternatives Considered

- **resize nudge(Superset v2):** 같은 크기로 resize를 보내 앱이 다시 그리게 하는 방식이다. 위 측정대로 PowerShell 셸에는 효과가 없었고, Codex는 nudge 없이도 다시 그렸다. SIGWINCH마다 transcript를 다시 출력하는 앱에는 중복 위험이 있다.
- **backlog raw replay + replay guard(Orca):** 재결합 대상 GUI가 원래 보던 화면은 backlog에 없다. replay에 섞인 query와 OSC는 GUI 쪽 guard로 막아야 하는데, 이 guard는 출력 delivery 계약(sequence·credit) 전반에 손을 대야 한다.
- **GUI가 마지막 화면을 저장했다가 복원:** crash한 GUI는 마지막 화면을 저장하지 못할 수 있다. 데몬만 crash 이후 출력까지 본다.
- **xterm headless(Node) 사용:** Rust 데몬에 Node 런타임이 필요하다. `vt100`은 laymux가 이미 usage probe와 Codex status probe에서 쓰는 crate다.

## Consequences

- 재결합한 셸 pane에 프롬프트와 이전 화면이 다시 보인다. TUI는 화면이 복원된 뒤 스스로 다시 그리면 그 내용으로 덮인다.
- 데몬은 모든 출력을 `vt100`으로 한 번 더 parse한다. 비용은 출력량에 비례하고, 세션마다 화면 한 장 분량의 메모리가 든다.
- `vt100`과 xterm.js의 시맨틱 차이로 일부 화면이 정확히 같지 않을 수 있다. 그래도 화면이 비어 있는 것보다 낫다. 차이가 문제가 되면 reflow를 지원하는 모델(`alacritty_terminal` 등)로 바꾸는 것을 검토한다. 확인된 차이는 다음과 같다.
  - 폭이 줄면 xterm.js는 wrap된 행을 reflow하지만 `vt100`은 오른쪽 열을 버린다. 폭을 줄인 뒤 재결합하면 그 행의 잘린 부분은 복원되지 않는다.
  - SGR: 밑줄 색(`58;5;n`, `58;2;…`)을 다른 속성으로 잘못 읽고, 취소선(9)과 밑줄 모양(`4:3`)을 버린다.
  - pending-wrap 상태(마지막 열에 쓴 직후)에서는 `cursor_state_formatted`가 마지막 셀을 다시 그린 뒤 SGR을 초기화한다. 다음 출력이 SGR 없이 이어지면 속성이 기본값으로 보인다.
- scrollback 복원은 하지 않는다. 필요하면 별도로 결정한다. GUI의 출력 캐시 복원(restoreOutput)은 재결합과 별개로 실행되므로, 캐시된 이전 출력은 scrollback에 남고 redraw는 그 아래 보이는 화면을 지우고 다시 그린다.
- alt screen에 있는 동안 행이 줄면 main 화면의 보정은 하지 않는다. 그래서 그 뒤 main 화면으로 돌아오면 아래 행이 잘려 있을 수 있다. 앱이 alt screen을 나가며 다시 그리는 경우가 많다.
- 검증:
  - 세션 수준 테스트: replay 없는 attach의 첫 data를 parse하면 놓친 화면과 커서가 나오고, OSC와 query가 없다. `?7l`·IRM은 redraw 뒤에 오고, alt screen은 진입 뒤에 그려지며, DECSTR 뒤 커서 표시가 모드를 따른다. 큰 redraw는 여러 frame으로 나뉜다.
  - 모델 테스트: wide 문자 + 폭 축소 + 덮어쓰기, 1행·0 크기에서 panic 없이 계속 동작한다. 행이 줄면 프롬프트 행이 남는다.
  - 기존 모드 preamble 테스트.
  - dev 실기: crash 뒤 PowerShell 프롬프트와 Codex 화면 복원. A/B로 main 빌드에서 비어 있는 것과 비교한다.
