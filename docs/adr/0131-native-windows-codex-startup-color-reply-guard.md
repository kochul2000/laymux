# 0131. 네이티브 Windows Codex 복귀의 최초 색상 응답은 질의 관측에 결합해 차단한다

- Status: Accepted
- Date: 2026-08-03
- Source: 사용자 재현 보고, [Codex `terminal_probe.rs`](https://github.com/openai/codex/blob/8922a784/codex-rs/tui/src/terminal_probe.rs), [data-flow.md](../architecture/data-flow.md)의 terminal 출력·프로토콜 응답 경로, [ADR-0001](0001-osc-rust-single-pass.md), [ADR-0054](0054-xterm-human-and-protocol-data-origin.md), [ADR-0118](0118-codex-session-pid-attribution.md), [ADR-0125](0125-configurable-agent-launch-command.md)
- Relation: ADR-0001의 Rust PTY callback 소유권과 ADR-0054의 human/protocol origin 분리를 유지한다. ADR-0118·ADR-0125가 검증한 Codex 복귀 명령에 한정된 startup protocol 예외를 추가하며 기존 결정을 대체하지 않는다.

## Context

네이티브 Windows Codex는 TUI의 일반 입력 루프를 시작하기 전에 `ESC ] 10 ; ? ST`와 `ESC ] 11 ; ? ST`를 출력하고 Windows console input에서 전경색·배경색 응답을 최대 100ms 기다린다. 제한 안에 두 응답이 모이지 않으면 `GetConsoleScreenBufferInfoEx` 기반 기본색 조회로 fallback한다. 제한 뒤 도착한 terminal 응답은 일반 입력 루프가 키 입력으로 소비하므로 출력 가능한 부분인 `]10;rgb:...\]11;rgb:...\`가 composer에 들어간다.

laymux에서는 PTY output을 받은 xterm이 현재 terminal 색상으로 OSC 10/11 응답을 만들고, 출처가 확인된 live parser reply만 전용 backend 경로로 돌려보낸다. 이 구조에서 응답 시간은 ConPTY read뿐 아니라 desktop delivery, WebView scheduling, xterm parser backlog를 포함한다. 실제 Windows dev 재현에서 xterm 기본 전경색 `#f0f0f0`과 배경색 `#0c0c0c` 응답을 150ms 늦추자 사용자 보고와 같은 문자열이 composer에 들어갔다. 이어서 Codex 실행을 output attach 완료 뒤로 미루는 대안을 실험했지만, attach 뒤에도 query와 xterm reply 사이가 약 1.625초까지 벌어져 같은 오염이 재현됐다. attach 완료는 transport 준비를 뜻할 뿐 100ms 안의 parser 완료를 보장하지 않는다.

WSL Codex는 이 Win32 console probe 경로가 아니고 Claude Code에도 같은 startup probe가 없다. 모든 terminal 응답을 늦추거나 삭제하면 다른 TUI의 정상 protocol을 깨뜨리고, Rust가 색상값을 합성하면 renderer state를 소유한 xterm과 중복 responder가 된다. 사람 입력과 protocol reply가 같은 바이트를 가질 수 있으므로 ADR-0054의 origin 분류 전에는 문자열 필터를 둘 수 없다.

범위는 settings에서 다시 검증된 Codex 세션 복귀가 native Windows shell에서 native Windows Codex launcher로 시작할 때의 최초 색상 probe뿐이다. 바깥 shell이 PowerShell이어도 configured `codex.command`의 첫 실행 대상이 `wsl(.exe)`·`ssh(.exe)`이면 범위 밖이다. 일반 `codex` 실행, WSL·SSH·비-Windows host, Claude, viewer, profile startup, Remote browser responder 정책은 비목표다.

## Decision

**검증된 네이티브 Windows Codex 세션 복귀에는 exact startup 질의를 먼저 관측한 색상 코드의 최초 xterm RGB 응답만 backend protocol 경계에서 차단하는 일회성 guard를 둔다.**

- backend는 ADR-0125에 따라 settings에서 재도출한 exact Codex 복귀 override, 바깥 PTY spawn 대상 `NativeWindows`, configured Codex launcher의 첫 실행 대상 `NativeWindows`가 모두 성립할 때만 guard를 만든다. Codex 명령 자체는 기존 shell startup에서 즉시 실행하며, 어느 한쪽이라도 WSL·SSH·비-Windows인 Codex와 Claude·viewer·일반 profile에는 guard를 만들지 않는다.
- guard는 PTY spawn 전에 생성한 공유 객체다. output callback과 그 generation의 `PtyHandle`이 같은 객체를 소유한다. terminal catalog나 session 직렬화·복원 상태에는 넣지 않는다.
- output callback은 desktop delivery에 bytes를 게시하기 전에 raw PTY stream에서 exact `ESC ] 10 ; ? ST`와 `ESC ] 11 ; ? ST`를 chunk 경계를 넘어 각각 관측한다. 이것은 모든 OSC의 훅·액션을 다시 해석하는 parser가 아니라 이 복귀 lifecycle에만 활성화되는 두 고정 startup marker의 bounded recognizer다. 일반 OSC의 의미 처리와 이벤트 dispatch는 계속 ADR-0001의 Rust 단일 경로가 소유한다.
- ADR-0054가 이미 live parser의 non-human origin으로 분류한 `write_terminal_protocol_reply(id, generation, data)` 경로에서만 응답을 검사한다. frontend는 reply를 만든 physical live parse의 output generation을 함께 보내며 backend는 기존 PTY table lookup으로 얻은 handle의 generation과 먼저 대조한다. stale generation은 PTY write와 guard 접근 전에 거절하므로 close→동일 id 재생성 사이에 늦은 옛 xterm callback이 새 guard를 소비할 수 없다. 일치한 handle에 guard가 있으면 관측된 코드와 같은 well-formed `OSC 10/11 ; rgb:<1~4 hex>/<1~4 hex>/<1~4 hex> BEL|ST` 응답을 코드별 최초 한 번만 제거한다. 색상값은 고정하지 않는다. 다른 코드, 질의보다 이른 응답, malformed/non-RGB payload, 이 guard가 소비한 뒤의 중복 응답은 원래대로 전달하며 한 callback에 섞인 이웃 protocol bytes도 보존한다.
- 두 exact 질의와 그에 대응하는 두 최초 응답을 모두 처리하면 guard를 원자적으로 비활성화한다. wall-clock cutoff나 frontend 준비 상태를 정확성 조건으로 사용하지 않는다.
- guard 내부 lock을 정상적으로 읽지 못하면 관측 실패는 한 번만 기록하고, protocol 응답은 통과시키지 않는 fail-closed 오류로 처리한다. 손상된 guard 때문에 startup 색상 bytes가 composer로 유입되는 쪽으로 복구하지 않는다.
- xterm은 계속 유일한 색상 응답 생성자이며 query를 정상 parse하고 현재 renderer 색상으로 응답을 만든다. Rust는 색상을 합성하거나 xterm state를 복제하지 않고, 이 한정된 늦은 응답만 PTY 재입력 직전에 폐기한다. 내부 Tauri command에는 generation 필드를 추가하지만 Automation·Remote API 계약은 바꾸지 않는다.

## Alternatives Considered

1. **Codex 실행을 output attach 완료 뒤로 미룬다.** 실제 dev 검증에서 attach 뒤에도 parser backlog로 응답이 약 1.625초 늦어져 동일 결함이 재현됐다. transport readiness는 Codex의 100ms deadline 보장이 아니다.
2. **frontend queue에서 startup query를 우선 처리한다.** WebView scheduler와 xterm 내부 parser 완료까지 강제하지 못하며 terminal output의 전역 순서를 우회하는 별도 priority 경로가 필요하다.
3. **OSC 10/11에 Rust가 즉시 응답한다.** 현재 renderer 색상 SoT를 Rust에 복제하고 xterm과 중복 responder를 만들어 ADR-0054의 책임 경계를 깨뜨린다.
4. **query 뒤 100ms가 지난 모든 색상 응답을 버린다.** backend가 Codex의 실제 Win32 wait 시작·종료 시계를 소유하지 않아 clock heuristic이 되고, 이후 다른 프로그램의 정상 query 응답까지 오인할 수 있다.
5. **보고된 `f0f0`·`0c0c` 값만 삭제한다.** theme 변경에 즉시 깨지고 값이 같은 사용자 입력을 origin 분류 전에 오인할 위험이 있다. 응답값이 아니라 검증된 lifecycle, 선행 exact query, protocol origin, well-formed 응답 구조를 함께 사용해야 한다.
6. **Codex upstream 변경만 기다린다.** 현재 배포된 Codex와 laymux 조합의 재현을 해소하지 못한다. upstream이 늦은 console input을 안전하게 배제하거나 terminal probe 계약을 바꾸면 guard 제거를 재검토한다.

## Consequences

- 네이티브 Windows Codex 복귀의 두 xterm 색상 응답은 composer에 도달하지 않고 Codex는 기존 Win32 console fallback으로 기본색을 결정한다. 빠른 xterm 응답을 받던 경우보다 startup이 최대 약 100ms 늦어질 수 있다.
- 정상 terminal의 xterm responder 소유권, live/replay origin 분류, Remote human-control gate는 유지된다. protocol reply는 이미 필요했던 PTY table lookup 하나로 generation과 guard를 함께 확인하므로 비대상 terminal에 terminal catalog lock을 추가하지 않는다. guard가 없는 handle에는 `Option` 분기만 있고, 완료된 guard는 atomic inactive 확인 뒤 내부 lock을 잡지 않는다.
- exact query가 PTY chunk에 나뉘는 경우, 두 reply가 별도 xterm `onData` 호출로 오는 경우, 이웃 protocol bytes가 섞인 경우, malformed/wrong-code/duplicate 응답, stale generation, native shell 안의 WSL/SSH launcher 제외, catalog lock 비의존, guard lock poison fail-closed를 회귀 테스트로 고정한다. 실제 Windows dev 복귀에서는 query 관측·reply 차단 trace와 composer cell 오염 부재를 함께 검증한다.
- Codex가 query terminator·코드·fallback 동작을 바꾸면 exact recognizer가 활성화되지 않을 수 있다. Codex upgrade 후 probe source와 Windows 실기 검증을 다시 확인하며, upstream이 늦은 응답을 자체 격리하면 이 예외를 제거한다.
