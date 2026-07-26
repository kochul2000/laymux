# 0065. dev 전용 OS 입력 헬퍼는 앱 밖 프로세스에 두고 lease·타깃 락으로 통제한다

- Status: Proposed
- Date: 2026-07-26
- Source: 사용자 요구(자율 검증 범위 확대), [dev-repro-methodology.md](../dev-repro-methodology.md) §2, [ADR-0002](0002-automation-api-fixed-port-ip-allowlist.md)

## Context

`docs/dev-repro-methodology.md` §2 는 자동화로 만들 수 없는 입력을 넷으로 꼽는다 — IME 조합, 진짜 포커스 아웃, 진짜 클립보드, 물리 키 modifier 조합. Automation API 의 `terminals/{id}/write` 는 PTY 에 바이트를 넣으므로 `compositionstart`/`update`/`end` 도 `blur` 도 `paste` 도 만들지 못한다. 그래서 이 계층의 결함(#527·#551·#555·#560 계열)은 매번 사용자가 실기에서 키를 눌러줘야 진단이 끝났다. 방법론 §6 이 요구하는 "실기 확인" 이 사람 대기 시간으로 직결된다.

Windows `SendInput` 은 OS 입력 큐에 진짜 키 이벤트를 넣으므로 WebView2 가 IMM32/TSF 를 거친 실제 조합 이벤트를 발생시킨다. 즉 기술적으로는 넷 다 도달 가능하다. 그러나 SendInput 은 **"현재 포커스"** 로 가고, dev(19281)와 release(19280)는 같은 `laymux.exe` 이며 창 제목도 둘 다 `Laymux` 다. 방법론 §1 에 적힌 대로 **제목으로 창을 고르면 release 에 입력이 들어간다 — 실제로 한 번 그랬다.** release 는 사용자 소유이고, 그 창에는 사용자의 실제 작업과 다른 사람의 에이전트 세션이 떠 있다.

범위: dev 인스턴스에서 재현 시나리오를 실행하기 위한 OS 레벨 입력. 비목표: release 인스턴스 제어, 원격/헤드리스 실행, macOS/Linux(IME 스택이 별개), 하드웨어 조건 재현.

## Decision

**OS 입력 주입은 laymux 프로세스 밖의 별도 도구(`scripts/devinput/`)에 두고, 사용자가 명시적으로 부여한 시간제 lease 없이는 한 이벤트도 보내지 않는다.**

세부 계약:

1. **Automation API 에는 입력 주입 엔드포인트를 추가하지 않는다.** ADR-0002 에 따라 이 API 는 무인증(IP allowlist 만, `0.0.0.0` 바인딩)이다. 여기에 물리 키 주입이 붙으면 사설망의 임의 기기가 사용자 데스크톱에 타이핑할 수 있고, 그 코드가 release 바이너리에 들어간다. 이 결정은 `cfg(debug_assertions)` 게이팅으로도 완화되지 않는다 — 위험은 "release 에 들어가느냐" 뿐 아니라 "제품 표면에 존재하느냐" 이기 때문이다.
2. **타깃의 권위는 포트 19281 의 LISTENING 소유자다.** `automation.json` 은 참고용으로만 읽는다(issue #574: `cargo test` 가 실사용 discovery 파일을 쓰고 지운다). 소유자가 없거나 둘 이상이면 거부한다. 그 pid 의 이미지가 `laymux.exe` 인지, 19280 소유자와 겹치지 않는지 확인한다. release pid 는 **명시적 블랙리스트**다.
3. **이벤트 단위 재확인.** 포그라운드 창의 pid 가 dev pid 인지 **모든 이벤트 직전에** 확인한다(버스트 단위가 아니다 — syscall 2개라 더 싸고 유출 반경이 0이 된다). 불일치·release 일치·포그라운드 없음은 즉시 중단이며 **재시도하지 않는다.**
4. **사람이 돌아오면 즉시 멈춘다.** `WH_KEYBOARD_LL`/`WH_MOUSE_LL` 훅으로 `LLKHF_INJECTED`/`LLMHF_INJECTED` 가 없는 입력을 감지하면 중단한다. `GetLastInputInfo` 는 합성 입력도 세므로 이 판정에 쓸 수 없다.
5. **modifier 는 어떤 종료 경로에서도 풀린다.** 우리가 누른 키만 KEYUP 한다 — 사람이 누르고 있는 modifier 에 KEYUP 을 쏘면 데드맨이 넘겨준 그 사람의 타이핑을 망친다.
6. **주입은 최소 표면.** HTTP 로 되는 것(pane 포커스, 출력 읽기, 알림)은 HTTP 로 한다. SendInput 은 §2 의 네 항목에만 쓴다.
7. **`activity.type == "shell"` 인 pane 만 대상.** interactiveApp(Claude·Codex·vim)이 도는 pane 에 타이핑하는 것은 남의 세션에 입력을 넣는 것이므로 거부한다.
8. **lease 는 상태를 화면에 드러낸다.** 부여·회수 시 알림을 띄운다. 만료(최대 1시간)되면 실행 중이라도 중단된다. `LAYMUX_DEVINPUT_DISABLE=1` 은 lease 를 무시하고 전부 차단한다.

## Alternatives Considered

- **laymux 본체(Rust)에 넣고 MCP/HTTP 로 노출.** 자기 HWND 를 알고 `GetForegroundWindow` 와 비교하는 자기참조 가드가 가능해 타깃 오발 위험이 오히려 낮다. 기각 이유 둘: (a) 무인증 API 표면에 입력 주입이 생긴다(위 1번), (b) **앱이 멈추는 결함**이 우리가 쫓는 결함군에 있고, 그때 in-process 주입기는 앱과 함께 멈춰 재현 자체가 불가능해진다.
- **`cfg(debug_assertions)` + feature flag 로 본체에 조건부 포함.** release 바이너리에서는 사라지지만 dev 인스턴스는 여전히 무인증 포트로 입력 주입을 노출한다. dev 도 사용자 데스크톱에서 돈다. 또 IME 는 플레이키해서 같은 시나리오를 수십 번 돌리는데, 그 루프에 `cargo build` 를 끼울 수 없다.
- **WebView2 에 DOM 합성 이벤트 주입(CDP/`dispatchEvent`).** 빌드 없이 되고 안전하다. 그러나 §2 가 지목한 지점이 정확히 "합성 이벤트로는 재현되지 않는다" 이므로 문제를 재정의하는 것일 뿐이다. #555 에서 내가 측정한 이벤트 순서와 실제 순서가 달랐던 것도 이 층위의 차이였다.
- **창 제목(`Laymux`)이나 프로세스 이름으로 타깃 선택.** 방법론 §1 이 이미 기각했다. 둘 다 dev/release 구분에 쓸 수 없고, 한 번 release 에 입력이 들어갔다.
- **`automation.json` 의 pid 를 권위로 쓰기.** issue #574 로 무력화된다. 살아 있는 dev 인스턴스에 discovery 파일이 없는 상태를 실측했고, 레이스 창에서는 파일이 release 포트를 주장한다.
- **데드맨 없이 `pid` 확인만.** 사용자가 PC 를 맡긴 뒤 예상보다 일찍 돌아오는 경우를 못 잡는다. 포그라운드 확인은 "창이 바뀌었나" 만 보고, 사용자가 dev 창을 그대로 둔 채 키보드를 만지는 경우를 통과시킨다.
- **환경변수 하나로 허용(`ALLOW=1`).** 세션 전체에 걸쳐 무기한 유효하다. 긴 대화 중 임의 시점에 사용자 키보드를 잡는 것을 막지 못한다. 시간제 lease 를 선택한 이유가 그것이다.

## Consequences

- §2 의 "사람이 해야만 하는 입력" 목록이 줄어든다. 재현 시퀀스를 파일로 고정해 `--repeat N` 으로 돌리면 IME 처럼 플레이키한 케이스를 pass/fail 비율로 판정할 수 있고, 이는 1회 성공을 근거로 삼던 것보다 강하다.
- **자율성은 조건부로 남는다.** 사용자가 lease 를 부여하고 dev 창을 포그라운드로 둬야 하며, 그 동안 키보드·마우스를 쓸 수 없다. 이 도구는 사람을 제거하지 않고 사람의 개입 단위를 "키 시퀀스 하나하나" 에서 "한 번의 위임" 으로 바꾼다.
- 포그라운드 독점이 본질적 비용이다. 잠긴 세션·RDP 끊김에서는 동작하지 않는다(대화형 데스크톱 세션 필요).
- Windows 전용 부채가 생긴다. macOS/Linux IME 재현은 방법론 §2 의 사람 경로가 계속 정본이다.
- UIPI: dev 가 관리자 권한이고 헬퍼가 아니면 SendInput 이 조용히 실패한다. `doctor` 가 마커 왕복으로 이 경우를 진단해 실패로 보고한다(조용한 성공으로 넘기지 않는다).
- 재검토 조건: (a) Automation API 에 인증이 도입되면 1번의 근거가 약해진다 — 그때 in-process 안(더 강한 자기참조 가드)을 다시 볼 수 있다. (b) 데드맨 오탐(정상 실행이 자꾸 중단됨)이 실사용을 방해하면 마우스 임계값·키 판정을 다시 정한다. (c) release 인스턴스가 dev 와 다른 실행 파일명을 갖게 되면 2번의 이미지 검사를 강화할 수 있다.
