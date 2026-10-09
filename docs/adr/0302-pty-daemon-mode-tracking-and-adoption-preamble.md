# 0302. PTY 데몬의 터미널 모드 추적과 재결합 preamble

- Status: Proposed
- Date: 2026-10-09
- Source: #1151, [ADR-0301](0301-pty-daemon-default-adoption.md) Consequences "터미널 모드", [PTY 데몬 후속 계획](../pty-daemon/followup-plan.md) §3.1 단계 A, [data-flow §8.23](../architecture/data-flow.md)
- 정정: [ADR-0300](0300-detached-pty-daemon-core.md) "데몬은 PTY만 소유한다"의 범위

## Context

ADR-0301은 재결합할 때 backlog를 replay하지 않는다. 그래서 새 GUI의 Rust `TerminalProtocolState`와 xterm.js는 기본 모드에서 시작한다. 그런데 앱은 crash 이전에 켜 둔 모드를 다시 보내지 않는다.

- Codex·Claude 같은 TUI는 bracketed paste(`?2004h`)를 시작할 때 한 번만 켠다. 재결합한 pane에서는 GUI가 bracketed paste를 꺼진 것으로 알고 여러 줄 입력을 그냥 보낸다. 그러면 줄바꿈마다 Enter로 처리되어 프롬프트가 중간에 제출된다. MCP `write_to_terminal`, Remote 입력, 붙여넣기가 모두 해당한다.
- DECCKM(`?1`)이 어긋나면 커서 키 인코딩이 틀어진다. 마우스 추적·인코딩, 포커스 보고, 커서 표시, alt screen도 실제 앱 상태와 어긋난다.
- 셸은 prompt마다 모드를 다시 켜므로 곧 회복된다. 장기 실행 TUI는 회복되지 않는다.

모드 상태는 앱이 출력으로 보낸 DECSET/DECRST에서만 알 수 있다. GUI가 없는 동안의 출력은 데몬만 본다. 따라서 데몬이 모드 상태를 알고 있어야 한다.

레퍼런스는 다음과 같다.

- Superset v2: 데몬 `TerminalModes` 스캐너 + attach preamble.
- Orca: rehydrate sequences.
- VS Code: SerializeAddon `_serializeModes`.
- tmux·zellij·WezTerm: 서버가 pane 모드를 소유한다.

모두 "출력 스트림을 보는 쪽이 모드를 추적하고, 다시 붙을 때 그 상태를 단언한다"는 같은 방식이다. Superset은 ELv2이므로 설계만 참고하고 코드는 독자적으로 작성한다.

범위:

- 재결합(adopt, replay 없는 attach) 시 모드 복원.
- 화면 내용 복원과 backlog replay, replay 중 query 재응답 방지는 다루지 않는다(후속 계획 §3.6 단계 F).

## Decision

**데몬 세션은 PTY 출력에서 터미널 입력·표시 모드만 추적하고, replay 없는 attach에서는 기본값과 다른 모드를 단언하는 DECSET/DECRST 바이트(preamble)를 첫 출력으로 보낸다.**

- **추적 범위.** 출력 전체를 경량 상태기로 본다. 대상은 다음과 같다.
  - DEC private mode: 1(DECCKM), 7(autowrap), 25(커서 표시), 1004(focus), 2004(bracketed paste)
  - 마우스 추적: 9/1000/1002/1003 중 하나가 활성
  - 마우스 인코딩: 1005/1006/1015/1016 중 하나가 활성
  - alt screen: 47/1047/1049
  - ANSI IRM(4)
  - keypad: DECKPAM `ESC =` / DECKPNM `ESC >`
  - kitty keyboard flags: `CSI > n u` push, `CSI < n u` pop, `CSI = n ; m u` set. 스택 깊이에 상한을 둔다.
  - RIS(`ESC c`)는 모두 기본값으로 되돌린다. DECSTR(`CSI ! p`)는 soft reset 대상 모드를 되돌린다.
- **책임 경계.** 데몬은 모드를 "추적"만 한다.
  - OSC 해석, query 응답, 출력 변형, 화면 모델, DB·설정은 갖지 않는다.
  - 출력 바이트는 지금처럼 그대로 중계한다.
  - ADR-0300의 "데몬은 PTY만 소유한다"를 "PTY와 그 출력에서 도출한 모드 상태만 소유한다"로 정정한다. ADR-0001의 OSC 단일 패스는 바뀌지 않는다.
