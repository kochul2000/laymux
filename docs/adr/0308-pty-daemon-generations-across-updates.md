# 0308. 업데이트 중에도 데몬 세션을 유지하고 데몬 세대를 공존시킨다

- Status: Proposed
- Date: 2026-10-09
- Source: [PTY 데몬 후속 계획](../pty-daemon/followup-plan.md) §3.5 단계 E, [ADR-0301](0301-pty-daemon-default-adoption.md) "업데이트와 실행 파일", [ADR-0201](0201-update-install-releases-child-file-locks.md)
- 대체: ADR-0301의 "업데이트 전에는 데몬을 종료한다"와, ADR-0201 중 데몬 세션에 관한 부분(업데이트 전 종료)

## Context

ADR-0301은 업데이트 guard가 데몬에 `Shutdown`을 보내 모든 세션을 끝낸 뒤 설치하도록 했다. 그래서 업데이트할 때마다 셸·Codex·빌드가 끝난다. 이 단계의 목표는 업데이트 뒤 새 GUI가 같은 pane에서 그 작업을 이어받는 것이다.

현재 구조로 확인한 사실은 다음과 같다.

- **설치기는 실행 중인 앱을 이름으로 찾아 끝낸다.** tauri-cli 2.10.1 NSIS 템플릿의 `CheckIfAppIsRunning`은 `nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"`와 `KillProcessCurrentUser`를 부른다. 이 플러그인은 `CreateToolhelp32Snapshot`/`Process32NextW`로 프로세스를 훑고, 경로를 묻는 API(`QueryFullProcessImageName` 등)는 쓰지 않는다. 즉 **경로가 아니라 이미지 이름 `laymux.exe`로** 찾는다. updater는 `installMode: passive`로 설치기를 띄우므로 확인 없이 끝낸다. ADR-0301의 staging 사본도 이름이 `laymux.exe`이므로 설치기가 데몬을 끝낸다.
- **데몬 하나가 모든 버전을 맡는다.** 데몬 디렉터리는 build kind마다 하나다. 업데이트 뒤 protocol이 같으면 새 GUI가 이전 binary의 데몬을 계속 쓴다. 새 세션도 그 데몬에 만들어지고, GUI가 열려 있는 한 세션이 0이 되지 않으므로 데몬은 업데이트되지 않는다. protocol이 다르면 새 GUI는 그 데몬을 오류로 보고 모든 터미널을 in-process PTY로 만든다.
- **Windows ConPTY handle은 다른 프로세스로 넘길 수 없다.** 그래서 fd 인계(Superset v2) 대신 Orca식 세대 공존을 택한다(후속 계획 §3.5).
- **데몬은 이미 스스로 끝난다.** 세션과 연결이 없는 상태가 60초 이어지면 admission lock 안에서 다시 확인하고 종료한다(ADR-0300 idle exit). 새 세션을 받지 않는 세대는 마지막 세션이 끝나면 따로 신호를 받지 않아도 사라진다.
- 업데이트 종료 경로는 플랫폼마다 다르다. Windows는 updater가 `on_before_exit`(ADR-0201 guard)을 부른 뒤 `std::process::exit(0)`으로 끝나므로 `RunEvent::Exit`이 오지 않는다. Linux는 설치 뒤 `app.restart()`가 exit을 요청해 `RunEvent::Exit`이 오고, 그 handler는 데몬 세션을 끝낸다(ADR-0300 "앱을 닫으면 작업이 끝난다").

## Decision

**업데이트는 데몬 세션을 끝내지 않고 분리(detach)만 한다. 데몬은 실행 파일 세대마다 따로 두고, 새 세션은 현재 세대에만 만들며, 재결합은 모든 호환 세대에서 찾는다.**

### 설치기의 종료 대상에서 데몬을 뺀다

- Windows staging 사본(ADR-0301)의 이미지 이름을 `laymux-pty-daemon.exe`로 바꾼다. 내용은 `laymux.exe` 사본 그대로이고, 실행 인자 `--pty-daemon <dir>`로 데몬이 된다.
- 설치기는 `laymux.exe`라는 이름만 끝내므로 데몬과 그 ConPTY(`OpenConsole.exe`, staging 디렉터리에 있음)는 남는다. 설치 디렉터리의 파일은 데몬이 잡고 있지 않다.

### 세대

- 세대 key는 `p{PROTOCOL_VERSION}-{실행 파일 크기}-{수정 시각}`이다. staging key(ADR-0301)와 같은 정보로, 업데이트나 dev 재빌드마다 새 세대가 된다.
- 데몬 디렉터리 구조는 `<state>/pty-daemon/<세대 key>/{daemon.json, daemon.lock, daemon.log, runtime/}`이다. instance lock, discovery, 로그, staging 사본이 모두 세대 디렉터리 안에 있다. 세대마다 데몬은 하나다.
- **새 세션은 현재 세대 데몬에만 만든다.** 이전 세대는 새 세션을 받지 않으므로, 남은 세션이 끝나면 idle exit으로 사라진다. 별도 retire 메시지나 wire 변경은 없다.
- **재결합은 살아 있는 모든 호환 세대에서 찾는다.** 호환은 discovery의 protocol version이 같은 것이다. 같은 terminal의 후보는 현재 세대를 먼저 고르고, 같은 세대 안에서는 생성 순서가 가장 늦은 것을 고른다. 고르지 않은 후보는 ADR-0301처럼 stale로 끝낸다. 재결합한 세션은 소유 세대의 데몬과 연결을 유지한다. 그래서 한 GUI가 여러 세대 데몬과 동시에 이야기할 수 있다.
- **호환되지 않는 세대**(protocol이 다름)는 재결합하지도 끝내지도 않는다. PTY 세션 패널(ADR-0306)에 "다른 protocol의 데몬이 실행 중"으로 보이고, 그 안의 세션은 목록에 나오지 않는다. 세션이 끝나면 그 데몬도 idle exit으로 사라진다.
- **정리:** GUI는 처음 데몬을 쓸 때 한 번, lock이 풀려 있고 일정 시간보다 오래된 이전 세대 디렉터리를 지운다. 현재 세대와 막 만들어진 디렉터리는 건드리지 않는다. 세대 디렉터리가 생기기 전 구조(데몬 디렉터리 바로 아래의 `daemon.lock`·`daemon.json`·`runtime/`)도 lock이 풀려 있으면 같은 규칙으로 지운다.

