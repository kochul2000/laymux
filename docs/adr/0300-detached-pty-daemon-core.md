# 0300. 터미널 PTY와 자식 프로세스는 GUI와 분리된 PTY 데몬이 소유한다 (opt-in 코어)

- Status: Proposed
- Date: 2026-10-08
- Source: 사용자 요구("superset 같은 공개된 리포를 참고해서 우선 PTY 데몬 분리까지만 가장 코어로직만 구현… 업데이트 인계 등은 그 다음 PR로 쪼개서 단계적으로"), 닫힌 [PR #1143](https://github.com/kochul2000/laymux/pull/1143), [Superset terminal host daemon](https://github.com/superset-sh/superset/blob/main/apps/marketing/content/blog/terminal-daemon-deep-dive.mdx), [data-flow.md §8.23](../architecture/data-flow.md#823-pty-소유자와-pty-데몬-opt-in)
- 관계: ADR-0001(OSC Rust 단일 패스)·ADR-0067(번들 ConPTY)·ADR-0088(출력 콜백 Stop 경계)을 그대로 유지한다. ADR-0201·0222·0270·0296의 종료·업데이트 barrier는 바꾸지 않는다. 닫힌 PR #1143의 0300~0305 초안은 main에 들어간 적이 없으며 채택하지 않는다.

## Context

laymux의 터미널 PTY(ConPTY/Unix PTY)와 자식 셸은 Tauri GUI 프로세스가 직접 소유한다. GUI가 crash하거나 재시작·업데이트되면 실행 중인 셸·Codex·빌드가 함께 끝나고, 디스크 복원점(ADR-0299)으로 새 프로세스를 다시 띄울 수밖에 없다.

PR #1143은 이 문제를 데몬으로 풀려고 PTY 소유, headless xterm parser·query 응답, 단일 SQLite writer, 업무 이벤트 journal, GUI 재결합, 업데이트 인계를 한 PR에 담았다. 100개 파일 규모라 리뷰와 실기 검증이 끝나지 않았고 재시작 후 화면 복원도 실패한 채 닫혔다. 사용자는 PTY 수명 분리라는 코어만 먼저 넣고 나머지는 후속 PR로 단계화하기로 했다.

Superset은 Electron 앱 재시작을 넘어 터미널을 유지하려고 별도 terminal host 데몬이 PTY를 소유하게 했다. 사용자 전용 socket과 token 파일로 인증하고, handshake에 protocol version을 둔다. 앱 종료·연결 종료를 세션 kill로 해석하지 않는다. 처음에는 하나의 socket에 RPC와 출력을 함께 실었다가 head-of-line blocking 때문에 분리했다. 이 교훈들은 laymux에도 그대로 적용된다. 다만 Superset은 Node 런타임, 세션별 subprocess, headless emulator snapshot을 함께 쓰며 Windows를 지원하지 않는다.

이번 결정의 범위는 **PTY와 자식 프로세스의 소유권을 GUI 밖으로 옮기는 것**이다. GUI가 연결 없이 사라져도 작업이 데몬에 남고, 같은 세션에 다시 attach할 수 있는 프로토콜까지 포함한다.

비목표는 다음과 같다. 이 항목들은 각각 후속 단계에서 별도 ADR로 결정한다.

- 새 GUI가 시작할 때 살아 있는 세션을 pane에 자동으로 재결합하기
- 업데이트·명시적 재시작의 인계
- 화면 snapshot과 headless parser
- GUI 미접속 중 OSC·훅·DB 처리
- 데몬 runtime의 staging과 GC
- 기본 활성화

## Decision

**터미널의 OS PTY와 자식 프로세스는 같은 실행 파일을 `laymux --pty-daemon`으로 띄운 데몬이 소유한다. GUI는 `portable_pty::PtySystem`의 원격 구현으로 그 PTY를 사용하며, 이번 단계는 `LAYMUX_PTY_DAEMON=1` opt-in이다.**

### 경계와 책임

- 경계는 `PtySystem` seam이다. GUI는 in-process PTY와 같은 방식으로 argv, 전체 환경, cwd를 만든다. 출력 콜백(protocol mode, OSC 단일 패스, 출력 ring·delivery credit), 제어 FIFO, `PtyHandle` 계약도 backend와 무관하게 동일하다. ADR-0001의 OSC 처리 위치는 바뀌지 않는다.
- 데몬은 PTY의 생성·입력·resize·종료, 자식 대기, 출력 중계만 수행한다. OSC 해석, protocol reply, 출력 ring, 설정, DB와 같은 laymux 터미널 로직은 갖지 않는다. 데몬은 받은 명령을 그대로 spawn하며 자신의 환경을 섞지 않는다.
- 새 사용자 터미널의 backend는 생성 시점에 정한다. opt-in이 켜져 있는데 데몬에 연결할 수 없으면 해당 터미널 생성을 실패시킨다. 수명이 다른 local PTY로 조용히 fallback하지 않는다. 숨은 usage probe PTY는 계속 GUI가 소유한다.

### 세션 수명

- 세션 key는 `{terminal_id}#{generation}-{random}`이다. generation은 GUI 프로세스마다 1부터 다시 시작한다. 그래서 random 접미사가 없으면, 새 GUI의 key가 이전 GUI가 남긴 세션과 충돌한다. 같은 key의 중복 spawn은 거절하고 살아 있는 세션은 건드리지 않는다.
- 연결 종료는 crash든 정상 종료든 **detach**다. 세션을 끝내는 경로는 명시적 `Terminate`와 자식 종료 두 가지뿐이다.
- 터미널 삭제·재시작·업데이트 guard처럼 `PtyHandle` teardown이 master를 drop하거나 child를 kill하면, GUI는 그 세션의 종료를 요청한다.
- 종료 요청은 항상 새 연결로 보내며, 세션 id를 지정한 `TerminateSession`으로 요청하고 데몬의 `Terminating` 응답을 기다린다.
  - 터미널 연결에 실으면, 데몬이 자식 stdin에 쓰느라 막힌 입력 frame 뒤에 줄을 선다. 그 연결이 이미 끊겼을 수도 있다.
  - 응답을 받은 시점에는 요청이 데몬에 도달해 있다.
  - 실패는 `ChildKiller::kill`의 오류로 전파된다.
  - master drop(lock을 쥔 채 일어남)에서는 별도 thread로 요청한다.
  - spawn이 끝나기 전에 도착한 요청은 기억해 두었다가 handle이 생기는 즉시 적용한다.
- 앱 종료 경로에서는 `AppState`의 `Drop`이 실행되지 않는다. in-process PTY는 프로세스 종료 시 OS가 handle을 닫아서 끝나지만, 데몬 PTY는 그대로 두면 detach될 뿐이다. 그래서 GUI는 `RunEvent::Exit`에서 데몬이 소유한 모든 터미널의 종료를 병렬로 요청하고, 전체를 2초 deadline으로 묶는다. 데몬이 응답하지 않으면 이 deadline만큼 종료가 늦어진다. 이것으로 "앱 닫기 = 작업 종료"를 best-effort로 유지한다. 실패하거나 deadline이 넘은 세션은 데몬에 남는다.
- GUI가 crash나 강제 종료처럼 정리 없이 사라지면 작업은 데몬에 남는다.
- 종료 요청이 세션 id 기반이므로, GUI 쪽 터미널 연결이 끊긴 세션도 터미널 teardown과 앱 종료 때 정리된다.
- 자식이 스스로 끝나면 데몬이 입력과 master를 닫는다. ConPTY는 pseudoconsole이 닫힐 때까지 출력 EOF를 내지 않으므로, 이렇게 해야 남은 출력이 전달된 뒤 세션이 제거된다. master가 바쁘면 잠시 재시도하고, 그래도 안 되면 lock을 기다려 닫는다. 포기하면 세션이 영구히 남기 때문이다.
- 데몬이 자식을 대기하는 handle을 들고 있으므로 process tree kill도 데몬이 수행한다. GUI는 데몬 자식의 PID를 직접 kill하지 않는다. 그 PID는 GUI가 handle을 갖지 않아 재사용될 수 있기 때문이다.
- 세션은 출력 EOF와 자식 종료를 모두 관측한 뒤 제거한다. 그때 attach된 client가 없으면 마지막 출력은 버린다.

### 출력과 attach

- 연결은 터미널마다 하나이다. 한 터미널의 출력 flood가 다른 터미널의 출력과 제어를 막지 않는다(Superset의 head-of-line 교훈).
- frame은 `u32 LE 길이 | kind | payload`다. control은 JSON, PTY 데이터는 raw byte이며 frame은 1 MiB를 넘을 수 없다.
- client가 attach돼 있으면 데몬은 PTY 콜백에서 socket에 blocking write한다. GUI 쪽 수신 queue도 약 64 KiB(검사 시점 기준 최대 64 KiB + 4 KiB chunk 하나)로 제한한다. 따라서 느린 GUI의 backpressure는 in-process 콜백과 같은 방식으로 PTY까지 전달된다.
- attach된 client가 없으면 데몬은 계속 PTY를 읽는다. 최근 1 MiB를 backlog로 유지하고 넘친 앞부분은 버린 바이트 수로 센다. 아무도 보지 않는 세션 때문에 자식이 출력 pipe에서 멈추지 않는다.
- attach는 한 세션에 한 client만 허용한다. 새 attach는 이전 client 연결을 닫고 대체한다. 새 client는 `Attached` → backlog → 이후 live 출력 순서로 받으며, 그 사이에 live 출력이 끼어들지 않는다. backlog는 전달에 성공한 뒤에만 비우므로, replay 도중 끊긴 client는 다음 attach에 backlog를 남긴다.
- 읽기를 멈춘 client 때문에 PTY reader가 출력 write에서 막힐 수 있다. 이때 attach는 출력 lock을 기다리기 전에 이전 client의 socket을 닫아 reader를 풀어 주고, 자신을 먼저 현재 client로 게시한다. 그래서 replay 중에 멈춘 새 client도 그다음 attach가 같은 방식으로 밀어낼 수 있다. 세션 목록 조회는 출력 lock을 쓰지 않는다.
- backlog는 raw byte다. 재결합 단계에서는 replay가 protocol reply나 업무 OSC를 다시 일으키지 않도록 별도 결정이 필요하다(ADR-0001·0068).

### IPC·인증·인스턴스

- 데몬 디렉터리는 build kind별로 둔다. Windows는 `%LOCALAPPDATA%\laymux[-dev]\pty-daemon`, Linux는 `$XDG_STATE_HOME/laymux[-dev]/pty-daemon`(기본 `~/.local/state`)이다. 격리된 dev·test는 `LAYMUX_PTY_DAEMON_DIR`로 디렉터리를 바꾼다. release GUI는 dev 데몬에 연결하지 않으며 그 반대도 같다.
- Linux endpoint는 0700 디렉터리 안의 0600 Unix socket이다. Windows endpoint는 기존 `lx` IPC와 같은 loopback TCP다. loopback이 아닌 endpoint에는 연결하지 않는다. 외부 Automation 포트와 endpoint를 공유하지 않는다.
- 모든 연결은 첫 frame에서 인스턴스마다 생성한 32바이트 random token과 protocol version을 제시한다. token은 사용자 전용 디렉터리의 discovery 파일에만 둔다. Linux는 디렉터리 0700, 파일 0600을 직접 설정한다. Windows는 별도 ACL을 설정하지 않고 `%LOCALAPPDATA%`의 기본 사용자 ACL에 의존한다. `LAYMUX_PTY_DAEMON_DIR`로 바꾼 디렉터리의 보호는 그 경로의 권한에 따른다. 데몬은 token을 상수 시간으로 비교하며, token이 틀리거나 version이 다르면 다른 요청을 처리하지 않는다. 인증 전 frame은 4 KiB, 동시 연결은 256개로 제한하고, 초과한 연결은 대기열에 넣지 않고 바로 닫는다. GUI는 spawn 응답에도 5초 deadline을 둔다.
- 데몬 생존은 연결 성공이 아니라 디렉터리의 instance lock이 잡혀 있는지로 판정한다. 그래야 오래된 discovery의 endpoint를 다른 프로그램이 재사용해도 속지 않는다.
- protocol version이 다른 데몬이 살아 있으면 GUI는 그 데몬을 kill하거나 교체하지 않고 오류를 반환한다. 그 데몬이 실행 중인 작업을 소유할 수 있기 때문이다.
- 디렉터리당 데몬은 하나다. 단일 인스턴스는 kernel file lock으로 보장한다. PID나 discovery 파일이 있다는 사실만으로 데몬을 신뢰하지 않는다. GUI의 생존 판정이 순간적으로 lock을 쥘 수 있으므로, 데몬은 lock 획득을 잠시 재시도한다. 그래도 얻지 못한 두 번째 인스턴스는 종료한다.
- GUI는 데몬을 `current_exe --pty-daemon <dir>`로 띄운다. 디렉터리는 환경 변수가 아니라 인자로 넘긴다. GUI 환경을 바꾸면 그 환경을 상속하는 터미널에 새어 나가기 때문이다.
- Linux에서는 `headless_command`로 독립 process group을 만든다. std가 연 descriptor는 close-on-exec라서 상속되지 않는다. 다른 라이브러리가 직접 연 descriptor는 이 보장 범위 밖이다.
- Windows의 `std::process::Command`는 항상 handle 상속을 켠다. 그대로 쓰면 GUI의 console pipe와 GUI가 아직 소유한 in-process PTY(usage probe)의 pipe 끝이 오래 사는 데몬에 넘어가 EOF가 오지 않는다. 그래서 Windows에서는 `CreateProcessW`를 `bInheritHandles = FALSE`, `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`으로 직접 호출한다. `headless_command`의 창 깜빡임 방지 의도는 같은 flag로 지킨다. job breakaway를 시도하고, 거절되면 job 안에서 띄운다.
- 데몬은 세션과 연결이 모두 없는 상태가 60초 지속되면 스스로 종료한다. 연결을 받아들이는 일과 idle 종료 판정은 같은 lock으로 직렬화한다. 따라서 막 받아들인 연결은 판정 전에 계산되거나, 판정 후라면 거절된다.
- 데몬 연결이 끊기면 GUI는 해당 terminal의 reader를 실패로 끝내고 child를 종료된 것으로 처리한다. 데몬 안의 작업은 계속 실행된다.

## Alternatives Considered

- **PR #1143 범위를 한 번에 진행:** 데몬이 parser·DB·journal·인계까지 소유하는 최종 구조는 맞을 수 있다. 그러나 리뷰와 실기 검증이 불가능한 크기였고 재시작 복원도 실패했다. 소유권 분리 코어를 먼저 넣고 위 단계를 순서대로 쌓는다.
- **터미널 로직(OSC·출력 ring·attribution)을 지금 데몬으로 이동:** GUI 없이도 업무 처리를 계속하려면 결국 필요할 수 있다. 하지만 PTY 수명 분리에는 필요 없고, ADR-0001과 출력 계약 전체를 다시 검증해야 한다. 이번에는 `PtySystem` seam만 바꾼다.
- **Superset 구조 그대로(Node 데몬 + 세션별 subprocess + headless emulator):** laymux PTY는 이미 Rust이므로 Node 런타임을 동봉할 이유가 없다. 세션별 subprocess 격리와 화면 snapshot은 재결합 단계에서 필요성을 판단한다.
- **tmux 등 외부 multiplexer:** 사용자 설치 의존성이 생기고 native Windows를 지원하지 못한다. xterm과 스크롤·선택·키 처리가 충돌하는 문제도 Superset이 보고했다.
- **Windows named pipe + logon SID ACL:** loopback TCP보다 OS 경계가 강하다. 그러나 Win32 pipe 서버 코드와 검증 비용이 크다. 이번 단계는 기존 `lx` IPC와 같은 loopback + per-instance token으로 두고, 기본 활성화 전에 강화를 재판정한다.
- **하나의 공유 socket에 RPC와 모든 출력을 함께 전송:** Superset v1의 head-of-line blocking이 그대로 재현된다.
- **별도 데몬 실행 파일:** 서명·번들·설치 자원이 하나 늘어난다. 같은 실행 파일의 별도 모드는 GUI 초기화 전에 분기하므로 Tauri 자원을 쓰지 않는다. runtime staging은 업데이트 인계 단계에서 결정한다.
- **연결 0개면 세션 자동 종료:** 구현은 단순하지만 데몬 분리의 목적(GUI 수명과 무관한 작업 유지)을 깨뜨린다.

## Consequences

opt-in을 켜면 GUI crash나 강제 종료 뒤에도 셸과 에이전트 작업이 데몬에서 계속 실행된다. 세션은 detach 상태로 출력 backlog를 유지하며, 프로토콜 메시지(`Attach`·`List`·`TerminateSession`)로 다시 연결하거나 명시적으로 끝낼 수 있다. 이 단계에는 이를 호출하는 사용자 경로(UI·CLI)가 없다. 정상적인 앱 종료, 터미널 삭제, 업데이트의 사용자 PTY 종료는 지금과 같은 의미로 동작한다. 기본 경로(opt-in 꺼짐)의 동작은 바뀌지 않는다.

다음 비용과 위험이 남는다.

- **재결합 부재:** 아직 GUI가 시작 시 detach된 세션을 pane에 재결합하지 않는다. opt-in 상태에서 GUI가 crash하면 그 세션은 다음 GUI에 보이지 않은 채 남고, 자식이 끝날 때까지 실행된다. 사용자가 끝낼 경로가 없고, 남은 세션 때문에 데몬의 idle 종료와 Windows 업데이트의 파일 잠금 해제도 막힌다. 재결합과 업데이트 전 데몬 종료가 바로 다음 단계다.
- **업데이트 미지원:** Windows에서는 데몬이 설치 디렉터리의 `laymux.exe`와 ConPTY 이미지를 실행한다. 업데이트 설치는 마지막 세션 이후 데몬이 idle 종료할 때까지 파일 잠금에 막힐 수 있다. opt-in 상태의 업데이트는 인계 단계 전까지 지원 대상이 아니다.
- **raw backlog replay:** backlog는 raw byte이고 1 MiB를 넘은 앞부분은 손실된다. 재결합 단계에서 화면 복원·query 재응답 방지 계약을 정해야 한다.
- **인증 수준:** Windows endpoint의 보호는 loopback과 사용자 전용 discovery의 token에 의존한다.
- **process tree kill:** Windows는 생성자 PID를 기록한다. 그래서 GUI가 살아 있는 동안 GUI를 tree 단위로 끝내면(`taskkill /T`, 작업 관리자의 "프로세스 트리 끝내기", `scripts/kill-dev.sh`) 데몬과 그 작업도 함께 끝난다. 단일 프로세스 crash나 강제 종료에서는 데몬이 살아남는다. 중간 launcher를 통한 이중 spawn으로 부모 관계를 끊을지는 업데이트 인계 단계에서 결정한다.

검증은 다음 수준으로 둔다.

- **단위:** wire·discovery
- **in-process 데몬 서버 + 실제 OS PTY·셸:** spawn·입출력·resize·terminate, detach 후 backlog replay, attach 인계, 중복 거절, 인증·버전 거절, 인증 전 대형 frame 거절, 응답 없는 spawn timeout, 자연 종료 reap, 멈춘 client 축출, id 기반 종료
- **`AppState` 종료 경로:** 등록된 데몬 터미널이 종료 요청만으로 끝나는지 확인한다.

동시 연결 상한은 테스트하지 않는다. 실제 `laymux --pty-daemon` 프로세스에 대해서는 단일 인스턴스, client 프로세스 abort 뒤 세션과 자식 프로세스의 생존, 명시적 종료를 확인하는 통합 테스트를 둔다.

재결합, 업데이트 인계, 화면 snapshot, GUI 미접속 중 업무 처리, Windows pipe 강화, 기본 활성화는 각각 별도 ADR로 결정한다. 그 결정이 이 문서의 경계(데몬은 PTY만 소유)를 바꾸면 새 ADR로 이 문서를 대체한다.