- **preamble.**
  - 기본값과 다른 모드만 담는다. 새로 만든 GUI 상태는 기본값이므로 같은 값을 다시 보낼 필요가 없다.
  - alt screen 진입을 먼저 보내고 나머지를 그 뒤에 보낸다. 마우스 추적과 인코딩은 각각 활성 레벨 하나만 켠다.
  - **query는 절대 넣지 않는다.** preamble이 응답을 유발하지 않으므로 재응답 문제가 생기지 않는다.
- **전달.**
  - 데몬은 preamble을 `Attached` 직후, 첫 live 출력보다 먼저 일반 data frame으로 보낸다. sink lock 안에서 보내므로 live 출력이 끼어들지 않는다.
  - GUI는 이를 일반 PTY 출력으로 처리한다. 그러면 Rust `TerminalProtocolState`(bracketed paste 인코딩)와 xterm이 같은 단일 패스로 같은 상태가 된다. GUI 코드와 wire 형식은 바뀌지 않는다.
- **replay 있는 attach에는 preamble을 붙이지 않는다.** backlog 자체가 모드를 다시 설정한다. 거기에 preamble을 더하면 `?1049h`처럼 부수효과가 있는 모드가 replay한 화면을 지울 수 있다. backlog가 잘려 앞부분 모드 설정을 잃은 경우의 처리는 단계 F에서 replay와 함께 정한다.

## Alternatives Considered

- **GUI가 모드를 몰라도 되게 서버 쪽에서 입력을 인코딩(tmux·zellij·WezTerm):** 근본적이지만 GUI의 입력 경로(structured input, xterm 키 인코딩) 전체를 데몬으로 옮겨야 한다. ADR-0001 이후 GUI가 소유해 온 책임을 대거 바꾸므로 지금 범위를 넘는다.
- **`Attached`에 구조화된 모드 필드를 싣고 GUI가 Rust 상태와 xterm에 따로 적용:** 두 상태를 각각 맞춰야 해서 어긋날 위험이 생긴다. 출력 delivery(sequence·credit)에 별도 경로가 필요하고 wire와 GUI가 모두 바뀐다. preamble 바이트는 기존 단일 패스를 그대로 쓴다.
- **headless VT 모델로 화면까지 snapshot(VS Code·Orca·Superset v1):** 화면 복원까지 해결하지만 비용이 크다. Superset v2는 이 방식에서 물러났다. 단계 F에서 replay 방식과 함께 판단하며, 모드 추적기는 그때도 재사용한다.
- **모든 모드를 켜짐·꺼짐 모두 단언(Superset식):** GUI가 기본값이 아닌 상태일 수 있을 때 안전하다. 그러나 재결합 대상 GUI는 항상 새로 만든 상태다. `?1049l`처럼 꺼짐 단언에도 부수효과가 있는 모드가 있으므로 기본값과 다른 모드만 보낸다.

## Consequences

- 재결합한 Codex·Claude pane에서도 여러 줄 입력이 bracketed paste로 들어간다. 커서 키·마우스·포커스·커서 표시가 실제 앱 상태와 맞는다.
- alt screen을 쓰는 앱은 재결합 뒤 빈 alt 화면에서 시작하며, 앱이 다시 그릴 때까지 비어 있다. 다시 그리기 유도(resize nudge)와 화면 복원은 단계 F에서 다룬다.
- 데몬은 출력 바이트마다 상태기를 한 번 더 돌린다. 분기만 있는 바이트 단위 상태기라 비용은 출력 중계에 비해 작다.
- mouse 1001(highlight tracking), 2026(synchronized output, 일시 상태), DECSCUSR(커서 모양), 색 팔레트는 추적하지 않는다. 필요해지면 이 ADR의 추적 범위를 확장하는 새 ADR로 다룬다.
- 검증: 모드 상태기 단위 테스트(chunk 경계, 상호 배타 레벨, RIS·DECSTR, kitty 스택)와 실제 셸 데몬 테스트(모드 설정 후 detach → adopt 첫 출력의 preamble → `TerminalProtocolState`가 bracketed paste를 켬)를 둔다.
