# devinput — dev 인스턴스 전용 OS 레벨 입력 헬퍼

Automation API 로는 만들 수 **없는** 입력(물리 키 modifier 조합, 진짜 클립보드, 진짜 포커스 아웃,
IME 조합)을 dev 인스턴스(19281)에 넣는 도구다. 목적은
[`docs/dev-repro-methodology.md`](../../docs/dev-repro-methodology.md) §2 의 "사람이 해야만 하는 입력" 을
줄이는 것 — 없애는 게 아니다.

**Windows 전용**(SendInput/IMM32). macOS/Linux IME 는 다른 스택이라 이 도구로 못 덮는다.

## 왜 laymux 본체가 아니라 별도 스크립트인가

결정 정본은 [ADR-0065](../../docs/adr/0065-dev-input-helper-out-of-process.md).

- Automation API 는 인증이 없다(IP allowlist 만, `0.0.0.0` 바인딩 — [ADR-0002](../../docs/adr/0002-automation-api-fixed-port-ip-allowlist.md)).
  거기에 "OS 물리 키 주입" 을 붙이면 사설망의 아무 기기가 유저 PC 에 타이핑할 수 있고, 그 코드가
  release 바이너리에 들어간다.
- 우리가 쫓는 결함에는 **UI 가 멈추는 종류**가 있다. 앱 안에 있는 주입기는 앱과 함께 멈춘다.
- IME 는 플레이키해서 같은 시나리오를 수십 번 돌린다. 그 루프에 `cargo build` 를 끼울 수 없다.

## 실행

인터프리터는 `uv` 가 관리한다(의존성 0, stdlib + ctypes 만 씀). 별도 설치 없음.

```bash
uv run scripts/devinput/cli.py status                    # 현재 상태만 확인 (lease 불필요)
uv run scripts/devinput/cli.py lease 15m --focus-dev     # 사용자가 PC 를 넘기는 명령
uv run scripts/devinput/cli.py doctor                    # 주입 경로 전체 검증
uv run scripts/devinput/cli.py keys ctrl+alt+m text:hi   # 키/조합/텍스트 전송
uv run scripts/devinput/cli.py unlease                   # 즉시 회수
```

`keys` 토큰: `enter`·`f5` 같은 단일 키, `ctrl+alt+m` 조합, `text:hello world` ASCII 타이핑,
`wait:0.5` 대기.

가드 로직 테스트(주입 없음, Windows 전용):

```bash
uv run --with pytest python -m pytest scripts/devinput/tests -q
```

## 안전 장치 4층 — 전부 필수

1. **lease.** `lease` 명령 없이는 어떤 주입도 거부한다. 만료 시각이 있고(최대 1시간) 만료되면
   실행 중에도 중단된다. 파일은 `%LOCALAPPDATA%\laymux-devinput\lease.json`. `LAYMUX_DEVINPUT_DISABLE=1`
   은 lease 를 무시하고 전부 차단한다. lease 는 **이벤트마다 다시 읽는다** — 실행 중에 `unlease`
   로 파일을 지우거나 `LAYMUX_DEVINPUT_DISABLE=1` 을 켜면 그 즉시 진행 중인 런도 멈춘다.
2. **타깃 락.** 대상 pid 는 **포트 19281 LISTENING 소유자**로 정한다(`automation.json` 은 참고용 —
   아래 "함정" 참조). 그 pid 의 이미지가 `laymux.exe` 인지, 19280 소유자(release)와 겹치지 않는지
   확인하고, **이벤트 하나 보내기 전마다** 포그라운드 창의 pid 가 그 pid 인지 다시 본다.
   불일치면 즉시 중단, 재시도 없음. release pid 는 명시적 블랙리스트다.
3. **데드맨 스위치.** `WH_KEYBOARD_LL`/`WH_MOUSE_LL` 훅으로 **합성이 아닌** 입력을 감지한다. 사람이
   키를 누르거나 마우스를 40px 움직이면 그 순간 중단된다. `GetLastInputInfo` 는 합성 입력도 세므로
   쓰지 않는다. 우리 서명(`dwExtraInfo`)이 없는 **합성 키 입력**도 3건이면 중단한다 — 원격 데스크톱
   경유 사람 입력과 남의 자동화가 여기로 들어온다(아래 "함정" 참조).
