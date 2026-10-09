# 0304. 터미널의 `lx`는 고정 경로 endpoint 파일로 IDE를 찾는다

- Status: Proposed
- Date: 2026-10-09
- Source: [ADR-0301](0301-pty-daemon-default-adoption.md) Consequences "`lx`", [PTY 데몬 후속 계획](../pty-daemon/followup-plan.md) §3.2 단계 B, [data-flow §8.2](../architecture/data-flow.md)

## Context

GUI는 터미널을 띄울 때 `LX_SOCKET`에 자신의 IPC endpoint를 넣었다. Windows에서는 GUI마다 다른 loopback 랜덤 포트(`127.0.0.1:{port}`)이고, Linux에서는 세션마다 다른 `/tmp/lx-{session}.sock`이다.

PTY 데몬(ADR-0300·0301)으로 셸이 GUI보다 오래 살게 됐다. crash 뒤 재결합한 셸의 `LX_SOCKET`은 죽은 GUI를 가리키므로, 그 셸에서 실행한 `lx`(`sync-cwd`, `notify`, `open-file` 등)는 셸을 새로 열기 전까지 계속 실패한다. 환경 변수는 프로세스가 시작된 뒤에 바꿀 수 없다.

추가로 `lx`는 `LX_SOCKET`을 항상 TCP 주소로 연결했다. 그래서 Linux의 Unix socket 경로에는 연결할 수 없었다.

레퍼런스는 다음과 같다.

- Orca: 자식 env에는 고정 파일 경로만 넣는다. 앱이 기동할 때마다 그 파일을 원자적으로 다시 쓰고, 훅은 호출할 때마다 읽는다.
- VS Code: 오래 사는 프로세스 쪽의 고정 해시 경로를 쓴다.
- tmux: uid·label로 정해지는 고정 소켓 경로를 쓴다.
- 반례 WezTerm: `WEZTERM_UNIX_SOCKET=gui-sock-<pid>`를 쓰고, 죽은 경로도 그대로 따른다.

agent hook은 `LX_AUTOMATION_PORT`(build kind별 고정 포트)와 metadata로 이어받은 token을 쓰므로 이미 GUI가 바뀌어도 유효하다(ADR-0301). 이 결정의 범위는 `lx` IPC다.

## Decision

**터미널 env에는 IDE endpoint 대신 build kind별 고정 경로의 endpoint 파일 위치(`LX_ENDPOINT_FILE`)를 넣는다. GUI는 IPC 서버를 연 직후 그 파일을 원자적으로 다시 게시하고, `lx`는 실행할 때마다 파일을 읽어 현재 GUI에 연결한다.**

- **파일.** 설정 디렉터리에 `automation.json`과 나란히 `lx-endpoint.json`을 둔다(`%APPDATA%\laymux[-dev]`, `~/.config/laymux[-dev]`). 내용은 `{ "endpoint", "pid" }`이며 `pid`는 진단용이다.
  - 같은 디렉터리에 임시 파일로 쓴 뒤 rename으로 교체한다. 동시에 실행된 `lx`는 이전 endpoint나 새 endpoint 중 하나를 읽고, 쓰다 만 파일은 읽지 않는다.
- **build kind 분리.** release와 dev는 디렉터리가 다르므로 서로의 파일을 읽지 않는다. build kind당 GUI는 하나다(AGENTS.md).
- **env.** `LX_SOCKET`을 없애고 `LX_ENDPOINT_FILE`로 대체한다. 내부 개발 단계이므로 둘을 함께 두는 호환 기간을 두지 않는다.
  - GUI가 파일을 게시하지 못하면 이 변수를 넣지 않는다. 그러면 `lx`는 "Laymux 터미널이 아니다"로 실패한다.
- **연결.** `lx`는 Windows에서는 TCP, Unix에서는 Unix socket으로 연결한다. 연결이 실패하면 endpoint와 원인을 출력하고 실패한다. 다른 경로를 추측해 찾지 않는다.
- **이번 결정에 포함하지 않는 것.**
  - Windows IPC가 loopback TCP라서 다른 로컬 사용자도 연결할 수 있다. 사용자 전용 transport는 단계 C(#1150)에서 데몬 transport와 함께 정한다.
  - Linux 소켓 위치(`/tmp`)도 단계 C에서 정한다.

## Alternatives Considered

- **IPC endpoint 자체를 고정(Windows 고정 포트, Linux 고정 소켓 경로):** env는 그대로 유효하다. 그러나 Windows 고정 포트는 다른 프로그램과 충돌할 수 있고, release와 dev를 나눠도 포트를 하나 더 예약해야 한다. 파일 간접화는 transport를 바꾸지 않는다. 단계 C에서 사용자 전용 named pipe(고정 이름)로 바꾸면 다시 검토할 수 있다.
- **데몬이 고정 endpoint를 맡아 현재 GUI로 중계:** GUI가 없는 동안에도 받을 수 있다. 그러나 데몬이 `lx` 프로토콜과 GUI 라우팅을 알게 된다. 단계 G(GUI 미접속 이벤트)와 함께 판단한다.
- **`lx`가 automation HTTP API(고정 포트)로 말하게 변경:** 이미 고정이지만, `lx` 프로토콜 전체를 HTTP로 옮기고 인증 체계도 맞춰야 한다. 범위에 비해 크다.
- **재결합 때 셸에 새 env를 주입:** 실행 중인 프로세스의 환경을 바꿀 방법이 없다.

## Consequences

- crash 뒤 재결합한 셸에서도 `lx`가 새 GUI에 연결된다. Linux에서도 `lx`가 Unix socket에 연결된다.
- `lx`는 호출할 때마다 작은 JSON 파일을 하나 읽는다.
- GUI가 정상 종료해도 파일은 남는다. 이 파일을 가리키는 셸은 그때 이미 끝나 있거나 다음 GUI가 덮어쓴다. 남은 파일을 읽은 `lx`는 연결 실패를 그대로 보고한다.
- `LX_SOCKET`을 직접 읽던 사용자 스크립트는 `LX_ENDPOINT_FILE`과 `lx`를 쓰도록 바꿔야 한다.
- 검증:
  - 단위 테스트: 원자적 교체, 없는 파일·깨진 파일, 변수가 없을 때의 오류.
  - 통합 테스트: 실제 IPC 서버 두 개를 차례로 게시해도 같은 env 값으로 매번 마지막 GUI에 닿는지(Windows·Linux).
  - dev 실기: GUI만 강제 종료 → 재결합한 셸에서 `lx` 성공.
