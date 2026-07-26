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

## 안전 장치 4층 — 전부 필수

1. **lease.** `lease` 명령 없이는 어떤 주입도 거부한다. 만료 시각이 있고(최대 1시간) 만료되면
   실행 중에도 중단된다. 파일은 `%LOCALAPPDATA%\laymux-devinput\lease.json`. `LAYMUX_DEVINPUT_DISABLE=1`
   은 lease 를 무시하고 전부 차단한다.
2. **타깃 락.** 대상 pid 는 **포트 19281 LISTENING 소유자**로 정한다(`automation.json` 은 참고용 —
   아래 "함정" 참조). 그 pid 의 이미지가 `laymux.exe` 인지, 19280 소유자(release)와 겹치지 않는지
   확인하고, **이벤트 하나 보내기 전마다** 포그라운드 창의 pid 가 그 pid 인지 다시 본다.
   불일치면 즉시 중단, 재시도 없음. release pid 는 명시적 블랙리스트다.
3. **데드맨 스위치.** `WH_KEYBOARD_LL`/`WH_MOUSE_LL` 훅으로 **합성이 아닌** 입력을 감지한다. 사람이
   키를 누르거나 마우스를 40px 움직이면 그 순간 중단된다. `GetLastInputInfo` 는 합성 입력도 세므로
   쓰지 않는다.
4. **modifier 청소.** 세션이 어떻게 끝나든(예외·중단·Ctrl+C) 우리가 누른 키는 전부 KEYUP 된다.
   사람이 누르고 있는 modifier 는 건드리지 않는다.

추가로 `doctor`/`keys` 는 `activity.type == "shell"` 인 pane 만 대상으로 삼는다. Claude·Codex·vim 이
돌고 있는 pane 에 타이핑하는 것은 남의 세션에 입력을 넣는 것이므로 거부한다.

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
