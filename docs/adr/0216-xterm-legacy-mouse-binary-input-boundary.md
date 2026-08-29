# 0216. xterm legacy mouse binary 입력은 플랫폼 PTY 경계에서 검증한다

- Status: Proposed
- Date: 2026-08-29
- Source: [issue #954](https://github.com/kochul2000/laymux/issues/954) · PR #953 리뷰 · [architecture/data-flow.md §8.8](../architecture/data-flow.md) · [architecture/api-contracts.md §14.6](../architecture/api-contracts.md) · [ADR-0054](0054-xterm-human-and-protocol-data-origin.md) · [ADR-0096](0096-terminal-human-input-write-failure-observability.md) · [ADR-0202](0202-io-commands-off-the-main-thread.md) · [Microsoft Pseudoconsoles](https://learn.microsoft.com/en-us/windows/console/pseudoconsoles)
- Extends: ADR-0054, ADR-0096, ADR-0202

## Context

xterm 6.0.0의 mouse service는 SGR 계열 보고는 `onData`로 내보내지만, DEFAULT encoding의 고정 6바이트 `CSI M Pb Px Py` 보고는 `onBinary`로만 내보낸다. TerminalView가 `onData`만 구독하면 X10/VT200 DEFAULT mouse 입력은 PTY에 전혀 도달하지 않는다.

`onBinary`의 JavaScript 문자열은 각 UTF-16 code unit 하나가 바이트 하나를 뜻하는 binary-string 계약이다. 이를 기존 `write_to_terminal(id, data: String)`에 넘기면 Rust의 UTF-8 `String` 경계가 `0x80..0xff` code unit을 2바이트 이상으로 재인코딩해 보고의 고정 길이와 좌표를 바꾼다. Linux PTY는 `Vec<u8>`를 그대로 쓸 수 있지만 Windows ConPTY의 pseudoconsole 채널은 모든 정보를 UTF-8로 운반한다. native probe에서 단독 high-bit 바이트는 child stdin에 원본으로 도달하지 않았으므로, UI→Rust 직렬화만 바꿔서는 Windows의 high-bit DEFAULT 보고를 보존할 수 없다.

이 입력은 사용자의 mouse action이므로 ADR-0054의 Local human-control 소유권과 ADR-0096의 exactly-once 전달 관측을 유지해야 한다. 동시에 attach가 교체된 뒤 구 surface의 늦은 입력이 새 PTY에 쓰이지 않아야 한다. Remote/Automation 입력 계약, xterm protocol reply, SGR mouse encoding 변경은 범위 밖이다.

## Decision

**desktop xterm의 DEFAULT `onBinary` 보고를 전용 byte-array IPC로 받아 현재 generation의 Local human-input FIFO에 한 번만 전달하고, byte-transparent하지 않은 Windows ConPTY 범위는 쓰기 전에 거부한다.**

- TerminalView는 `onBinary`를 별도로 구독한다. 각 code unit이 `0x00..0xff`인지 확인해 `number[]`로 직렬화하고 `write_terminal_binary_input(id, generation, data)`를 호출한다. 문자열 UTF-8 변환이나 재전송을 하지 않는다.
- Rust command는 현재 고정 xterm이 내보내는 정확한 6바이트 `CSI M Pb Px Py`만 허용한다. 현재 PTY generation 일치와 Local human-control permit을 확인한 뒤 기존 terminal별 bounded FIFO에 원본 `Vec<u8>`를 enqueue한다.
- 이 command는 Tauri desktop 내부 계약이며 Automation/Remote API에는 노출하지 않는다. 입력 IPC 순서가 terminal FIFO 등록 순서이므로 ADR-0202에 따라 plain `#[tauri::command]`로 둔다.
- Linux PTY에는 payload의 `0x00..0xff`를 그대로 전달한다.
- Windows에서는 세 payload byte 중 하나라도 `0x80..0xff`이면 ConPTY enqueue 전에 fail-closed 오류로 거부한다. `0x00..0x7f` 보고는 그대로 전달한다. 위치를 clamp하거나 UTF-8로 재인코딩해 다른 좌표·버튼 입력으로 바꾸지 않는다. 따라서 DEFAULT encoding은 Windows에서 1-based 좌표 95까지 표현할 수 있고, 그 밖의 위치는 입력되지 않는다. SGR/SGR-pixels처럼 `onData`를 쓰는 encoding은 영향을 받지 않는다.
- `onBinary`는 keyboard/IME와 같은 입력 전달 attempt/success/failure counter와 session당 한 번의 action-required 실패 알림을 사용한다. IPC 거절을 재전송하지 않으며 protocol reply/replay route와 `lastUserInput` line model에는 넣지 않는다.
- Local control을 아직 검증하지 못했거나 Remote가 소유한 동안에는 xterm `disableStdin`과 전송 직전 Local gate가 먼저 막고, backend permit이 최종 권한 경계다.

## Alternatives Considered

- **기존 문자열 command를 재사용한다.** ASCII 보고는 동작하지만 high-bit code unit이 UTF-8로 늘어나 fixed-width mouse protocol을 손상시킨다.
- **binary code unit을 UTF-8로 인코딩해 Windows에 쓴다.** ConPTY 채널에는 유효하지만 child가 받는 바이트는 DEFAULT encoding의 원래 6바이트가 아니어서 좌표 경계와 프로토콜 의미를 보존하지 못한다.
- **Windows high-bit 좌표를 마지막 안전 좌표로 clamp한다.** 클릭이 사라지는 대신 다른 버튼이나 위치를 활성화할 수 있고 drag가 경계에 붙는다. 사용자가 하지 않은 입력을 합성하는 것보다 관측 가능한 fail-closed를 택한다.
- **Windows에서 high-bit 보고를 그대로 enqueue한다.** ConPTY가 변환한 바이트를 child가 정상 mouse report로 오인할 수 있어 정확성 계약을 충족하지 못한다.
- **xterm을 fork하거나 DEFAULT encoding을 SGR로 강제한다.** child가 요청한 encoding을 emulator가 일방적으로 바꾸면 호환 계약을 어긴다. upstream renderer/protocol 유지 비용도 이 결함의 범위를 넘는다.
- **Remote/Automation에도 binary command를 공개한다.** 이 경로의 유일한 producer는 desktop xterm의 `onBinary`다. 외부 raw-byte API는 별도의 인증·권한·프로토콜 계약이 필요하고 현재 문제 해결에는 필요하지 않다.

## Consequences

- Linux의 X10/VT200 DEFAULT 보고는 high-bit 좌표를 포함해 byte-for-byte PTY에 도달한다. Windows도 ASCII 범위 안에서는 동일하지만, 넓거나 높은 pane의 96번째 이후 cell에서 legacy DEFAULT mouse event가 거부될 수 있다. 해당 앱이 SGR mouse encoding을 협상하면 이 제약을 피한다.
- Windows에서 경계 밖 drag/release가 거부되면 legacy 앱이 이전 mouse 상태를 잠시 유지할 수 있다. 잘못된 좌표로 다른 action을 실행하는 위험을 피하는 대가이며, 실패 counter와 coalesced 알림으로 사용자에게 드러낸다.
- actual xterm screen-tier 테스트가 X10 DEFAULT mouse event가 `onBinary`에만 정확히 한 번 나타나는 것을 고정한다. UI 테스트는 generation·Local gate·exactly-once metrics·실패 알림·`lastUserInput` 비오염을, Rust 테스트는 형식·소유권·generation·플랫폼 policy를 검증한다. native PTY probe는 Windows의 안전 ASCII 보고와 Linux의 high-bit 보고를 각 플랫폼에서 검증한다.
- Windows pseudoconsole이 미래에 byte-transparent input channel을 제공하거나 xterm이 DEFAULT encoding 운반 방식을 바꾸면 high-bit 거부 정책과 전용 report 검증을 다시 검토한다.
