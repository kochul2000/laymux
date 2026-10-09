# 0301. PTY 데몬을 기본으로 켜고, 새 GUI는 살아 있는 세션을 재결합한다

- Status: Proposed. Superseded by [0308](0308-pty-daemon-generations-across-updates.md) ("업데이트 전 데몬 종료"와 단일 데몬 디렉터리만; 기본 활성화·재결합·staging은 유지)
- Date: 2026-10-08
- Source: 사용자 결정("모든 작업이 끝나면 떼는거 맞니?" → 기본 활성화를 막는 회귀만 막히면 opt-in 제거), [ADR-0300](0300-detached-pty-daemon-core.md), [PR #1147](https://github.com/kochul2000/laymux/pull/1147), [data-flow.md §8.23](../architecture/data-flow.md#823-pty-소유자와-pty-데몬)
- 관계: ADR-0300의 "이번 단계는 opt-in" 결정과 "데몬에 연결할 수 없으면 터미널 생성 실패" 결정을 대체한다. 그 밖의 경계(데몬은 PTY만 소유)·수명·IPC 결정은 그대로 따른다. ADR-0201의 업데이트 전 PTY 종료는 유지하고, 그 경로에 데몬 종료를 더한다.

## Context

ADR-0300은 PTY와 자식 프로세스를 데몬으로 옮겼지만, 그대로 기본값으로 켜면 지금보다 나빠지는 지점이 셋 있어 opt-in으로 두었다.

1. **같은 작업의 중복 실행:** GUI가 crash하면 작업은 데몬에 남는다. 그런데 새 GUI는 그 세션을 모르고 SQLite 복원점으로 `codex resume <같은 ID>`를 새로 띄운다. 같은 대화가 두 프로세스에서 동시에 실행된다.
2. **실행 파일 잠금:** Windows에서 데몬이 설치(또는 `target`) 디렉터리의 `laymux.exe`와 ConPTY 이미지를 실행하면 파일이 잠긴다. 업데이트 설치기와 dev 재빌드(`failed to remove file … laymux.exe`, os error 5를 실측)가 그 파일을 교체하지 못한다.
3. **업데이트 경로:** 업데이트 guard가 사용자 PTY를 종료해도 데몬 프로세스는 idle 종료까지 남는다. 이전 GUI가 남긴 세션이 있으면 영원히 남는다.

화면 snapshot, 업데이트 중 작업 유지(인계), GUI 미접속 중 OSC·훅 처리는 기본 활성화 뒤에 넣어도 사용자 동작이 지금보다 나빠지지 않는다. 그래서 이번 결정의 범위에서 제외한다.

## Decision

**PTY 데몬을 기본으로 사용한다. 터미널을 만들 때 같은 terminal id로 분리된 채 살아 있는 데몬 세션이 있으면 새 자식을 띄우지 않고 그 세션을 재결합한다. 업데이트 전에는 데몬을 종료한다. Windows는 데몬을 실행 파일의 사본에서 실행한다.**

### 기본 활성화

- `LAYMUX_PTY_DAEMON`이 없거나 `0`이 아니면 사용자 터미널은 데몬 backend를 쓴다. `LAYMUX_PTY_DAEMON=0`은 되돌리기용 스위치로 남긴다. 실사용에서 문제가 없으면 별도 결정으로 제거한다.
- 데몬을 띄우거나 연결할 수 없거나, 데몬이 spawn을 거절·실패하면(staging 실패, 실행 정책, 업데이트 종료 중 등) 해당 터미널은 경고를 남기고 in-process PTY로 만든다. 기본값으로 켜진 상태에서 모든 터미널 생성이 실패하는 것은, 그 터미널 하나가 crash에서 살아남지 못하는 것보다 나쁜 회귀다.
- instance lock을 쥔 데몬이 인증 handshake에 답하지 않으면 새 데몬을 띄우지 않는다. 두 번째 인스턴스는 lock 때문에 곧바로 끝나기 때문이다. 기동 대기에 실패하면 GUI는 30초 동안 데몬을 시도하지 않고 바로 in-process로 만든다. 그래야 응답 없는 데몬 하나가 복원되는 pane마다 기동 timeout을 다시 물게 하지 않는다.

### 재결합

- 데몬 세션은 GUI terminal id(`terminal-<paneId>`)와 GUI가 맡긴 opaque metadata를 함께 보관한다. 세션 목록은 terminal id와 함께 attach·종료·종료 요청 상태를 알려 준다.
- 재결합은 GUI 프로세스 안에서 그 terminal id를 **처음 만들 때만** 시도한다. 생성에 실제로 성공했을 때만 기회를 소진한 것으로 기록하므로, 실패한 시도는 재시도 때 다시 재결합할 수 있다. 이후의 생성은 재시작·프로필 변경·remount이며 새 자식을 원하는 것이다. 그런 생성이 이 GUI가 방금 놓은 세션을 다시 잡아서는 안 된다.
- GUI는 세션 목록에서 같은 terminal id이면서, attach된 client가 없고, 종료되지도 종료 요청을 받지도 않은 세션을 후보로 찾는다. 데몬이 매긴 생성 순서에서 가장 최근 후보가 같은 프로필로 시작했으면 그 세션을 재결합한다. 나머지 후보는 그 pane이 보여 줄 수 없으므로 종료한다. 목록 조회는 5초 deadline을 두며, 실패하면 엉뚱한 작업을 가져오지 않도록 새 세션을 만든다.
- 재결합 attach는 데몬이 세션 lock 아래에서 원자적으로 판정한다. 이미 attach됐거나 종료 요청을 받은 세션이면 거절하고, GUI는 새 세션을 만든다. 두 GUI 생성 경로가 같은 세션을 나눠 갖지 않는다.
- 세션은 bind(spawn·attach)마다 attach epoch를 올린다. 소유 판정, epoch 증가, 종료 요청 표시, spawn 중 handle 게시는 모두 세션의 같은 claim lock 아래에서 일어난다. 그래서 재결합과 종료 요청이 서로 끼어들 수 없다. 남은 후보를 끝낼 때도 목록에서 본 epoch를 함께 보낸다. GUI의 종료 요청은 자신이 bind한 epoch를 함께 보낸다. 그 사이 다른 client가 재결합했으면 데몬은 요청을 `superseded`로 응답하고 세션을 남긴다. 늦게 도착한 이전 소유자의 종료가 새 소유자의 작업을 끝내지 않는다. bind 응답을 받기 전의 자기 spawn은 epoch 없이 종료하고, 거절된 재결합은 아무것도 종료하지 않는다. 실패를 보고할 수 없는 master drop 경로의 종료 요청은 3회까지 재시도한다.
- 재결합하면 GUI가 만든 명령은 실행하지 않는다. resume 복원 추적과 Codex 시작 전용 guard도 해제한다. 자식은 이미 그 대화를 실행하고 있다. 이 판단은 backend 선택이 아니라 **실제 결과**로 한다. 데몬이 재결합을 거절하면 GUI는 요청된 명령(resume 포함)으로 새 자식을 띄우고, 이때는 복원 추적과 guard를 그대로 둔다.
- GUI는 spawn 때 다음 값을 metadata로 맡기고, 재결합 때 다시 쓴다.
  - agent hook token: 자식 환경에 박혀 있으므로, 이 값을 써야 살아남은 자식의 훅이 새 GUI에서 계속 인증된다.
  - 시작 프로필: 재결합 대상을 고를 때 비교한다.
  - WSL relay 여부: 실행 중인 자식의 귀속 도메인을 복원한다.
- 재결합 attach는 **backlog를 replay하지 않는다.**
  - raw byte를 live 출력 경로로 다시 흘리면 terminal query에 다시 응답하고 OSC 업무 처리가 다시 일어난다(ADR-0001·0068).
  - 버린 바이트는 `droppedBytes`로 센다. GUI는 attach 직후 자기 grid 크기로 resize를 보낸다.
  - 화면은 그 뒤에 들어오는 출력부터 다시 그려진다.
  - 이전 화면 복원은 화면 snapshot 단계에서 결정한다.
- 재결합한 터미널의 CWD는 요청된 시작 디렉터리(마지막으로 알려진 값)로 시작하고, 다음 OSC 7부터 실제 값을 따른다.

### 프로토콜

- 재결합 필드(terminal id·metadata·replay·take_over·epoch)를 더하면서 protocol version을 2로 올린다. 이전 버전 데몬과는 서로 연결하지 않는다.
- 프로필 metadata가 없는 이전 세션은 재결합하지 않고 정리한다.

### 업데이트와 실행 파일

- 업데이트 guard는 GUI의 PTY를 종료한 뒤 데몬에 `Shutdown`을 보내고, instance lock이 풀릴 때까지 최대 5초 기다린다.
  - 데몬은 먼저 새 세션을 거절한다. 이어 spawn 중인 세션까지 포함해 모든 세션에 종료를 요청하고, 세션이 사라지면 끝난다.
  - 응답하지 않거나 프로토콜이 다른 데몬은 다음 두 조건을 모두 만족할 때만 강제 종료한다. 재사용된 PID를 죽이지 않기 위해서다.
    - discovery가 가리키는 PID이다.
    - command line이 `--pty-daemon <이 디렉터리>`임이 확인된다. 경로는 끝 구분자와 Windows 대소문자·구분자 표기를 정규화해 비교한다.
  - 업데이트 인계(작업 유지)가 이 종료를 대체할 때까지의 정책이다.
- Windows는 데몬을 띄우기 전에 실행 파일과 같은 디렉터리의 ConPTY 파일을 `<데몬 디렉터리>/runtime/<크기-수정시각>/`으로 복사하고, 그 사본을 실행한다.
  - 같은 key의 사본은 재사용한다.
  - ConPTY 파일이 없으면 staging을 실패시킨다. in-box conhost로 조용히 넘어가지 않는다(ADR-0067).
  - 다른 사본은 **데몬 실행 파일부터** 지워 보고, 지워질 때(실행 중이 아닐 때)만 나머지를 삭제한다. 그래서 살아 있는 데몬이 새 세션에 쓸 ConPTY 파일을 잃지 않는다. 다른 launcher가 만드는 중인 `.tmp` 사본, 실행 파일이 없는 디렉터리, 게시된 지 60초가 안 된 사본(그 launcher가 아직 데몬을 띄우지 않았을 수 있다)은 건드리지 않는다.
  - Linux는 실행 중인 binary 교체를 막지 않으므로 사본을 만들지 않는다.

### dev 검증

- dev 빌드는 React StrictMode로 mount하므로 모든 TerminalView가 처음에 PTY를 한 번 닫고 다시 연다. 그래서 dev에서는 재결합한 세션이 곧바로 종료된다. release에는 StrictMode가 없다.
- `VITE_LAYMUX_STRICT_MODE=0`으로 dev를 release와 같은 mount로 띄워 PTY 수명을 검증한다.

## Alternatives Considered

- **모든 후속 단계(인계·snapshot·업무 처리)가 끝난 뒤 기본 활성화:** 기본 경로가 오랫동안 데몬을 쓰지 않아 실사용 검증이 늦어진다. 남은 단계는 기본 활성화 뒤에 넣어도 회귀가 아니다.
- **데몬에 연결할 수 없으면 터미널 생성 실패(ADR-0300 유지):** 수명이 섞이지 않지만, 기본값에서 데몬 하나의 실패가 모든 터미널을 막는다.
- **frontend가 재시작 여부를 명시적으로 전달:** 정확하지만 TerminalView의 여러 생성 경로를 모두 바꿔야 한다. "GUI 프로세스 안에서 그 id의 첫 생성만 재결합"은 backend만으로 같은 구분을 한다.
- **재결합 없이 기본 활성화하고 시작 시 남은 세션을 모두 종료:** 현재 동작과 같아서 안전하지만 데몬의 이득이 하나도 생기지 않는다. 이후 재결합 PR에서 이 정리를 다시 걷어내야 한다.
- **backlog를 그대로 replay:** 이전 화면 일부가 보인다. 그러나 query 재응답이 실행 중인 앱에 입력으로 들어가고, OSC 업무 처리가 중복된다.
- **frontend에 replay 출처를 전달해 응답을 버리게 함:** 출력 delivery 계약(sequence·credit·repair) 전반을 바꿔야 한다. 화면 snapshot 단계에서 함께 결정한다.
- **frontend가 알고 있는 모든 terminal id로 분리 세션을 정리:** lazy mount, dock, FileViewer terminal처럼 id 출처가 여러 곳이다. 하나라도 빠뜨리면 살아 있는 작업을 죽인다. 정리하지 않고 남기는 쪽을 택했다.
- **데몬을 설치 디렉터리에서 실행하고 업데이트 때만 종료:** 업데이트는 해결되지만 dev 재빌드가 계속 막힌다. 이후 인계 단계에서는 어차피 실행 중 binary를 고정해야 한다.

## Consequences

GUI가 crash하거나 강제로 종료돼도 셸·Codex·빌드가 계속 실행된다. 다음 GUI는 같은 pane에서 그 작업을 이어받으며, 같은 대화를 다시 띄우지 않는다. 앱을 닫거나 pane을 지우면 지금처럼 작업이 끝난다. 업데이트도 지금처럼 작업을 끝낸 뒤 설치한다. Windows 업데이트와 dev 재빌드는 데몬과 무관하게 실행 파일을 교체할 수 있다.

다음 비용과 한계가 남는다.

- **화면:** 재결합한 터미널은 이전 화면이 비어 있고, 다음 출력부터 그려진다. 셸 prompt는 다음 입력에서야 보일 수 있다.
- **터미널 모드:** replay가 없으므로 GUI의 protocol 상태와 xterm은 기본 모드로 시작한다. 시작 때 한 번만 bracketed paste(`?2004h`)를 켜는 TUI(Codex 등)는 재결합 뒤 여러 줄 입력·붙여넣기가 bracketed paste 없이 들어가 줄마다 Enter가 될 수 있다. alt screen·마우스·커서 키 모드도 어긋난다. prompt마다 모드를 다시 켜는 셸은 곧 회복한다. 모드 복원은 #1151에서 결정한다.
- **`lx`:** 재결합한 셸의 `LX_SOCKET`은 crash한 이전 GUI의 IPC endpoint를 가리킨다. 그 셸에서 실행한 `lx`는 새 셸을 열기 전까지 실패한다. endpoint를 build kind별로 고정할지는 별도로 결정한다.
- **fallback 터미널:** 데몬을 쓸 수 없을 때 만든 in-process 터미널은 예전처럼 GUI와 함께 끝난다.
- **남은 세션:** pane 배치가 저장되기 전에 GUI가 crash하면, 어느 pane에도 속하지 않는 분리 세션이 남는다. 다음 업데이트나 재부팅까지 자식이 끝날 때까지 실행된다. 이를 보여 주거나 끝내는 사용자 경로는 아직 없다.
- **process tree kill:** Windows에서 GUI를 tree 단위로 끝내면(`taskkill /T`, `scripts/kill-dev.sh`) 데몬도 함께 끝난다(ADR-0300).
- **성능:** 4 pane × 150,000줄 background 플러드 벤치를 각 1회 측정한 결과다.

  | 항목 | 데몬 사용 | in-process |
  | --- | --- | --- |
  | 완료 시간 | 11.9 s | 11.2 s |
  | 처리량 | 50.5k lines/s | 53.7k lines/s |
  | 제어 echo p50 | 48 ms | 34 ms |

  두 경우 모두 수용 기준을 통과했다.

화면 snapshot, 업데이트 인계, GUI 미접속 중 업무 처리, `lx` endpoint 고정, 남은 세션의 사용자 경로, `LAYMUX_PTY_DAEMON=0` 제거는 각각 별도로 결정한다.
