# 0141. ConPTY 초기 DA 응답은 질의가 증명된 replay 예외로 전달한다

- Status: Proposed
- Date: 2026-08-09
- Source: 사용자 재현 요청 및 dev 실측; [architecture/data-flow.md §8.8](../architecture/data-flow.md); [ADR-0054](0054-xterm-human-and-protocol-data-origin.md); [ADR-0068](0068-remote-terminal-query-single-responder.md)
- Relation: ADR-0054의 일반 replay 응답 폐기 원칙과 ADR-0068의 PC xterm 단일 responder 원칙을 유지하면서, Windows PTY 생성 직후의 Primary Device Attributes 교환에만 generation-local 예외를 추가한다. 기존 ADR을 대체하지 않는다.

## Context

Windows dev에서 새 PowerShell·WSL pane을 열자 외부 shell 프로세스는 약 0.14~0.20초 안에 시작했지만 prompt는 약 3.3초 뒤에 나타났다. 그 전에 입력한 문자는 사라진 것이 아니라 prompt가 열린 뒤 한꺼번에 반영됐다. xterm parse 시간은 대부분 0.1ms 수준이었으므로 renderer 우선순위 전환이나 긴 parse가 직접 원인이 아니었다.

PTY 생성 직후 ConPTY가 보낸 `ESC[c` Primary Device Attributes 질의는 desktop output attach가 완료되기 전 output ring에 들어가 23-byte 최초 snapshot의 일부가 됐다. visible xterm은 snapshot을 정상 파싱해 고정 버전의 응답 `ESC[?1;2c`를 만들었지만, ADR-0054에 따라 `replay` 중 생긴 모든 protocol reply를 폐기했다. 따라서 ConPTY는 응답을 받지 못한 채 startup wait가 끝날 때까지 입력과 prompt 진행을 지연했다. 같은 generation에 수동 응답을 약 0.5초에 주입하면 PowerShell과 WSL prompt가 약 0.70~0.75초에 준비됐다.

일반 cache·snapshot replay는 과거 질의를 다시 파싱할 수 있다. 그 응답을 모두 PTY로 돌려보내면 이미 끝난 TUI 질의의 바이트가 현재 shell 입력으로 들어갈 수 있으므로 ADR-0054의 suppression을 해제할 수 없다. 반대로 Rust가 DA 응답을 합성하면 terminal capability responder와 renderer state의 소유권이 xterm과 backend로 갈라진다. 필요한 것은 Windows PTY 생성 직후 실제 current-generation 질의가 관측됐고 아직 live 응답이 소유권을 갖지 않은 경우에 한해 최초 attach replay가 만든 정확한 xterm 응답 한 번을 전달하는 경계다.

범위는 Windows desktop의 새 PTY generation과 visible xterm 최초 attach 사이의 Primary DA 교환이다. 일반 replay 응답, Remote browser responder, human input 권한, xterm capability 값의 Rust 합성, 다른 CSI·OSC 질의는 비목표다.

## Decision

**Windows PTY 생성 직후 실제 `ESC[c` 질의가 증명된 current generation에만, replay가 만든 정확한 xterm Primary DA 응답 `ESC[?1;2c` 한 번을 보호된 backend 경로로 전달한다.**

