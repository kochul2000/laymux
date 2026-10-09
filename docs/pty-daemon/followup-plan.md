# PTY 데몬 후속 계획 — 레퍼런스 조사와 단계별 수정안

- 작성일: 2026-10-09
- 상태: 계획 (결정은 각 단계 PR의 ADR로 확정한다)
- 선행: [ADR-0300](../adr/0300-detached-pty-daemon-core.md)(#1147), [ADR-0301](../adr/0301-pty-daemon-default-adoption.md)(#1149), [data-flow §8.23](../architecture/data-flow.md)
- 관련 이슈: #1150(Windows transport), #1151(재결합 모드 복원)

## 1. 목적

ADR-0301까지로 다음이 가능하다. PTY는 데몬이 소유하고 기본으로 활성화된다. GUI가 crash한 뒤에는 같은 pane에 재결합된다. ADR-0301 Consequences에는 아래 일곱 가지 한계가 남아 있다.

1. 업데이트하면 작업이 끝난다(인계 없음).
2. 재결합 직후 화면이 비어 있다.
3. 재결합 뒤 터미널 모드가 어긋난다. 예: Codex에 여러 줄을 입력하면 줄마다 Enter로 제출된다.
4. Windows loopback transport에 다른 로컬 사용자가 접근할 수 있다(연결 슬롯 DoS).
5. 재결합한 셸의 `LX_SOCKET` 등이 crash한 이전 GUI를 가리킨다.
6. GUI가 없는 동안 OSC·훅 이벤트를 잃는다.
7. pane에 속하지 않는 분리 세션을 보거나 끝낼 사용자 경로가 없다.

이 문서는 같은 문제를 푼 제품들을 조사한 결과와 laymux용 단계별 수정안을 정리한다.

## 2. 조사한 레퍼런스

| 레퍼런스 | 구조 | 라이선스 | 비고 |
| --- | --- | --- | --- |
| Superset(`superset-sh/superset`, main `edcec5b`) | v1: Electron main ↔ terminal-host 데몬(headless xterm). v2: main → host-service → pty-daemon(바이트만 다룸) | **Elastic License 2.0**(source-available) | 설계만 참고한다. **코드는 복사하지 않는다.** Windows는 지원하지 않는다 |
| VS Code(`microsoft/vscode`) | ptyHost(UtilityProcess) + 터미널마다 headless xterm·shell integration | MIT | 업데이트 시 인계하지 않는다. 다음 실행에서 "revive"(새 셸 + 버퍼 복원)한다 |
| Orca(`stablyai/orca`) | Electron + terminal-host 데몬(headless xterm), Windows 지원 | MIT | 문제 영역이 가장 가깝다. 설계 문서는 main에서 지워져 `ad1e58d9`에 고정해 참조한다 |
| tmux · zellij · WezTerm | 서버가 터미널 모델을 소유한다 | ISC · MIT · MIT | 버전이 다르면 이전 서버를 유지하거나 연결을 거절한다. 인계는 없다 |

조사한 레퍼런스 가운데 **실행 중인 PTY를 새 바이너리로 넘기는(hot handoff) 곳은 Superset v2뿐이다.** Superset v2는 Unix fd 상속 방식이며 Windows ConPTY 경로는 없다.

## 3. 문제별 레퍼런스 해법과 laymux 수정안

### 3.1 터미널 모드 복원과 query 재응답 방지 (#1151)

**레퍼런스**

- **Superset v2 `TerminalModes`:** 데몬에 제어 시퀀스 스캐너를 둔다.
  - 추적 대상: DEC 1·6·7·25·45·66·1004·2004·2026, IRM, 마우스 모드와 인코딩(1006/1016), alt 여부, kitty keyboard 스택. RIS/DECSTR가 오면 초기화한다.
  - 붙을 때 preamble로 **켜짐과 꺼짐을 모두** 단언한다. 예외는 두 가지다. ?6은 커서를 홈으로 보내므로 켜져 있을 때만 보내고, 2026은 일시적 모드라 켜져 있으면 생략한다.
- **Orca `terminal-mode-rehydrate-sequences`:** 순서는 SGR reset → `?1049h` → `?2004h` → `?1h` → 마우스 모드 → 인코딩이다.
- **query 재응답 방지:**
  - VS Code `LocalPty._inReplay`: replay 중에는 입력·resize·ack를 모두 버린다.
  - Orca `replay-guard`: replay 중 xterm `onData`의 자동 응답만 버리고 실제 키 입력은 통과시킨다. 해제는 시간 초과가 아니라 FIFO probe로 판정한다.
- tmux·zellij·WezTerm은 서버가 pane 모드에 맞춰 입력을 인코딩한다. 그래서 이 문제가 구조적으로 생기지 않는다.

**수정안**

- 데몬 세션이 출력에서 **DECSET/DECRST 상태만** 추적한다(`pty_daemon/modes.rs`). OSC 해석·응답·DB는 다루지 않으므로 ADR-0300의 "데몬은 PTY만 소유" 경계를 "PTY와 모드 상태"로 좁게 확장한다.
- `Attached`에 모드 스냅샷을 싣는다. GUI는 이를 **응답을 만들지 않는 preamble 바이트**로 보고 일반 출력 경로의 맨 앞에 한 번 넣는다. 그러면 Rust `TerminalProtocolState`와 xterm이 같은 상태를 갖게 되고, ADR-0001의 단일 패스가 유지된다.
- preamble에는 query를 넣지 않는다. 생성 규칙은 Superset·Orca 순서를 참고하되 독자적으로 구현한다.
- 이 단계에서는 backlog replay가 없으므로 replay guard가 필요 없다. replay guard는 3.6 단계에서 함께 도입한다.
- **ADR:** 새 ADR(데몬 모드 추적과 재결합 preamble). ADR-0300의 경계를 정정한다.

### 3.2 셸 env의 IPC 경로가 이전 GUI를 가리킴

**레퍼런스**

- Orca: 자식 env에는 **고정 파일 경로**만 넣는다. 앱은 기동할 때마다 `endpoint.env`/`.cmd`를 tmp+rename으로 다시 쓰고, 훅은 호출할 때마다 그 파일을 source한다.
- Superset v2: 포트를 안정화하고, 훅이 호출할 때마다 manifest를 읽어 후보 URL을 모두 시도한다.
- VS Code: 오래 사는 프로세스 쪽의 **고정 해시 경로**를 쓴다(`createStaticIPCHandle`, git askpass).
- tmux(uid·label 고정 경로)와 zellij(세션 이름)는 성공 사례다. WezTerm `WEZTERM_UNIX_SOCKET=gui-sock-<pid>`는 실패 사례다.

**수정안**

- `LX_SOCKET`, `LX_AUTOMATION_PORT`, agent hook endpoint를 build kind별 **고정 discovery 파일**(예: `<state>/laymux[-dev]/lx-endpoint.json`)로 간접화한다. GUI는 기동할 때마다 원자적으로 다시 게시한다.
- `lx`와 훅은 호출할 때마다 그 파일을 다시 읽는다.
- env 값은 하위 호환을 위해 남기지 않는다. 내부 개발 단계이므로 고정 경로로 대체한다.
- 데몬이 고정 endpoint를 맡아 현재 GUI로 중계하는 방식은 3.7과 함께 검토한다.
- **ADR:** 새 ADR(터미널 env endpoint 간접화). `lx` IPC 계약 변경이다.

### 3.3 Windows 사용자 전용 transport (#1150)

**레퍼런스**

- Orca·zellij·WezTerm은 모두 Windows에서 기본 보안 named pipe나 AF_UNIX를 쓰고 사용자 격리를 하지 않는다. **따라 하지 않는다.**
- 실제 제품의 Rust 구현:
  - DataDog `pipe_security.rs`
  - trycua/cua `serve.rs`: 현재 사용자 SID를 SDDL `D:P(A;;GA;;;<SID>)(A;;GA;;;SY)`로 지정하고 `first_pipe_instance`를 쓴다. 클라이언트 mask에서 `FILE_CREATE_PIPE_INSTANCE`를 빼서 같은 이름의 pipe 인스턴스를 가로채지 못하게 한다.

**수정안**

- **결정(ADR-0305):** named pipe 대신 **AF_UNIX(Windows 10 1803+)**를 쓴다. 동기 named pipe는 read timeout이 없어 handshake·spawn·종료 deadline을 다시 만들어야 하지만, AF_UNIX는 기존 socket 코드를 그대로 쓴다. socket 파일과 그 디렉터리에 현재 사용자·SYSTEM 전용 protected DACL을 건다(연결에 쓰기 권한 필요). 같은 방식으로 `lx` IPC(인증 없던 loopback TCP)도 옮긴다.
- 기존 token과 HMAC 양방향 proof, 인증 전 연결 한도, handshake deadline은 유지한다.

### 3.4 분리 세션 인벤토리와 정리

**레퍼런스**

- Orca: Settings › Manage Sessions(목록, Kill all, Restart daemon)를 둔다. `terminal.adoptOrphans`로 고아 PTY를 탭에 다시 붙인다. 데몬이 응답하지 않으면 DEGRADED MODE로 동작한다.
- Superset v2: 5분 주기 reaper가 DB에 없는 세션을 2-pass로 확인한 뒤 kill한다. 반대로 레이아웃에는 있는데 데몬에 없는 세션은 restored notice와 함께 새 셸로 만든다. 설정 화면에서 세션 수와 Update/Restart를 노출한다.
- VS Code: orphan 질의(4초 `AutoOpenBarrier`), 2단계 grace time.
- **Orca 사고의 교훈:**
  - 목록 조회 실패는 "세션 0개"가 아니다.
  - 재연결 중의 가짜 exit가 close로 해석돼 세션이 대량 kill됐다. close와 kill에는 의도와 출처(epoch)를 싣는다.

**수정안**

- **결정(ADR-0306):** 설정 › 터미널 › PTY 세션 패널(터미널·프로필·PID·상태)과 같은 동작의 IPC·REST를 둔다. 세션을 `pane`·`awaitingPane`(저장 레이아웃의 터미널로 아직 adopt 기회가 남음, 예: 열지 않은 워크스페이스)·`detached`·`otherClient`·`ending`으로 분류하고, `detached`만 사용자가 본 epoch로 끝낸다(backend가 직전에 다시 분류). 목록 실패는 오류이며 자동 정리는 하지 않는다.
- 데몬 재시작 버튼은 pane 세션까지 끝내므로 두지 않는다(업데이트 시 데몬 교체는 단계 E).
- 분리 세션을 새 pane에 붙이는 adopt는 pane 생성 경로가 세션을 지정받아야 해서 후속으로 분리한다.

### 3.5 업데이트 중 작업 유지

**레퍼런스**

- **Orca(Windows 포함)의 세대 공존:** 데몬 endpoint·token·PID를 protocol version별로 둔다. 새 앱은 이전 버전 데몬을 legacy adapter로 probe해서, 이전 세션은 이전 데몬에 그대로 둔다.
  - 이전 데몬은 비면 `shutdownIfIdle`로 스스로 끝난다. 이때 listener를 먼저 닫고 응답한다(admission fence).
  - 실행 이미지는 userData로 복사해 실행한다. NSIS가 `$INSTDIR` 경로의 프로세스만 종료하기 때문이다.
- **Superset v2(Unix 전용)의 fd 인계:** 스냅샷과 PTY master fd를 상속시켜 새 데몬을 띄운다. 실패하면 이전 데몬을 유지한다. 강제 재시작은 사용자가 확인했을 때만 한다.
- VS Code·tmux·zellij·WezTerm은 인계하지 않는다.

**결정(ADR-0308) — 세대 공존(인계 없음)**

- Windows ConPTY는 handle을 다른 프로세스로 넘기는 공식 경로가 없다. 그래서 fd 인계 대신 Orca식 세대 공존을 택했다.
- **확인 결과:** tauri-cli 2.10.1 NSIS 템플릿의 `CheckIfAppIsRunning`은 `nsis_tauri_utils::FindProcessCurrentUser`/`KillProcessCurrentUser`로 `laymux.exe`를 **이미지 이름**으로 찾아 끝낸다(경로를 보지 않는다). staging 사본도 이름이 같아 설치기가 데몬을 끝내므로, 사본 이름을 `laymux-pty-daemon.exe`로 바꿨다.
- 세대는 protocol version이 아니라 **실행 파일 build**(protocol + 크기·수정 시각 digest)마다 둔다. protocol만 쓰면 같은 protocol의 업데이트 뒤에도 이전 binary 데몬이 새 세션을 계속 받아 데몬 수정이 적용되지 않는다.
- 변경 내용:
  1. 업데이트 guard와 Linux 재시작 경로는 `AppState`에 인계를 표시하고 데몬 세션을 끝내지 않는다(데몬 `Shutdown`도 보내지 않는다).
  2. discovery, endpoint, lock, staging 사본을 `<root>/g<protocol>-<build>/`에 둔다.
  3. 새 세션은 현재 세대에만 만들고, 재결합은 같은 protocol의 모든 살아 있는 세대에서 찾는다(현재 세대 우선).
  4. 이전 세대는 새 세션을 받지 않으므로 남은 세션이 끝나면 기존 idle exit(admission lock 재확인)으로 끝난다. retire 메시지는 두지 않았다.
  5. PTY 세션 패널은 모든 세대를 합쳐 보이고, 응답 없는·다른 protocol의 세대를 따로 보고한다.
- Linux fd 인계는 필요해지면 별도로 검토한다(SCM_RIGHTS나 exec-in-place). Linux AppImage의 마운트 수명도 범위 밖이다.

### 3.6 재결합 시 화면 복원

**레퍼런스**

- VS Code·Orca·Superset v1: 데몬(호스트)이 headless xterm과 SerializeAddon으로 화면 snapshot을 만든다. VS Code는 scrollback 100줄, Superset v1은 5000줄이다.
- Superset v2: 이 방식에서 물러났다. 데몬은 원본 바이트 ring만 갖고, host가 `epoch`·`outputSeq`로 정확한 catch-up을 한다. 위치를 알 수 없으면 아무것도 보내지 않고 SIGWINCH 두 번으로 앱이 다시 그리게 한다("never synthesize screen content", #6290).

**수정안**
- **결정(ADR-0307):** dev 실기 측정 결과 resize nudge는 PowerShell 셸을 복원하지 못했고(번들 ConPTY는 resize 때 다시 칠하지 않음), Codex는 nudge 없이도 다시 그렸다. backlog에는 client가 없던 동안의 출력만 있어 이전 화면을 복원하지 못한다. 그래서 데몬이 출력으로 `vt100` 화면 모델(scrollback 없음)을 유지하고, replay 없는 재결합 때 모드 preamble 뒤에 현재 화면 redraw(셀·속성·커서, OSC·query 없음)를 보낸다. scrollback 복원과 detached 중 출력 replay는 필요해지면 따로 결정한다.

### 3.7 GUI가 없는 동안의 이벤트

**레퍼런스**

- tmux: hook과 alert가 서버에서 돈다.
- VS Code: ptyHost의 headless shell integration이 명령 상태를 구조화해 넘긴다.
- Orca: 숨은 pane에서는 데몬이 알림성 OSC fact를 미리 뽑아 순서대로 보낸다. 앱이 없을 때 오는 훅은 잃는다.
- Superset: 앱이 없을 때 오는 훅은 잃는다.

**수정안 — 마지막 단계, 별도 결정**

- 데몬이 알림성 OSC fact와 훅 이벤트를 bounded journal에 쌓고, GUI가 재접속하면 순서대로 가져가는 방식이 후보다.
- 이 방식은 ADR-0001(OSC Rust 단일 패스, GUI 소유)의 경계를 바꾼다. 따라서 3.1~3.6 이후에 따로 판단한다.
- 3.2의 데몬 endpoint 중계와 함께 설계한다.

### 3.8 공통 안정성 (각 단계에 흡수)

- crash circuit: 데몬이 60초에 3회 이상 죽으면 자동 기동을 멈추고 in-process로만 동작한다(Superset). 지금의 30초 negative cache를 확장하는 형태다.
- 응답 없음을 감지해 보고한다(VS Code heartbeat). 3.4의 패널은 응답 없는 데몬을 오류로 표시한다. 수동 재시작은 단계 E의 데몬 교체와 함께 정한다.
- "목록 조회 실패 ≠ 세션 없음" 규칙을 코드 주석과 테스트로 고정한다(Orca).

## 4. 단계와 순서

| 단계 | 내용 | 해결하는 한계 | 크기 | 선행 |
| --- | --- | --- | --- | --- |
| A | 데몬 모드 추적 + 재결합 preamble | 3 (#1151) | 중 | — |
| B | 터미널 env endpoint 간접화(`lx`·훅·automation) | 5 | 소~중 | — |
| C | Windows named pipe 사용자 전용 transport | 4 (#1150) | 중 | — |
| D | 분리 세션 패널·API (adopt는 후속) | 7 | 중 | C 이후 권장 |
| E | 업데이트 세대 공존(build별 데몬, ADR-0308) | 1 | 대 | A·C |
| F | 데몬 화면 모델(vt100) redraw | 2 | 중 | A |
| G | GUI 미접속 이벤트 journal | 6 | 대 | B·F |

- 우선순위는 사용자 체감 영향 순이다. 재결합 뒤 Codex 입력이 오동작하는 문제가 가장 크므로 A를 먼저 하고, 이어서 B와 C를 한다.
- 각 단계는 독립 PR로 만든다. PR마다 ADR(Proposed)과 living doc 갱신을 포함하고, 독립 리뷰를 거친다.
- 실기 검증은 격리된 dev(19281)에서 `VITE_LAYMUX_STRICT_MODE=0`으로 한다. 순서는 GUI 강제 종료 → 재실행 → 재결합 → 해당 단계의 수용 시나리오다.

## 5. 라이선스 원칙

- Superset은 ELv2다. 코드를 복사하거나 옮겨 적지 않고, 문서화된 동작과 설계 아이디어만 참고한다. 구현은 laymux 코드베이스의 기존 구조(Rust)로 새로 작성한다.
- VS Code, Orca, tmux, zellij, WezTerm은 permissive 라이선스다. 그래도 이 계획에서는 설계만 참고한다. 코드를 가져오면 해당 PR에 출처와 라이선스 고지를 남긴다.