### 업데이트 guard

- `release_installer_file_locks`는 먼저 `AppState`에 "업데이트 인계"를 표시하고, in-process PTY와 probe만 끝낸다. 데몬 터미널의 handle은 terminate하지 않고 leak한다. handle을 drop하면 데몬 master의 drop이 세션 종료를 요청하기 때문이다. 데몬에 `Shutdown`도 보내지 않는다. 프로세스가 끝나면 연결이 닫히고 데몬은 세션을 분리 상태로 둔다.
- 업데이트로 재시작하는 경로(Linux)에서는 설치에 성공해 재시작을 요청하기 직전에 같은 표시를 남긴다. `RunEvent::Exit` handler와 `AppState`의 teardown은 이 표시가 있으면 데몬 세션을 끝내지 않는다.
- 재시작한 GUI는 crash 재결합(ADR-0301)과 같은 경로로 세션을 다시 붙인다. 모드 preamble(ADR-0303)과 화면 redraw(ADR-0307)가 적용되고, 재결합한 터미널은 업데이트 checkpoint의 agent resume을 건너뛴다(기존 `adopted` 규칙).
- 설치가 실패하면 표시를 지운다. GUI는 그대로 살아 있고, 앱을 닫으면 다시 작업이 끝난다.

### PTY 세션 패널

- 목록은 모든 세대의 세션을 합친다. 항목마다 소유 세대 key(`daemon`)가 붙고, 현재 build의 세대(`currentDaemon`)가 아닌 세션은 "이전 빌드"로 표시한다. 종료 요청은 `{daemon, sessionId, attachEpoch}`로 그 세대 데몬에 보낸다. `daemon`은 경로로 쓰이므로 세대 key 형식만 받는다.
- 응답 없는 세대나 다른 protocol의 세대는 `unavailableDaemons`로 따로 보고한다. "목록 조회 실패 ≠ 세션 없음" 규칙(ADR-0306)을 세대마다 지킨다.

## Alternatives Considered

- **세대 없이 데몬 하나를 유지:** protocol이 같으면 업데이트가 데몬에 반영되지 않는다. protocol이 다르면 모든 터미널이 in-process PTY로 떨어진다.
- **protocol version별 세대(후속 계획 초안):** protocol이 같은 업데이트에서 위와 같은 문제가 남는다. 데몬 수정이 적용되지 않는다.
- **retire 메시지로 이전 세대를 명시적으로 닫기:** 새 세션만 현재 세대에 만들면 idle exit으로 충분하다. 메시지를 추가하면 그 메시지를 모르는 미래의 다른 protocol 세대와는 어차피 쓸 수 없다.
- **fd·handle 인계(Superset v2):** Windows ConPTY handle을 다른 프로세스로 넘기는 공식 경로가 없다.
- **NSIS 템플릿을 고쳐 경로로 확인:** tauri-cli 템플릿을 fork해야 하고 업그레이드마다 다시 맞춰야 한다. staging 이미지 이름만 바꾸면 같은 효과가 난다.

## Consequences

- 업데이트 뒤 셸·Codex·빌드가 같은 pane에서 계속된다. 설치하는 동안 GUI가 없으므로 그 사이의 OSC·훅 이벤트는 잃는다(단계 G).
- dev 재빌드마다 새 세대가 생긴다. 재빌드 전의 세션은 이전 세대에서 재결합되고, 새 터미널은 새 binary로 실행된다. 예전처럼 "이전 binary 데몬이 새 세션까지 받는" 일이 없다.
- 이전 세대 데몬은 남은 세션이 끝날 때까지 실행된다. 그동안 세대마다 데몬 프로세스와 staging 사본(실행 파일 + ConPTY)이 하나씩 있다.
- protocol을 바꾸는 업데이트는 이전 세대 세션을 재결합하지 못한다. 그 세션은 패널에 "다른 protocol"로만 보이고 끝날 때까지 실행된다. protocol 변경은 이 비용을 감수해야 한다.
- 남은 위험:
  - 설치 중 agent 훅이 설치 디렉터리의 `laymux-agent-hook.exe`를 실행하는 순간과 설치기의 파일 교체가 겹치면 설치기가 그 파일을 쓰지 못할 수 있다. 훅은 짧게 실행되므로 창은 작고, passive 설치기는 재시도한다.
  - Linux AppImage는 데몬 실행 파일이 AppImage 마운트 안에 있다. 이 ADR은 마운트 수명을 다루지 않는다. deb 설치는 실행 중 binary를 교체해도 문제가 없다.
- 검증:
  - 세대 key·디렉터리 정리·세대 간 재결합 선택 단위 테스트.
  - 업데이트 guard가 데몬 세션을 끝내지 않는 테스트.
  - dev 실기: 이전 세대 binary로 세션을 만들고, 다시 빌드해 새 세대로 재기동한 뒤 같은 PID로 재결합하는지, 새 터미널은 새 세대 데몬에 만들어지는지, 세션을 닫으면 이전 세대 데몬이 idle exit하는지 확인한다.