- Windows에서 새 `PtyHandle`을 만들 때 generation-local bootstrap DA guard를 arm한다. output callback은 desktop publish보다 먼저 raw PTY byte stream에서 exact `ESC[c`를 chunk 경계에 걸쳐 관측한다. catalog의 id-only 상태나 화면 문자열로 질의를 추정하지 않는다.
- visible xterm의 일반 `replay` protocol reply suppression은 유지한다. 다만 replay parse context가 current attach generation을 갖고 있고 응답 전체가 고정 xterm의 exact `ESC[?1;2c`일 때만 전용 `write_terminal_bootstrap_protocol_reply(id, generation, data)` Tauri command에 제안한다. cache·snapshot의 다른 reply는 계속 폐기한다.
- backend가 최종 증명 경계다. command는 current `PtyHandle`의 generation 일치, exact query 관측, exact response, arm 또는 query 관측 뒤 2.5초 이내, one-shot 미소비를 모두 만족할 때만 PTY FIFO에 쓴다. 틀린 byte, 미관측·만료·중복·stale generation, Windows가 아닌 handle은 쓰지 않고 fail-closed한다.
- 같은 query가 최초 attach 전에 이미 live delta로 파싱되면 기존 `write_terminal_protocol_reply`가 authoritative responder다. exact live DA reply는 bootstrap one-shot을 PTY write 전에 claim해, 빠른 재attach와 경합해도 같은 generation에 중복 응답하지 않는다.
- guard의 mutex 실패는 오류로 처리하고 output 관측 오류는 generation당 한 번 기록한다. reply write가 실패해도 one-shot을 다시 열거나 재전송하지 않는다. IPC 실패가 PTY 미수락을 증명하지 못하기 때문이다.
- Rust는 응답을 합성하거나 xterm 상태를 복제하지 않는다. exact response 값은 고정 xterm 버전의 계약 테스트가 고정하고, xterm 업그레이드 때 함께 재검토한다. Automation·Remote HTTP/MCP 계약은 추가하지 않는다.

## Alternatives Considered

### 모든 replay protocol reply를 허용한다

현재 snapshot에는 오래전에 끝난 query가 포함될 수 있다. DA 외의 DSR·색상·mode reply까지 현재 PTY input에 다시 넣으면 shell 또는 TUI의 일반 입력으로 소비될 수 있어 ADR-0054의 origin 경계를 깨뜨린다.

### Rust가 `ESC[?1;2c`를 즉시 합성한다

startup latency는 줄지만 xterm이 소유한 terminal capability responder를 backend가 복제한다. xterm 옵션·버전이 바뀌면 두 responder가 어긋나며, renderer가 정상 live 응답한 경우 중복도 생긴다.

### PTY spawn을 desktop attach 준비 뒤로 미룬다

output 유실 창을 없애는 대신 terminal create를 frontend 준비와 결합한 2단계 프로토콜로 바꾸고, lazy pane·Remote attach·startup slot의 책임 경계를 확대한다. 현재 output ring snapshot은 attach 전 output 보존이라는 본래 목적을 정상 수행하고 있으므로 한 startup handshake 때문에 생성 계약 전체를 바꾸는 비용이 크다.

### 입력만 prompt 준비까지 막거나 renderer 우선순위를 높인다

입력 차단은 지연을 숨길 뿐 prompt를 빠르게 만들지 못한다. 실측상 xterm parse는 대부분 0.1ms 수준이고 query가 이미 replay suppression에서 제거됐으므로 render scheduling 우선순위로는 누락된 reply를 복구할 수 없다.

## Consequences

- 새 Windows PowerShell·WSL pane은 ConPTY의 수 초 startup wait를 채우지 않고 prompt와 초기 입력을 정상 진행할 수 있다.
- 일반 replay suppression, PC xterm 단일 responder, Remote human-control gate는 그대로 유지된다. 허용 범위는 current-generation의 exact query·exact response·2.5초·one-shot 교집합뿐이다.
- `PtyHandle`마다 Windows startup 동안 작은 guard 상태와 exact byte scanner가 추가되고, 최초 snapshot에서 해당 응답이 생기면 전용 IPC 한 번이 추가된다. 만료되거나 live reply가 먼저 오면 이후 경로는 atomic inactive 확인만 한다.
- attach snapshot의 generation이 visible replay write metadata까지 보존되어야 한다. 컴포넌트 테스트는 replay source와 generation이 함께 있을 때만 보호 command가 호출되고 human/live 경로로 새지 않음을 고정한다. Rust 테스트는 split query, wrong·unobserved·expired data, stale generation, one-shot 및 live/replay 경합을 고정한다.
- xterm Primary DA 응답 형식이나 ConPTY startup handshake가 바뀌면 exact matcher가 조용히 허용 범위를 넓히지 않고 fail-closed한다. 해당 버전 업그레이드 시 실기동 trace와 screen/컴포넌트 계약을 다시 확인하고, ConPTY가 attach 전 질의를 더 이상 만들지 않으면 이 예외를 제거한다.
