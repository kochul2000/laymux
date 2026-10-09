# 0305. PTY 데몬과 `lx` IPC는 현재 사용자 전용 Unix domain socket을 쓴다

- Status: Proposed
- Date: 2026-10-09
- Source: #1150, [ADR-0300](0300-detached-pty-daemon-core.md) Alternatives "Windows named pipe + logon SID ACL"·Consequences "인증 수준", [ADR-0304](0304-lx-endpoint-file.md) "이번 결정에 포함하지 않는 것", [PTY 데몬 후속 계획](../pty-daemon/followup-plan.md) §3.3 단계 C
- 정정: ADR-0300의 Windows endpoint(loopback TCP), ADR-0304의 endpoint 파일 위치(설정 디렉터리)

## Context

Windows에서 PTY 데몬 endpoint와 `lx` IPC는 모두 loopback TCP였다. loopback 포트에는 같은 머신의 **다른 로컬 사용자도 연결할 수 있다.**

- **PTY 데몬:** token·HMAC proof로 명령과 입력은 지켰다. 그러나 인증 전 연결이 동시 연결 한도(256)를 함께 쓴다. 다른 사용자가 연결을 계속 다시 열면 새 터미널 생성, id 기반 종료, 앱 종료 정리를 막을 수 있었다(#1150). PTY 데몬이 기본 경로가 되면서(ADR-0301) 이 노출도 기본이 됐다.
- **`lx` IPC:** 인증이 아예 없었다. 다른 로컬 사용자가 그 포트로 `lx send-command --group …`을 보내면 이 사용자의 터미널에 명령을 써 넣을 수 있었다.

Linux는 이미 사용자 전용 디렉터리 안의 0600 Unix socket이라 해당하지 않았다. `lx` socket만 `/tmp`에 umask 권한으로 있었다.

레퍼런스를 보면 Orca·zellij·WezTerm은 Windows에서 기본 보안 named pipe나 AF_UNIX를 쓰고 사용자를 격리하지 않는다. 사용자 격리를 구현한 Rust 예로는 DataDog agent와 trycua/cua가 있다. 둘 다 named pipe에 현재 사용자 SID DACL을 건다.

## Decision

**두 플랫폼 모두 PTY 데몬과 `lx` IPC는 Unix domain socket을 쓰고, socket 파일은 현재 사용자만 연결할 수 있게 만든다. Windows에서는 AF_UNIX(Windows 10 1803 이상)와 현재 사용자·SYSTEM만 허용하는 protected DACL을 쓴다.**

- **Windows 접근 통제.** AF_UNIX에 연결하려면 socket 파일에 쓰기 권한이 필요하다. bind 직후 socket 파일에 `D:P(A;;FA;;;<현재 사용자 SID>)(A;;FA;;;SY)` DACL을 건다. 이 DACL은 상속을 끊는다. 그래서 다른 로컬 계정은 OS가 연결을 거부한다.
- **디렉터리.** socket이 들어 있는 디렉터리도 사용자 전용으로 만든다. Linux는 0700, Windows는 현재 사용자·SYSTEM에게만 상속되는 protected DACL(`OICI`)이다. 그래서 그 안에서 만들어지는 socket·token·lock 파일은 생성되는 순간부터 사용자 전용이다. bind와 파일 DACL 적용 사이에 다른 계정이 끼어들 틈이 없고, 다른 계정은 파일을 지우거나 바꾸거나 token을 읽을 수 없다. 기본 위치(`%LOCALAPPDATA%` 아래)도 계정에 따라 다른 사용자 그룹(예: 샌드박스 계정)이 상속 권한을 갖는 경우가 실제로 있었으므로, 상속에 기대지 않는다. 파일 단위 DACL은 그 아래 두 번째 층이다.
- **Linux.** socket을 0600으로, 디렉터리를 0700으로 만든다.
- **위치.**
  - 데몬 socket은 데몬 디렉터리의 `daemon.sock`이다(두 플랫폼 공통).
  - `lx` socket과 ADR-0304의 endpoint 파일은 로컬 상태 디렉터리의 사용자 전용 `lx/` 디렉터리에 둔다(`lx/lx-{GUI pid}.sock`, `lx/endpoint.json`). ADR-0304가 정한 설정 디렉터리 위치를 정정한다. 설정 디렉터리는 사용자 설정 파일이 있는 곳이라 디렉터리 ACL을 바꾸지 않는다. Windows Roaming 프로필이나 Linux `~/.config` 공유(NFS) 환경에서 socket이 동기화되거나 다른 호스트의 pid로 잘못 정리되는 문제도 이렇게 피한다.
  - `lx` socket을 프로세스마다 따로 두므로, 실수로 뜬 두 번째 GUI가 첫 GUI의 socket을 지우지 않는다. GUI는 정상 종료할 때 자기 socket을 지우고, 기동할 때 프로세스가 없는 GUI의 socket 파일을 정리한다.
- **유지하는 것.** 데몬의 token과 양방향 proof, 인증 전 frame 상한, 동시 연결 상한, handshake 전체 deadline은 그대로 둔다. socket 권한은 바깥 경계이고, token은 같은 사용자 안의 다른 build kind나 오래된 endpoint를 구분한다.
- **wire 호환.** endpoint 형식이 바뀌므로 데몬 protocol version을 3으로 올린다. 이전 버전 데몬은 ADR-0300 규칙대로 호환되지 않는 데몬으로 판정한다.
- **구현.** 플랫폼 차이는 `local_socket` 모듈 하나에 둔다. Windows AF_UNIX는 `uds_windows` crate(MIT)를 쓰고, DACL은 `windows-sys` Win32 Security API로 직접 설정한다.

## Alternatives Considered

- **Windows named pipe + 현재 사용자 DACL(DataDog·cua):** OS 경계는 같다. 그러나 동기 named pipe는 read timeout을 지원하지 않는다. handshake deadline, spawn 응답 timeout, 종료 요청 timeout을 overlapped I/O나 `CancelSynchronousIo` 감시 thread로 다시 만들어야 한다. 인스턴스를 연결마다 새로 만드는 accept 루프도 필요하다. AF_UNIX는 socket이라 기존 timeout·shutdown·`try_clone` 코드를 그대로 쓴다.
- **loopback TCP 유지 + 인증 전 연결 한도 분리:** GUI의 정상 연결도 인증 전 단계를 거치므로, 다른 사용자가 그 한도를 채우면 GUI 연결도 똑같이 막힌다. 근본 해결이 아니다.
- **기본 ACL에 의존(Orca·zellij·WezTerm):** `LAYMUX_PTY_DAEMON_DIR`처럼 위치를 바꾸면 보호가 사라진다. 기본 위치에도 다른 계정의 상속 권한이 있는 환경이 실제로 있었다. 디렉터리와 파일 양쪽에 protected DACL을 걸면 위치와 상속 설정에 관계없이 같은 경계가 된다.

## Consequences

- 다른 로컬 계정은 PTY 데몬에도 `lx` IPC에도 연결할 수 없다. #1150의 연결 슬롯 DoS와 `lx` 명령 주입 경로가 OS 수준에서 닫힌다.
- Windows 10 1803 미만은 지원하지 않는다. laymux의 ConPTY 요구(1809)가 이미 그보다 높다.
- 의존성이 하나 늘어난다(`uds_windows`).
- `lx` socket이 `/tmp`(Linux)와 loopback 포트(Windows)에서 로컬 상태 디렉터리의 `lx/`로 옮겨 간다.
- 같은 사용자의 다른 계정, 예를 들어 Codex Windows 샌드박스 계정(`CodexSandboxUsers`)에서 실행한 명령의 `lx` 호출은 이제 OS가 거부한다. 의도한 경계다.
- protocol 2 데몬이 남아 있으면 그 데몬의 세션은 새 GUI에 재결합되지 않는다. 그 세션은 ADR-0301의 기존 정책대로 남고, 업데이트 시 세대 처리는 단계 E에서 정한다.
- 검증:
  - 단위 테스트: Windows에서는 socket 파일과 디렉터리의 DACL이 protected이고, 현재 사용자 SID와 SYSTEM 두 항목만 있으며, 디렉터리 안에서 새로 만든 파일이 같은 두 항목만 상속하는지 확인한다. 다른 계정 없이 확인할 수 있도록 **SYSTEM 전용 DACL을 건 socket에 대한 현재 사용자의 connect를 OS가 `PermissionDenied`로 거부하는지**도 테스트한다. Linux에서는 0600·0700인지 확인한다. 동시 연결 상한을 채우면 다음 연결이 거부되고, 연결이 풀리면 다시 받는지도 확인한다.
  - 기존 데몬 테스트(실제 ConPTY·셸)와 `lx` IPC 왕복 테스트가 새 transport에서 Windows·Linux 모두 통과하는지 확인한다.
  - dev 실기로 재결합과 `lx` 동작을 확인한다.
  - 다른 계정의 연결 거부는 같은 머신에 계정을 하나 더 두어야 확인할 수 있어서 자동 테스트로 만들지 않는다. 대신 DACL 내용을 확인한다.
