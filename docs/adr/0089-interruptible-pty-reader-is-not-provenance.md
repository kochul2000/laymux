# 0089. Interruptible PTY reader는 liveness만 소유하고 exact provenance는 외부 primitive까지 fail-closed한다

- Status: Proposed
- Date: 2026-07-29
- Source: 사용자 요구 · issue [#636](https://github.com/kochul2000/laymux/issues/636) · 외부 선행 issue [#643](https://github.com/kochul2000/laymux/issues/643) · [architecture/data-flow.md §8.4·§8.8](../architecture/data-flow.md) · [architecture/api-contracts.md §13.4·§14](../architecture/api-contracts.md) · [ADR-0008](0008-shell-cursor-shadow-cursor.md) · [ADR-0085](0085-provenance-barrier-three-phase-geometry-cutover.md)
- Extends: [ADR-0085](0085-provenance-barrier-three-phase-geometry-cutover.md)의 platform capability gate를 현재 Windows ConPTY/Linux PTY가 제공하는 실제 primitive와 dependency 경계로 구체화한다.
- Dependency: issue #636의 reader 구현은 issue [#630](https://github.com/kochul2000/laymux/issues/630)의 generation-scoped stop/teardown이 머지된 뒤 그 reader loop 위에 재베이스한다.

## Context

ADR-0085는 exact geometry cutover의 필수 조건을 모든 old-geometry producer의 OS-acknowledged freeze와
authoritative drain, 또는 physical resize와 atomic한 kernel byte epoch 중 하나로 정했다. 또한 blocking read를
깨우는 기능은 control-plane liveness일 뿐 byte provenance가 아니라고 구분했다. issue #636은 이 조건을
Windows ConPTY와 Linux PTY에서 실제로 제공할 수 있는 adapter와 interruptible reader seam을 조사한다.

laymux가 고정한 [`portable-pty 0.8.1`](https://github.com/wezterm/wezterm/blob/4afedd626dadd15d9c2929bab0e2063b54f61393/pty/src/lib.rs#L88-L102)과 [2026-07-29 upstream](https://github.com/wezterm/wezterm/blob/76b606ec597a3c0263fa60321548637451c0a547/pty/src/lib.rs#L87-L114)을 감사한 결과 공통 `MasterPty` 계약은
`resize`, `get_size`, `try_clone_reader() -> Box<dyn Read + Send>`만 제공한다. Unix 구현은 raw master fd를
노출하지만 [Windows 구현](https://github.com/wezterm/wezterm/blob/4afedd626dadd15d9c2929bab0e2063b54f61393/pty/src/win/conpty.rs#L46-L97)은 synchronous anonymous pipe의 구체 handle과 HPCON을 private 상태에 보관한다.
Windows `get_size()`는 `ResizePseudoConsole`이 성공한 뒤 process-local `size`를 바꿔 그대로 반환한다.
따라서 laymux wrapper는 Linux에서 readiness source를 만들 수 있지만, Windows에서는 erased reader 밖에서
정확한 read operation을 깨우거나 결과를 분류할 수조차 없다.

Windows의 공개 [CreatePseudoConsole](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole)은
input/output stream을 synchronous I/O로 제한하고,
[ResizePseudoConsole](https://learn.microsoft.com/en-us/windows/console/resizepseudoconsole)은 내부 buffer resize의
성공 HRESULT만 반환한다. producer freeze acknowledgement, output queue drain, byte epoch, authoritative size query는
공개하지 않는다. [CancelSynchronousIo](https://learn.microsoft.com/en-us/windows/win32/fileio/cancelsynchronousio-func)는
전용 reader thread의 pending synchronous I/O를 깨우는 후보지만 호출 자체는 완료를 기다리지 않고, 대상 read가
정상 완료·취소·별도 실패 중 무엇인지 completion에서 다시 판정해야 한다. Microsoft의
[cancellation 지침](https://learn.microsoft.com/en-us/windows/win32/fileio/canceling-pending-i-o-operations)도 X를
취소하려다 다음 Y를 취소할 수 있는 race를 명시한다. 즉 generation handshake가 있으면 liveness seam은 만들 수
있지만 이 API는 ConPTY producer나 output provenance를 제어하지 않는다.

Linux upstream의 [`pty_resize`](https://github.com/torvalds/linux/blob/fc02acf6ac0ccde0c805c2daa9148683cdd01ba8/drivers/tty/pty.c#L282-L307)에서 `TIOCSWINSZ`는 호출된 tty의 `winsize_mutex` 아래 PTY 양쪽 winsize를 바꾸고 foreground process group에
`SIGWINCH`를 보낸다. slave output은 별도의 `atomic_write_lock`, line-discipline `output_lock`, flip buffer를
통과한다. [`tty_write`](https://github.com/torvalds/linux/blob/fc02acf6ac0ccde0c805c2daa9148683cdd01ba8/drivers/tty/tty_io.c#L931-L1008)와 resize 사이에 공통 lock이나 epoch가 없다. [`TIOCPKT`](https://man7.org/linux/man-pages/man2/TIOCPKT.2const.html) packet mode가 알리는 것은
flush, flow stop/start, termios 관련 control뿐이며 resize byte boundary는 없다. foreground signal은 background
process, 별도 process group, 이미 slave fd를 가진 외부 writer, signal과 경합하는 writer를 freeze-ack하지 않는다.

이 부재를 코드 독해만으로 결론 내리지 않기 위해 `portable-pty 0.8.1` standalone sabotage를 실제 두 플랫폼에서
실행했다. child는 80열을 조회해 메모리에 저장하고 `READY:80`을 출력한 뒤 입력을 기다렸다. host는 output을
500 ms 동안 quiet 상태까지 읽고 120열로 resize한 다음 `get_size().cols == 120`을 확인하고 child를 깨웠다.
결과는 다음과 같았다.

| 환경 | resize 뒤 보고 크기 | resize 뒤 늦게 도착한 child output | 추가 관찰 |
|---|---:|---|---|
| Windows 10.0.26200.8875, MSVC Rust 1.94.1 | 120 | `LATE_OLD:80` | ConPTY resize 자체도 기존 `READY:80` 화면을 VT output으로 다시 방출했다. |
| WSL2 Linux 6.6.87.2, GNU Rust 1.94.0 | 120 | `LATE_OLD:80` | 500 ms quiet와 kernel size query 뒤에도 지연 producer가 old 값으로 쓸 수 있었다. |

이 실험은 child가 의도적으로 old geometry를 기억하는 sabotage다. 바로 그 때문에 `poll()` non-readable,
`PeekNamedPipe()==0`, quiet timer, 성공한 resize, 크기 조회 중 어느 것도 다음 순간 old-geometry producer가 쓰지
않는다는 증명이 아님을 보여 준다. exact adapter는 이 sabotage를 배제하거나 byte epoch로 구별해야 한다.

현재 제품 범위에서 구현 가능한 것은 interruptible reader liveness다. Windows Console host나 Linux kernel을
fork해 새 provenance primitive를 제품에 싣는 것은 별도 배포·보안·라이선스·OS 호환 결정을 요구한다. 따라서
issue #636은 liveness seam과 capability=false 통합으로 한정하고, 실제 exact primitive는 issue #643으로 분리한다.

## Decision

**laymux는 최소 `portable-pty` fork로 generation-aware interruptible reader만 제공하고, 현재 Windows/Linux
adapter의 `exactGeometryCutover`는 계속 false로 둔다. exact=true는 issue #643이 양 플랫폼의 OS/OpenConsole
provenance primitive와 실기기 sabotage test를 통과한 뒤 별도 결정으로만 활성화한다.**

### Reader event와 wake 계약

- platform reader는 다음 네 결과를 구분한다.
  - `Data(bytes)`: 1 byte 이상을 읽었다.
  - `Wake(generation)`: 해당 control generation의 wake를 reader가 관찰하고 acknowledgement했다.
  - `Eof`: stream이 정상 종료됐다.
  - `Failure(error)`: 취소로 설명되지 않는 platform/read 실패다.
- wake는 reader가 idle blocking 상태여도 bounded 시간 안에 관찰할 수 있어야 한다. wake 요청자는 API 호출의
  성공이나 `ERROR_NOT_FOUND`를 acknowledgement로 간주하지 않고 reader의 `Wake(generation)` 또는 terminal
  teardown completion을 기다린다.
- data와 wake가 경합해 data가 먼저 완료되면 bytes를 버리지 않는다. `Data(bytes)`를 전달한 뒤 pending
  generation을 `Wake(generation)`으로 acknowledgement한다. stale generation은 새 generation의 read를
  취소하거나 stop을 완료시킬 수 없다.
- `Wake`는 read admission을 다시 평가하게 하는 control event다. byte sequence, geometry revision, source
  sequence를 만들거나 advance하지 않으며 ADR-0085의 freeze/drain 또는 epoch capability로 계산하지 않는다.
- #630의 callback `Stop`, fatal generation teardown, EOF와 이 seam의 wake는 같은 것으로 합치지 않는다.
  구현은 #630 merge 뒤 그 generation-scoped reader lifecycle을 재사용하고, stop 요청이 idle read도 깨운 뒤
  현재 generation만 종료하는지 검증한다.

### Platform 구현 경계

- Linux는 portable-pty가 노출하는 raw master fd와 별도 wake fd(`eventfd` 또는 self-pipe)를 `poll`/`ppoll`하는
  adapter를 사용한다. wake fd payload 또는 보호된 queue가 generation을 보존한다. PTY fd의 readable/hangup/error와
  wake fd를 독립적으로 분류하고, 둘 다 ready면 data를 잃지 않은 뒤 pending wake를 전달한다.
- Windows는 ConPTY output pipe를 읽는 전용 thread와 그 thread handle, 현재 read operation state, pending wake
  generation, completion acknowledgement를 한 adapter가 소유한다. `CancelSynchronousIo`는 이 전용 thread에만
  호출한다. reader가 read 진입 직전과 completion 직후 pending wake를 확인하고, controller는 acknowledgement가
  올 때까지 `ERROR_NOT_FOUND`를 성공으로 보지 않고 같은 generation의 cancellation을 재시도한다. pending wake가
  있으면 reader는 다음 read를 시작하지 않는다. 이 handshake로 호출 사이 race에서 영구 block되거나 다음 read가
  잘못 취소되는 것을 막는다. completion의 정상 data,
  `ERROR_OPERATION_ABORTED`, 0-byte EOF, 다른 오류를 각각 위 네 event로 변환한다.
- 현재 `portable-pty` public trait와 erased Windows reader만으로는 이 ownership을 만들 수 없으므로, upstream에
  같은 최소 seam을 제안하되 수용 전에는 laymux가 감사한 git revision의 최소 fork를 pin한다. fork 범위는
  reader handle/operation state/wake/event API와 그 테스트뿐이다. process spawn, HPCON lifecycle, resize 동작,
  bundled/sideload ConPTY 선택을 변경하지 않는다.
- fork는 upstream과 같은 MIT 조건을 유지하고 notice를 배포한다. laymux maintainer가 upstream release와 Windows
  I/O 관련 security/bug fix를 추적하고, Cargo.lock과 fork revision을 고정한다. 새 DLL, driver, kernel module,
  `OpenConsole.exe`를 #636 산출물로 배포하지 않는다.

### Capability와 fail-closed 정책

- #636 구현 전 현재 응답은 `{exactGeometryCutover:false, interruptibleRead:false,
  followUpIssue:636}`이다. 구현과 실기기 liveness test가 통과하면 `interruptibleRead`만 true가 되고 exact의
  blocker는 issue #643이다.
- Windows와 Linux 어느 쪽에서도 `ResizePseudoConsole`/`TIOCSWINSZ` 성공, cached/kernel `get_size`, reader wake,
  quiet/poll/pipe-empty, process signal/suspend를 결합해 `exactGeometryCutover=true`를 광고하지 않는다.
- exact 요청은 현재와 같이 physical/logical resize 전에 거절한다. ADR-0085의 pure coordinator를 production
  prepare/apply/release 경로에 연결하지 않고 기존 guarded one-shot resize를 exact라고 이름만 바꾸지 않는다.
- Windows physical resize가 오류·timeout·cancel된 경우 cached `get_size()`로 `Applied`/`NotApplied`를
  화해시키지 않는다. exact 경로가 생기기 전까지도 진단에서는 `Indeterminate` 한계를 보존한다.

### 검증 게이트

- deterministic adapter test는 idle wake, wake-before-read, data/wake race, 연속 generation, EOF/wake race,
  cancellation failure, stale wake, #630 fatal stop을 각각 재현하고 네 event가 섞이지 않음을 검증한다.
- 실제 Windows ConPTY와 Linux PTY integration test는 idle 상태의 bounded wake와 data/EOF/failure 보존을
  검증한다. fake adapter만으로 `interruptibleRead=true`를 광고하지 않는다.
- 위 provenance sabotage는 별도 negative capability test로 유지한다. queued old bytes, delayed/concurrent writer,
  pipe-empty/quiet 직후 writer가 있는 환경에서 exact capability가 계속 false여야 한다.
- issue #643만 Windows side-loaded OpenConsole producer barrier/epoch와 Linux kernel byte epoch의 feasibility,
  maintenance owner, ABI/version detection, signing/distribution, MIT notice와 Linux GPL-2.0 결과를 다룬다.
  양 플랫폼 capability=true 실기기 test가 없으면 이 ADR을 근거로 exact를 활성화할 수 없다.

## Alternatives Considered

- **laymux wrapper만으로 구현한다.** Linux raw fd에는 가능하지만 Windows `Box<dyn Read>`에서 private pipe
  handle과 operation을 안전하게 복구할 수 없다. unsafe trait-object 추출이나 global thread cancellation은
  dependency ABI와 무관한 계약이 아니므로 기각했다.
- **portable-pty 전체를 장기 fork하거나 자체 PTY backend로 교체한다.** reader seam보다 spawn, handle inheritance,
  process group/job, ConPTY side-load, cross-platform bug surface가 훨씬 커진다. 우선 upstream 제안 + 최소 pinned
  fork만 선택하고 자체 backend는 그 최소 fork가 불가능하다는 별도 증거가 생길 때 재검토한다.
- **`CancelSynchronousIo`/`poll` wake를 provenance barrier로 사용한다.** 읽기를 깨워 control job을 관찰하게 할
  뿐 queued byte와 future producer를 배제하지 않는다. Windows/Linux sabotage가 반례이므로 liveness에만 쓴다.
- **foreground process group 또는 전체 child tree를 suspend하고 pipe를 drain한다.** Linux의 background/external
  slave-fd writer와 kernel echo를 완전히 포함하지 못하고, Windows에서도 OpenConsole resize repaint producer를
  freeze-ack하지 못한다. process enumeration과 suspend race도 남으므로 exact primitive로 기각했다.
- **`TIOCPKT`, `TIOCGWINSZ`, ConPTY cached size, quiet/empty를 조합한다.** 어느 신호도 resize와 output byte를
  원자적으로 연결하지 않는다. confidence를 높이는 heuristic일 수는 있어도 ADR-0085 capability가 아니다.
- **Windows Terminal/OpenConsole와 Linux kernel을 지금 제품 dependency로 fork한다.** Windows Terminal 소스의
  MIT 조건은 재사용을 허용하지만 OpenConsole binary의 ABI, 서명, 보안 업데이트, OS별 호환과 설치 크기를
  laymux가 떠안는다. Linux kernel 변경은 upstream/minimum-version rollout과 GPL-2.0 배포 결과가 필요하며 일반
  desktop 앱이 private kernel을 요구할 수 없다. 제품 밖 연구 issue #643으로 보존하되 #636에서는 기각한다.
- **정확한 provenance 요구를 완화하고 best-effort exact를 제공한다.** 커서/IME/DECSET 2026 경계에서 잘못된
  grid에 byte를 적용하는 오류를 다시 허용한다. 명칭만 exact인 heuristic은 fail-closed 계약과 충돌하므로
  기각했다.

## Consequences

- #636은 지원 가능한 reader liveness와 teardown 연동을 완료할 수 있지만 exact geometry cutover는 완료했다고
  주장하지 않는다. exact의 외부 blocker와 원래 sabotage 완료 조건은 #643에 남는다.
- idle terminal도 control generation을 관찰할 수 있고 #630 fatal/stop teardown이 blocking read에 영구히
  걸리지 않는다. 반면 dependency fork와 platform-specific race test를 유지하는 비용이 생긴다.
- Windows cancellation은 정상 data와 경합할 수 있으므로 단순 `cancel == wake` 구현보다 상태와 test가 많다.
  이 비용은 byte 유실이나 다음 generation 오취소를 막기 위해 의도적으로 부담한다.
- Linux raw fd adapter와 Windows private handle adapter의 구현은 다르지만 외부 reader event 계약은 같다.
  platform 차이를 `pty.rs`의 callback/teardown에 누출하지 않는다.
- current production capability는 계속 false이며 이 ADR 전용 PR은 runtime을 바꾸지 않는다. ADR 승인 후에도
  #630이 먼저 머지돼야 #636 reader 구현을 시작한다.
- upstream이 동등한 interruptible reader API를 release하면 pinned fork를 제거하고 crates.io dependency로
  복귀한다. API가 generation과 data/EOF/failure 구분을 잃으면 단순히 교체하지 않는다.
- Windows가 output epoch/freeze API를 공개하거나 OpenConsole fork의 배포를 지속 가능하게 만들고, Linux가
  resize와 atomic한 master-read epoch를 upstream하면 #643에서 ADR-0085 capability gate와 실기기 test를 다시
  평가한다. 한 플랫폼만 성공하거나 fake test만 통과한 상태에서는 cross-platform exact를 켜지 않는다.
