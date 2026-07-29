# PTY output epoch upstream feasibility

> **상태: 연구/RFC 초안. 구현 완료가 아니다.** 이 문서는 Windows OpenConsole 또는 Linux kernel 패치를
> 포함하지 않으며, patched OS에서 `capability=true` 통합 테스트를 통과한 증거도 없다. 따라서 현재
> laymux의 `exactGeometryCutover`는 계속 `false`여야 한다. 특히 resize 전에 옛 열 수를 기억한 producer가
> resize 뒤에 출력하는 sabotage는 아래 enqueue-time epoch만으로 판별할 수 없다.

## 1. 목적과 범위

[ADR-0085](../adr/0085-provenance-barrier-three-phase-geometry-cutover.md)는 geometry cutover가
producer-freeze+authoritative-drain 또는 physical resize와 원자적으로 연결된 byte epoch 중 하나로
old/new output을 증명할 때만 exact path를 열도록 정한다. [ADR-0089](../adr/0089-interruptible-pty-reader-is-not-provenance.md)는
interruptible reader가 control-plane liveness일 뿐 provenance가 아님을 고정했다. issue
[#643](https://github.com/kochul2000/laymux/issues/643)은 그 제품 밖 primitive의 feasibility를 추적한다.

이 문서는 다음만 수행한다.

- Microsoft Terminal/OpenConsole과 Linux PTY의 현재 resize, output enqueue, read 경계를 소스에서 찾는다.
- 검토를 시작할 수 있는 Windows sideband byte-offset epoch와 Linux opt-in framed epoch UAPI를 RFC 수준으로
  제안한다.
- 거짓 양성을 막을 sabotage harness와 upstream·ABI·서명·배포·라이선스 blocker를 기록한다.

제품 계약, 채택 플랫폼, 배포 방식 또는 capability 활성화를 결정하지 않는다. 외부 프로젝트에 patch나
issue를 제출하지도 않는다. 따라서 **ADR 불필요**다. 이 PR은 새 소유권·외부 계약·런타임 불변식을 채택하는
결정이 아니라, 후속 ADR과 upstream 논의를 위한 반증 가능한 연구 입력만 추가한다. 실제 fork/UAPI를 채택할
때는 유지보수 주체, 지원 OS/version, ABI, 배포와 fail-closed 계약을 별도 ADR로 승인해야 한다.

## 2. 소스 기준선과 exact의 의미

감사 기준선은 2026-07-29의 다음 커밋으로 고정한다.

- Microsoft Terminal `a463ae64797c19d181dd8fc9f74c5596ad017782`
- Linux `fc02acf6ac0ccde0c805c2daa9148683cdd01ba8`

여기서 epoch는 단순히 “resize API가 반환된 전/후”가 아니다. 다음 세 종류를 구분해야 한다.

1. **control epoch**: resize 요청이 control pipe 또는 ioctl에 들어간 순서
2. **enqueue epoch**: byte가 OpenConsole output FIFO 또는 Linux PTY peer queue에 들어간 순서
3. **semantic geometry provenance**: producer가 byte를 만들 때 실제로 사용한 열 수

공유 lock으로 1과 2를 선형화할 수는 있다. 하지만 producer가 resize 전에 `80`을 저장하고 resize가 끝난 뒤
`LATE_OLD:80`을 쓰면 enqueue 시점만 보는 primitive는 그 byte를 새 epoch로 표시한다. 즉 enqueue epoch는
semantic provenance의 충분조건이 아니다. ADR-0085의 sabotage 완료 조건을 그대로 유지한다면 OS가 모든
producer를 freeze/ack하거나, producer가 geometry token을 출력과 함께 제출하는 더 강한 계약이 필요하다.

## 3. Windows OpenConsole 감사

### 3.1 현재 실제 경계

공개 `ResizePseudoConsole` 성공은 output boundary acknowledgement가 아니다.

- [`_ResizePseudoConsole`](https://github.com/microsoft/terminal/blob/a463ae64797c19d181dd8fc9f74c5596ad017782/src/winconpty/winconpty.cpp#L288-L301)은
  `{RESIZE_WINDOW, cols, rows}`를 signal pipe에 `WriteFile`하고 그 쓰기의 성공만 반환한다.
- OpenConsole의 [`PtySignalInputThread`](https://github.com/microsoft/terminal/blob/a463ae64797c19d181dd8fc9f74c5596ad017782/src/host/PtySignalInputThread.cpp#L136-L187)는
  나중에 packet을 읽고 console lock을 잡아 `_api.ResizeWindow`를 호출한다. 호출자에게 resize 적용 완료나
  output offset을 돌려주는 역방향 acknowledgement가 없다.
- VT output은 별도의 [`VtIo::_flushNow`](https://github.com/microsoft/terminal/blob/a463ae64797c19d181dd8fc9f74c5596ad017782/src/host/VtIo.cpp#L455-L554)에서
  `_back`/`_front` buffer를 교체하고 output pipe에 `WriteFile`한다. overlapped write가 pending일 수도 있다.
  resize signal write의 성공과 이 FIFO의 byte 위치를 묶는 현재 계약은 없다.

따라서 현재 선형화 지점은 각각 “signal pipe에 요청을 넣음”, “console lock 아래 resize 호출”, “output pipe에
chunk 쓰기를 제출함”으로 갈라진다. `ResizePseudoConsole` 반환, output pipe가 잠시 비어 있음, cached size 중
어느 것도 이 세 지점을 하나로 만들지 않는다.

### 3.2 RFC W1: sideband byte-offset epoch

검토 가능한 최소 OpenConsole fork는 VT stream 자체에 marker escape를 주입하지 않는다. marker는 application
VT와 충돌하고 split sequence를 만들 수 있기 때문이다. 대신 host만 읽는 sideband handle을 ConPTY 생성 시
추가하고 다음 versioned record를 보낸다.

```text
EpochHello   { abiVersion, featureBits, streamId }
ResizeBegin  { requestId, requestedCols, requestedRows }
ResizeCommit { requestId, epoch, outputByteOffset, appliedCols, appliedRows }
ResizeFail   { requestId, outputByteOffset, errorClass }
StreamEnd    { finalOffset, finalEpoch, reason }
```

`outputByteOffset`은 output stream 첫 byte부터의 누적 `u64` 위치다. sideband와 output pipe의 도착 순서는
의미가 없고, adapter는 offset을 기준으로 output chunk를 분할한다. offset보다 먼저 sideband가 와도 byte를
기다리고, output이 먼저 와도 해당 offset의 metadata가 올 때까지 exact transaction에 넘기지 않는다.

OpenConsole 내부에서는 모든 VT output admission이 한 writer coordinator를 거쳐 byte range를 예약해야 한다.
resize thread는 같은 coordinator에서 다음 순서를 수행한다.

1. 새 output admission을 막고 이미 예약된 write의 offset을 확정한다.
2. pending overlapped write의 성공/실패를 확인한다. 단순 `WriteFile` 제출 시점은 commit이 아니다.
3. console lock의 기존 순서를 보존하며 physical resize를 적용한다.
4. epoch를 증가시키고 그 시점의 누적 offset과 실제 size를 `ResizeCommit`에 기록한다.
5. resize가 자체 생성하는 repaint/cursor VT는 새 epoch의 첫 range로 예약한다.
6. output admission을 재개한다.

이 변경은 `VtIo::_back/_front`만 감싸서는 부족하다. console API output, raw VT/passthrough, resize repaint,
close/error 경로가 같은 offset allocator를 통과한다는 소스 감사와 test instrumentation이 필요하다. 누락된
writer가 하나라도 있으면 capability는 false다.

### 3.3 Windows에서 아직 증명되지 않은 것

- sideband offset은 OpenConsole이 **관찰한 enqueue 순서**를 증명할 뿐, child가 어느 geometry로 문자열을
  계산했는지는 증명하지 않는다. `LATE_OLD:80` sabotage를 통과하려면 모든 client producer의 freeze/ack,
  token-bearing write API, 또는 ADR의 provenance 의미 변경 중 하나가 먼저 필요하다.
- console lock과 VtIo writer coordinator의 새 lock 순서, overlapped completion, shutdown/pipe break가 ABA 없이
  동작한다는 설계가 없다.
- inbox Windows의 `kernel32!ResizePseudoConsole`과 side-loaded `winconpty.dll`/`OpenConsole.exe`의 선택 및
  version negotiation ABI가 승인되지 않았다.
- fork된 `OpenConsole.exe`의 신뢰 체인, Authenticode 서명, SmartScreen/EDR 영향, 보안 update cadence,
  Windows build별 condrv 호환성, 설치 크기와 rollback 주체가 없다.

Microsoft Terminal 소스는 [MIT License](https://github.com/microsoft/terminal/blob/a463ae64797c19d181dd8fc9f74c5596ad017782/LICENSE)를
사용하지만, 이것이 Windows 내부 ABI의 안정성이나 Microsoft 서명을 승계한다는 뜻은 아니다.

## 4. Linux PTY 감사

### 4.1 현재 실제 경계

현재 kernel에는 winsize와 output byte를 함께 보호하는 lock이나 epoch가 없다.

- PTY resize는 [`pty_resize`](https://github.com/torvalds/linux/blob/fc02acf6ac0ccde0c805c2daa9148683cdd01ba8/drivers/tty/pty.c#L282-L307)에서
  `winsize_mutex`를 잡고 process group에 `SIGWINCH`를 보낸 뒤 양쪽 `winsize`를 바꾼다.
- slave output은 [`pty_write`](https://github.com/torvalds/linux/blob/fc02acf6ac0ccde0c805c2daa9148683cdd01ba8/drivers/tty/pty.c#L97-L117)에서
  peer port의 flip buffer로 byte를 넣고 push한다. 이 경로는 `winsize_mutex`를 잡지 않는다.
- 일반 tty write의 [`atomic_write_lock`](https://github.com/torvalds/linux/blob/fc02acf6ac0ccde0c805c2daa9148683cdd01ba8/drivers/tty/tty_io.c#L931-L945)은
  같은 tty의 writer를 직렬화할 뿐 resize와 공통 lock이 아니다. `winsize_mutex`와 `atomic_write_lock`도
  별개로 초기화된다.
- [`TIOCSWINSZ`](https://github.com/torvalds/linux/blob/fc02acf6ac0ccde0c805c2daa9148683cdd01ba8/drivers/tty/tty_io.c#L2345-L2369)는
  driver resize callback으로 위임한다. 성공은 winsize update의 결과이지 peer read queue의 byte boundary가
  아니다.

`TIOCPKT` control byte도 flush/flow/termios 상태 알림이지 resize와 atomic한 `u64` byte epoch가 아니다.
`poll()` non-readable이나 `TIOCINQ == 0` 역시 미래 writer를 배제하지 않는다.

### 4.2 RFC L1: opt-in framed epoch UAPI

기존 PTY byte stream ABI를 바꾸면 모든 terminal이 깨진다. 새 기능은 master fd에서 명시적으로 opt-in하고,
기존 `TIOCPKT`와 동시 사용을 거절하는 versioned framed mode여야 한다. 이름과 번호는 upstream 검토 전
placeholder다.

```c
struct pty_epoch_caps {
    __u32 abi_version;
    __u32 feature_bits;
    __u32 max_header;
    __u32 reserved;
};

struct pty_epoch_record_v1 {
    __u16 version;
    __u16 type;       /* DATA, RESIZE, HANGUP, ERROR */
    __u32 payload_len;
    __u64 stream_seq;
    __u64 epoch;
    __u32 cols;
    __u32 rows;
};

ioctl(master, TIOCGPTYEPOCHCAP, &caps);
ioctl(master, TIOCSPTYEPOCHMODE, &version);
ioctl(master, TIOCSWINSZEPOCH, &resize_request_and_result);
```

`read()`은 header 또는 payload 일부를 임의로 쪼개지 않고 record 단위로 반환해야 한다. buffer가 한 record보다
작으면 `EMSGSIZE`와 필요한 크기를 조회할 방법을 제공한다. `splice`, `io_uring`, `epoll`, nonblocking,
fork/dup된 master fd가 같은 stream cursor를 공유하는 현재 file-description semantics와 맞는지도 별도 검토가
필요하다.

kernel 후보 선형화점은 PTY pair에 새 epoch state와 짧은 spinlock을 두고 다음 두 사건을 같은 lock 아래
순서화하는 곳이다.

- `pty_write`: peer flip queue에 넣을 byte range의 `{stream_seq, epoch}` metadata 예약
- `pty_resize`: winsize commit과 epoch 증가, `RESIZE` record의 `stream_seq` 예약

현재 [`pty_write`](https://github.com/torvalds/linux/blob/fc02acf6ac0ccde0c805c2daa9148683cdd01ba8/drivers/tty/pty.c#L103-L116)는
non-sleeping context에서도 호출될 수 있으므로 여기서 sleep하는 mutex를 새로 잡는 설계는 부적합하다.
또한 현재 flip buffer는 epoch run을 보존하지 않는다. byte를 넣는
[`tty_buffer`](https://github.com/torvalds/linux/blob/fc02acf6ac0ccde0c805c2daa9148683cdd01ba8/drivers/tty/tty_buffer.c#L307-L345)와
N_TTY receive/read까지 metadata를 전달하거나, epoch mode 전용 record queue를 별도로 만들어야 한다.
allocation failure, flow control, partial enqueue에서도 DATA record에 실제 수락된 byte만 들어가야 한다.

lock 순서는 아직 결정할 수 없다. 최소한 lockdep/KCSAN/lock torture로 `winsize_mutex`, tty
`atomic_write_lock`, port buffer lock, `ctrl.lock`과의 순환이 없음을 증명해야 한다. `SIGWINCH` 전송처럼
spinlock 안에서 할 수 없는 일은 epoch/winsize commit과 분리하되, userspace가 어떤 사건을 resize completion으로
보는지 UAPI에 명시해야 한다.

### 4.3 Linux에서 아직 증명되지 않은 것

- enqueue epoch는 resize 뒤에 실행된 cached-layout writer를 새 epoch로 표시한다. 따라서 Windows와 동일하게
  `LATE_OLD:80` 의미적 sabotage를 해결하지 못한다.
- echo/line discipline, kernel-generated bytes, background process, 별도 process가 보유한 slave fd를 모두 같은
  epoch queue가 포착하는지 patch가 없다.
- ioctl 번호, compat ioctl, 32/64-bit alignment, endianness, record padding, epoch wrap, namespace/permission,
  checkpoint/restore ABI가 정해지지 않았다.
- upstream 수용 여부와 최초 kernel version이 없다. `uname` 문자열만 믿지 말고 capability ioctl의
  `ENOTTY`/version/feature bits로 탐지해야 하며, 모르는 version은 fail-closed해야 한다.
- Linux kernel은 [GPL-2.0-only](https://github.com/torvalds/linux/blob/fc02acf6ac0ccde0c805c2daa9148683cdd01ba8/COPYING)다.
  kernel fork/module/binary를 배포하면 해당 배포물의 source 제공과 notice 등 의무를 법률 검토해야 한다.
  일반 desktop 사용자를 private kernel에 묶는 제품 경로는 별도 승인 없이는 허용하지 않는다.

## 5. sabotage harness

가짜 adapter unit test만으로 capability를 열 수 없다. 아래 test는 실제 patched OpenConsole/Windows build와
실제 patched kernel에서 반복하고, event trace의 output bytes와 epoch record를 원본 artifact로 보존해야 한다.

| 사례 | 조작 | 반드시 증명할 결과 |
|---|---|---|
| queued old bytes | old geometry output을 pipe/flip queue에 넣고 master read 전에 resize | 모든 queued byte는 boundary 이전 epoch |
| freeze 직전/직후 writer | 여러 process/thread가 barrier 양쪽에서 고유 nonce를 write | byte 누락·중복 없이 하나의 offset/epoch 순서 |
| delayed cached geometry | child가 80을 저장, 500ms quiet와 120 resize 뒤 `LATE_OLD:80` write | 구 epoch으로 판별하지 못하면 capability false |
| external slave fd | session leader 밖 process에 dup된 slave fd로 write | foreground `SIGWINCH`와 무관하게 분류 |
| kernel/host producer | Linux echo/ldisc와 Windows resize repaint/cursor query 유발 | application writer와 같은 boundary 계약 |
| split read/write | 1-byte부터 큰 chunk까지 read size 변경, Windows overlapped pending 강제 | frame/offset이 chunking과 무관 |
| empty sabotage | `poll` non-readable/pipe empty 직후 old producer release | empty 관찰이 barrier로 승격되지 않음 |
| resize failure | invalid size, pipe break, cancellation, fault injection | `Applied | NotApplied | Indeterminate` 권위 분류 |
| lifecycle race | resize 중 close, child exit, fd/handle reuse, generation 교체 | stale record가 새 terminal에 적용되지 않음 |
| long run | output offset/epoch 경계와 backpressure를 장시간 반복 | wrap·memory growth·record starvation 없음 |

Windows에서는 inbox ConPTY와 side-loaded fork가 섞이지 않도록 executable/DLL hash, OS build, sideband ABI를
artifact에 남긴다. Linux에서는 kernel release뿐 아니라 build ID/config와 capability struct 전체를 남긴다.
지원 matrix의 각 OS/version/architecture에서 positive test가 없으면 그 조합은 false다.

## 6. upstream과 제품화 gate

### Windows

1. Microsoft Terminal maintainers가 writer coverage와 내부 lock ordering을 검토해야 한다.
2. 공개 ConPTY API 확장인지, side-loaded `winconpty.dll`+`OpenConsole.exe` 전용 ABI인지 결정해야 한다.
3. ABI version negotiation, binary hash allowlist, Microsoft/in-house signing, 보안 update SLA, crash dump/privacy,
   rollback과 지원 Windows build를 ADR로 승인해야 한다.
4. patched binary 없이 inbox API로 조용히 fallback하지 않는다. primitive가 없으면 exact=false다.

### Linux

1. tty maintainer와 linux-api 검토를 거쳐 UAPI가 채택되어야 한다. out-of-tree ioctl 번호를 제품 ABI로 고정하지
   않는다.
2. merged commit, 최초 release, stable backport 여부를 추적하되 runtime은 capability ioctl로 탐지한다.
3. upstream 전 private kernel/module 배포는 GPL source/notice, Secure Boot module signing, distro별 packaging,
   kernel update cadence와 rollback을 별도 승인해야 한다.
4. 모듈만으로 core tty buffer/UAPI를 안전하게 바꿀 수 있다는 증거가 없다. kprobe/eBPF 관찰을 authoritative
   provenance로 승격하지 않는다.

## 7. 결론

OpenConsole에는 resize signal 처리와 VT output writer가, Linux에는 winsize update와 PTY flip-buffer enqueue가
각각 분리되어 있다. 두 코드베이스 모두 패치로 **enqueue-time byte epoch**를 만들 후보 선형화점은 존재한다.
Windows는 sideband offset protocol, Linux는 opt-in framed UAPI가 legacy VT stream을 오염시키지 않는 최소
방향이다.

그러나 이 문서는 구현이 아니고, 두 RFC 모두 resize 전에 geometry를 저장했다가 resize 뒤에 쓰는 임의
producer의 semantic provenance를 판별하지 못한다. 실제 OS patch, 모든 writer coverage 감사, ABI/upstream 및
서명·배포 승인, 위 sabotage 전체와 capability-positive 실기기 test가 모두 없으므로 issue #643의 완료 조건은
충족되지 않았다. 그 전까지 laymux는 이 연구를 근거로 `exactGeometryCutover=true`를 광고하거나 three-phase
production path를 연결해서는 안 된다.