4. **modifier 청소.** 세션이 어떻게 끝나든(예외·중단·Ctrl+C) 우리가 누른 키는 전부 KEYUP 된다.
   사람이 누르고 있는 modifier 는 건드리지 않는다.

추가로 `doctor`/`keys` 는 `activity.type == "shell"` 인 pane 만 대상으로 삼는다. Claude·Codex·vim 이
돌고 있는 pane 에 타이핑하는 것은 남의 세션에 입력을 넣는 것이므로 거부한다.
`keys --no-focus` 는 HTTP 포커스 이동을 건너뛰므로 **실제로 포커스를 가진 pane**(`/api/v1/grid` 의
`focusedPaneIndex`)을 조회해 그 pane 이 shell 인지 검증한다. 아니면 거부한다 — 검증한 pane 과
키가 들어가는 pane 이 달라지는 경로를 남기지 않는다.

## doctor 가 검증하는 것

lease → 타깃 락 → dev API health → shell pane 선택 → HTTP 로 pane 포커스 → 포그라운드 확인 →
데드맨 무장 → 마커 문자열 타이핑(**Enter 는 안 보낸다**) → PTY 버퍼에서 마커 회수 →
backspace 로 지움 → modifier 잔류 확인.

마커가 회수되지 않으면 대개 **UIPI** 다: dev 가 관리자 권한으로 떠 있고 이 스크립트는 아닌 경우
SendInput 이 조용히 실패한다. doctor 가 그 진단을 출력한다.

## 단계

1. **guard + doctor + 물리 키** ← 지금 여기
2. modifier 조합 시나리오 파일(`scenarios/`) + `--repeat N` 판정 집계
3. 진짜 클립보드 (`OpenClipboard`/`SetClipboardData` + Ctrl+V)
4. 진짜 포커스 아웃 (스크립트가 만든 1x1 창을 포그라운드로, 그 다음 dev 로 복귀)
5. IME 조합 (`GetGUIThreadInfo().hwndFocus` → `ImmSetConversionStatus`)

## 아직 사람이 해야 하는 것

- 저사양 GPU·소프트웨어 렌더링 폴백 같은 하드웨어 조건
- "겹친 거냐 치환된 거냐" 류의 시각 판단
- macOS/Linux IME

## 함정

- **`automation.json` 을 신뢰하지 마라.** `cargo test` 의 `write_and_remove_discovery_file` 이 실제
  사용자 설정 경로(`%APPDATA%\laymux-dev\automation.json`)에 port=19280 을 쓰고 지운다. 그래서 살아 있는
  dev 인스턴스에 discovery 파일이 없는 상태가 흔하다. 이 도구는 포트 소유자를 권위로 쓴다.
- **`SetForegroundWindow` 는 백그라운드 프로세스에서 실패한다.** `--focus-dev` 는 AttachThreadInput →
  최소화/복원까지 시도하고, 그래도 안 되면 실패를 보고한다(조용히 넘어가지 않는다).
- **IME 는 비동기다.** 5단계가 들어오면 같은 시나리오를 여러 번 돌려 pass/fail 비율로 판정한다.
  1회 성공은 근거가 아니다.
- **로컬 콘솔 세션 전제다.** RDP·Parsec·Sunshine·VNC·모바일 키보드 앱을 통한 사람의 입력은
  `LLKHF_INJECTED` 를 달고 도착해서 물리 키와 구분되지 않는다. 그래서 데드맨은 "우리 서명이 없는
  합성 키 입력" 3건을 중단 사유로 센다(`FOREIGN_INJECTED_KEYS_ABORT`). 마우스는 세지 않는다 —
  원격 세션의 커서 이동만으로 매번 죽으면 못 쓰기 때문이다. 즉 **원격 세션에서 이 도구를 돌리면
  키 입력은 잡히지만 마우스는 못 잡는다.** 원격으로 붙어 있는 사람이 있으면 쓰지 마라.
- **`/api/v1/terminals/{id}/output` 은 ANSI 를 안 지운 raw PTY 바이트다.** PSReadLine 이 토큰 중간에
  색상 시퀀스를 끼워 넣으므로 마커 substring 매칭 전에 `probe.strip_ansi()` 를 거쳐야 한다.
  (MCP 리소스 쪽만 strip 한다.)
