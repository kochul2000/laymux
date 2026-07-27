# 0066. Windows 는 in-box conhost 대신 번들 ConPTY 런타임으로 자식을 띄운다

- Status: Accepted
- Date: 2026-07-27
- Source: issue #580; dev(19281) `LAYMUX_PTY_TRACE=1` 실측; [ADR-0052](0052-truecolor-capability-advertising-setting.md)(선행: [ADR-0051](0051-terminal-capability-environment-contract.md)); [ADR-0054](0054-xterm-human-and-protocol-data-origin.md); [ADR-0026](0026-conpty-width-resize-repaint-filter.md); [portable-pty `win/psuedocon.rs`](https://github.com/wez/wezterm/blob/main/pty/src/win/psuedocon.rs); [Microsoft ConPTY 재배포본](https://github.com/microsoft/terminal)
- Relation: [ADR-0052](0052-truecolor-capability-advertising-setting.md)가 광고한 색상 capability 를 자식이 **되물을 수 있게** 하여 계약을 완성한다. [ADR-0054](0054-xterm-human-and-protocol-data-origin.md)가 만든 프로토콜 응답 경로가 Windows 에서 실제로 도달 가능해진다.

## Context

[ADR-0052](0052-truecolor-capability-advertising-setting.md)는 자식에게 `COLORTERM=truecolor`
를 광고해 SGR 출력 쪽을 정리했다. 남은 절반은 자식이 **터미널 색을 되묻는** 경로다.
xterm 계약에서 그것은 `OSC 10/11` 이고, laymux 는 답할 능력이 있다 —
xterm.js 는 질의를 받으면 `\x1b]10;rgb:…\x1b\\` 를 만들고,
[ADR-0054](0054-xterm-human-and-protocol-data-origin.md)의 프로토콜 응답 경로가
그 바이트를 사람 입력과 구분해 PTY 로 되돌린다.

그런데 실기에서는 그 왕복이 성립하지 않는다. dev 인스턴스에 PTY 트레이스를 걸고
측정한 결과:

| 자식이 보낸 프로브 | in-box conhost 동작 | 자식이 받은 응답 |
| --- | --- | --- |
| `CSI 6n` (DSR) | 소비 후 conhost 가 자체 응답 | `^[[3;1R` |
| `OSC 10;?` | **소비, 무응답** | 없음 |
| `OSC 11;?` | **소비, 무응답** | 없음 |
| `CSI ?u` | 모르는 시퀀스 → laymux 로 통과 | 없음 (xterm 미지원) |
| `CSI c` (DA1) | 소비 후 conhost 가 자체 응답 | `^[[?61;6;7;21;22;23;24;28;32;42c` |

규칙은 일관된다: **conhost 는 자기가 아는 시퀀스를 소비한다.** 자기 상태로 답할 수
있는 DSR·DA1 은 답하고, 모르는 OSC(133/7/9;9)는 흘려보내고, 색상 질의는 답할 경로가
없어 조용히 버린다. 질의 바이트는 laymux 까지 오지도 않으므로 **UI 쪽에서는 고칠 수
없다.** 응답 경로가 살아 있는지는 별도로 확인했다(포커스 리포트 `\x1b[I` 가
`ui-protocol->pty` 로 나간다).

이것은 WSL 한정이 아니다. 네이티브 PowerShell pane 에서도 같은 결과였다. 증상이 WSL
에서만 눈에 띈 이유는 대체 수단의 유무다 — 네이티브 Windows 앱은 Win32 콘솔 API 로
색 테이블을 직접 읽어 우회하지만, WSL 안의 Linux 바이너리에는 VT 왕복 말고 다른
수단이 없다. 실제로 in-box conhost 에서 codex 가 쓴 색을 세어 보면 WSL 은 배경색
지정이 0건이고 밝은 회색 전경만 쓰는 반면, Windows 는 `48;2;41;41;41` 배경과 어두운
톤을 함께 쓴다.

`portable-pty` 는 `LoadLibrary("conpty.dll")` 로 **실행 파일 디렉터리의 사이드로드본을
kernel32 보다 먼저** 찾는다(`win/psuedocon.rs`의 `load_conpty`). 즉 어떤 ConPTY 구현을
쓸지는 파일 배치로 정해지는 정책 결정이지, PTY 코드의 문제가 아니다.

범위는 Windows 에서 어떤 ConPTY 구현으로 자식을 띄우는가다. OSC 응답을 누가 만드는가
(xterm.js), 응답을 어떻게 되돌리는가([ADR-0054](0054-xterm-human-and-protocol-data-origin.md)),
자식 환경 변수 계약([ADR-0052](0052-truecolor-capability-advertising-setting.md))은
비목표이며 그대로 둔다.

## Decision

**Windows 빌드는 Microsoft ConPTY 재배포본(`conpty.dll` + `OpenConsole.exe`)을 실행 파일
옆에 함께 배치하고, in-box conhost 는 폴백으로만 쓴다.**

- 벤더 트리 `src-tauri/vendor/conpty/<version>/{win10-x64,win10-arm64}/` 가 정본이며,
  버전 문자열은 `conpty_runtime.rs` 의 `CONPTY_RUNTIME_VERSION` 과 일치해야 한다.
  둘이 어긋나면 테스트가 실패한다.
- `build.rs` 가 타깃 아키텍처에 맞는 쌍을 `target/<profile>/`(dev·`cargo run`)과
  `src-tauri/gen/conpty/`(설치본 스테이징)에 복사한다. 설치본 배치는
  `tauri.windows.conf.json` 의 resources 가 맡는다.
- **배치가 곧 계약이다.** laymux 의 PTY 코드는 어떤 ConPTY 를 쓰는지 묻지 않고,
  `portable-pty` 의 로드 순서에 맡긴다. 사이드로드 여부로 갈라지는 분기를 만들지 않는다.
- 지원하지 않는 아키텍처거나 벤더 파일이 없으면 빌드 경고만 남기고 넘어간다. 그 빌드는
  in-box conhost 로 동작한다 — 색상 질의는 다시 막히지만 터미널 자체는 정상이다.
  **실패는 무음이 아니라 경고로 남는다.**
- 이 결정으로 `CSI 6n`·`CSI c` 의 응답 주체도 conhost 에서 xterm.js 로 바뀐다. 이는
  부작용이 아니라 의도다 — 렌더러가 xterm.js 인데 conhost 가 VT500 급 DA1 을 주장하고
  자기 화면 기준 커서 좌표를 답하던 쪽이 틀렸다. 앞으로 터미널 정체성을 답하는 주체는
  렌더러 하나다.

## Alternatives Considered

- **`CSI ?u` 를 신호로 OSC 10/11 응답을 주입** — conhost 를 통과하는 시퀀스가 있으니
  그것을 프로브 시작 신호로 삼아 응답을 밀어 넣는 방법. 가장 작지만 특정 에이전트의
  프로브 번들 모양에 묶이고, 색을 묻지 않은 앱의 stdin 에 바이트를 넣을 위험이 있다.
  기각.
- **`PSEUDOCONSOLE_PASSTHROUGH_MODE`(0x8)** — `portable-pty` 가 상수만 정의하고 쓰지
  않는다. 플래그를 쓰려면 크레이트를 포크해야 하고, 통과 모드는 conhost 렌더러를 꺼서
  Win32 콘솔 API 앱이 깨진다. 사이드로드로 같은 목적을 달성할 수 있으므로 기각.
- **WSL 프로파일만 ConPTY 우회** (`wsl.exe` 를 파이프로 띄우고 Linux 쪽에서 pty 확보) —
  정공법이고 conhost 를 통째로 걷어내지만 리사이즈·시그널·종료코드를 다시 설계해야
  한다. 원인이 WSL 한정이 아님이 밝혀졌으므로 비용 대비 이득이 없다. 기각.
- **Windows Terminal 이 설치한 `OpenConsoleProxy.dll` 재사용** — 번들 크기를 아낄 수
  있지만 `CreatePseudoConsole` 을 export 하지 않아 로드 자체가 실패했고(실측), 사용자
  머신의 Windows Terminal 설치 여부에 동작이 의존하게 된다. 기각.
- **미수정 + 한계로 문서화** — 자식 입장에서 laymux 는 색을 묻는 정상 경로가 없는
  터미널로 남는다. [ADR-0052](0052-truecolor-capability-advertising-setting.md)가
  광고한 capability 와 모순되므로 기각.

## Consequences

- WSL·네이티브 양쪽에서 `OSC 10/11` 왕복이 성립한다. 실측: 질의가 `pty->ui` 에
  도달하고 `ui-protocol->pty` 로 `\x1b]10;rgb:f0f0/f0f0/f0f0\x1b\\` 가 나가며 자식이
  약 24ms 만에 받는다. 같은 조건에서 codex 의 WSL 팔레트가 Windows 와 일치한다.
- ConPTY 구현이 OS 빌드가 아니라 리포에 고정된다. 머신 간 편차가 사라지는 대신,
  ConPTY 버그 수정을 받으려면 벤더 버전을 직접 올려야 한다. 올릴 때는
  [ADR-0026](0026-conpty-width-resize-repaint-filter.md)의 리사이즈 repaint 전제를
  실기로 다시 확인한다.
- 저장소와 설치본이 아키텍처당 약 1.3MB 커진다(양 아키텍처 합계 2.5MB).
- 자식 콘솔 호스트 프로세스 이름이 `conhost.exe` 에서 `OpenConsole.exe` 로 바뀐다.
  현재 코드에는 호스트 프로세스 이름에 의존하는 곳이 없지만, 프로세스 트리를 다루는
  코드(`process_tree.rs`, `scripts/kill-dev.sh`)를 고칠 때는 이 사실을 전제로 한다.
  보안 소프트웨어가 낯선 콘솔 호스트로 볼 여지도 남는다.
- `CSI 6n`·`CSI c` 응답이 xterm.js 로 넘어가면서 커서 좌표의 기준이 conhost 화면에서
  xterm 버퍼로 바뀐다. 커서/IME 경로는 이 리포에서 가장 예민한 영역이므로
  ([ADR-0008](0008-shell-cursor-shadow-cursor.md)) 회귀가 보이면 이 결정을 먼저 의심한다.
- 첫 PTY 생성 시 번들 바이너리에 대한 보안 소프트웨어 스캔이 걸려 콜드스타트가 느려질
  수 있다. 실기에서 체감되면 워밍업 spawn 을 별도 이슈로 다룬다.
- 재검토 조건: `portable-pty` 가 사이드로드 탐색을 바꾸거나, in-box conhost 가 색상
  질의를 전달하기 시작하거나, 번들 유지 비용이 이득을 넘어설 때.
