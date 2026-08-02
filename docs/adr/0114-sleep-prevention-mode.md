# 0114. 절전 방지는 설정이 모드를 소유하고 OS 억제는 Rust 단일 지점이 건다

- Status: Proposed
- Date: 2026-08-02
- Source: issue #727, [ADR-0005](0005-display-state-raw-separation-compute.md), architecture/api-contracts.md §10
- Amended by: [ADR-0116](0116-sleep-prevention-two-axes.md) — 3값 모드와 상단 바 순환 버튼 부분만 정정된다. 억제 계층·watchdog·desired/held·플랫폼 전략은 유효하다.

## Context

에이전트(Claude Code, Codex)나 빌드가 터미널에서 몇십 분씩 도는 동안 OS 가 절전으로 들어가면 작업이 멈춘다. 사용자는 상단 바 버튼 하나로 "지금은 재우지 마"를 켤 수 있어야 하고, 동시에 "실행 중일 때만 재우지 마"라는 조건부 동작도 원한다(issue #727 의 모드1/모드2).

제약과 force:

- **OS 억제는 프로세스 자원이다.** Windows 는 `SetThreadExecutionState` 로 스레드에 상태를 매달고, Linux 는 systemd inhibitor lock 을 잡는다. 어느 쪽이든 "누가 켜고 껐는지"가 한 곳에서 관리되지 않으면 이중 획득·미해제가 생긴다.
- **표시 상태는 이미 원시 상태 두 개에서 파생된다.** 사용자가 고른 모드와 터미널 busy 여부가 각각 다른 시스템에 산다. ADR-0005 의 원칙(원시 상태 분리 → 단일 계산 함수)이 그대로 적용된다.
- **모드는 설정이지 UI 상태가 아니다.** 앱을 껐다 켜도 "재우지 않기"는 유지돼야 한다.
- laymux 는 Windows·Linux 만 지원한다. macOS 지원은 비목표다.
- 프로세스가 비정상 종료해도 OS 억제가 남으면 안 된다. 사용자 눈에 보이지 않는 상태로 머신이 영원히 안 자는 것이 최악의 실패다.

범위: 절전 억제 모드의 소유권, 억제를 거는 계층, 크로스플랫폼 구현 전략, 실패 정책. 비목표: 디스플레이(화면) 절전 억제, 워크스페이스별 모드, 예약/스케줄.

## Decision

**절전 방지 모드는 `settings.power.sleepPrevention` 이 단일 진실원으로 소유하고, 실제 OS 억제는 프론트가 계산한 boolean 하나를 Rust `power` 모듈이 멱등하게 반영한다.**

- **모드 값은 `"off" | "always" | "whenBusy"` 세 가지다.** `always` 가 issue 의 모드1(절대 재우지 않기), `whenBusy` 가 모드2(busy 터미널이 있으면 재우지 않기)다. 상단 바 버튼은 `off → always → whenBusy → off` 순환이며, 버튼과 Settings 는 같은 설정 필드를 읽고 쓴다.
- **"busy" 는 원시 필드에서 다시 유도하지 않고 상태 계산 결과를 그대로 읽는다.** `isTerminalWorking()`(`ui/src/lib/terminal-working.ts`) 는 해당 터미널의 `ActivityHandler.computeStatus()` 결과 아이콘이 `STATUS_ICON_WORKING`(⏳)인지만 본다. `outputActive` 와 `activity.type === "running"` 은 신호의 일부일 뿐이다 — Claude 의 local-agent 경로(issue #225)와 Codex 의 Braille 스피너는 `outputActive === false`, `activity.type === "interactiveApp"` 인 채로 모래시계를 띄우며, 그 사실을 아는 것은 각 핸들러뿐이다. 아이콘을 그리는 함수에게 되묻는 것이 "모래시계가 도는데 잠들었다"를 구조적으로 막는 유일한 방법이다. `terminalActivity` 위젯도 같은 함수를 쓴다.
- **에이전트가 사용자 입력을 기다리는 동안은 busy 가 아니다.** input-pending 상태의 핸들러 판정이 ⏳ 가 아니므로 자동으로 그렇게 된다. 사용자 차례라면 머신이 자도 된다.
- **집계 범위는 활성 워크스페이스가 아니라 전체 터미널이다.** 백그라운드 워크스페이스에서 도는 빌드야말로 절전으로 끊기면 안 되는 작업이다.
- **파생은 순수 함수 `shouldInhibitSleep(mode, hasBusyTerminal)` 이 담당한다.** 프론트는 이 결과가 바뀔 때만 `set_sleep_inhibit(enabled)` 를 호출한다. 명령은 멱등이며 값이 같으면 OS 호출을 하지 않는다.
- **커맨드 대화는 프로세스 수명의 모듈 coordinator 가 소유한다.** 커맨드가 async 이므로 겹친 두 호출은 순서가 뒤집혀 먼저 보낸 쪽 상태로 남을 수 있다. 한 번에 하나만 in flight 로 두고 그 사이 오간 중간 값은 접는다. 이 상태를 React ref 에 두지 않는 이유는 재마운트가 두 번째 큐를 만들어 옛 release 와 새 request 가 서로 다른 큐에서 겹치기 때문이다 — 컴포넌트가 아니라 프로세스의 상태다. 마지막 해제는 dedupe 를 무시하는 별도 경로이며 자기 실패로 취소되지 않고, 재시도는 유한하다.
- **백엔드는 원하는 상태(desired)와 실제 상태(held)를 나눠 가진다.** `held` 는 성공한 apply 에서만 바뀐다. 획득 실패를 "잡았다"로 기록하면 UI 가 거짓말하고, 해제 실패를 "놓았다"로 기록하면 아무도 다시 알아차리지 못한다. 커맨드는 요청값이 아니라 `held` 를 돌려준다.
- **억제 생존은 백엔드가 스스로 확인한다.** 프론트는 *변화*만 보고하므로 `always` 모드에서는 다시 호출할 일이 영영 없다. 30초 주기 watchdog 이 desired 와 held 를 맞춰 죽은 억제와 한 번도 성공하지 못한 획득을 함께 재시도한다. 앱 setup 과 커맨드 양쪽에서 기동을 보장한다(한쪽에만 묶으면 spawn 실패가 세션 내내 복구되지 않는다).
- **백엔드가 스스로 만든 상태 변화는 이벤트로 프론트에 돌려준다.** watchdog 전이에는 요청이 없어 프론트가 알 방법이 없고, 그러면 UI 가 복구된 뒤에도 실패로 남거나 더 나쁘게는 보호가 풀렸는데 켜진 채로 남는다.
- **표시하는 "지금 억제 중"은 백엔드 응답이지 사용자 의도가 아니다.** 실패한 요청도 성공처럼 보이면 UI 가 지켜준다고 말하는 동안 머신이 잠든다. 커맨드 결과를 별도 런타임 스토어(`useSleepInhibitStore`)에 기록하고 버튼은 그것만 읽는다. 실패는 "억제 안 됨"이 아니라 "모름"으로 취급해 다음 해제 시도를 중복으로 건너뛰지 않는다.
- **Rust `power::SleepInhibitor` 가 프로세스 전체에서 유일한 억제 소유자다.** `AppState` 가 소유하고, 내부 뮤텍스는 자기 자신만 보호한다 — 다른 `AppState` 락을 잡은 채 취하지 않으므로 §14.3 락 순서에 참여하지 않는다.
- **Windows**: 전용 워커 스레드가 `SetThreadExecutionState` 를 호출한다. 이 API 는 호출한 *스레드*에 상태를 매달고 그 스레드가 끝나면 상태도 사라지므로, Tauri 커맨드가 어느 워커 스레드에서 실행되는지에 억제 수명을 맡기지 않는다. 플래그는 `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` 만 쓴다 — 시스템 절전만 막고 화면은 정상적으로 꺼지게 둔다.
- **Linux**: `systemd-inhibit --what=idle:sleep --mode=block ... cat` 을 자식으로 띄우고 그 stdin 파이프의 쓰기 끝을 laymux 가 쥔다. 해제는 파이프를 닫아 정상 종료를 기다리고, 버티면 kill 한다 — 그 실패는 삼키지 않는다. laymux 가 강제 종료돼도 커널이 파이프를 닫아 `cat` 이 EOF 로 끝나고 inhibitor lock 이 자동 해제된다 — 크래시가 억제를 남기지 않는 것은 이 구조의 핵심이다.
- **실패는 조용히 넘기지 않되 설정을 되돌리지도 않는다.** `systemd-inhibit` 부재 등으로 억제를 못 걸면 커맨드는 `Err` 를 반환하고, 프론트는 로그를 남기고 그 사실을 표시 상태에 반영한다. 사용자가 고른 모드는 그대로 유지된다(다른 머신에서 같은 설정을 쓸 수 있다).
- 지원하지 않는 플랫폼에서는 `enabled=false` 는 성공(no-op), `enabled=true` 는 `Err` 다.

## Alternatives Considered

- **Tauri 커맨드 스레드에서 직접 `SetThreadExecutionState` 호출.** 코드가 제일 짧다. 기각: 억제 수명이 Tauri 런타임의 스레드 풀 동작이라는 문서화되지 않은 세부에 묶인다. 스레드가 회수되는 순간 억제가 조용히 풀리고, 그 실패는 "가끔 잠든다"로만 관측돼 진단이 거의 불가능하다.
- **Linux 에서 zbus 로 `org.freedesktop.login1.Manager.Inhibit` 직접 호출.** 자식 프로세스가 없어 더 깔끔하고 fd 수명도 명확하다. 기각: D-Bus 스택 의존성(zbus + 비동기 런타임 연결)이 이 크기의 기능에 비해 과하다. `systemd-inhibit ... cat` + 파이프가 같은 fd 수명 보장을 의존성 없이 준다. 나중에 D-Bus 가 다른 이유로 들어오면 재검토한다.
- **`systemd-inhibit ... sleep infinity` (파이프 없이).** 더 단순하다. 기각: laymux 가 SIGKILL 되면 자식이 고아로 남아 inhibitor lock 을 무기한 붙잡는다. 사용자가 이유를 알 수 없는 채로 머신이 안 자게 된다.
- **모드를 localStorage 같은 로컬 UI 상태로 저장.** 기각: 앱 동작을 바꾸는 사용자 구성이며 재시작 후에도 유지돼야 한다. settings.json 이 사용자 구성의 정본이라는 기존 경계에 그대로 들어맞는다.
- **모드를 Rust 가 소유하고 백엔드가 busy 를 직접 관찰.** 억제 결정이 한 프로세스 안에서 끝나 왕복이 없다. 기각: busy 판정("모래시계")은 activity 핸들러·outputActive 타이머 등 프론트 상태 계산의 결과물이다. 백엔드가 같은 판정을 다시 구현하면 두 번째 busy 정의가 생기고, 표시와 동작이 갈라진다.
- **`ES_DISPLAY_REQUIRED` 도 함께 설정.** 화면까지 켜두면 진행 상황을 눈으로 볼 수 있다. 기각: 사용자가 요구한 것은 절전 방지지 화면 켜두기가 아니다. 노트북 배터리·번인 비용이 이득보다 크고, 필요하면 나중에 별도 옵션으로 확장한다.
- **`whenBusy` 를 기본값으로.** 대부분의 사용자가 원할 동작이다. 기각: 사용자가 켜지 않은 전원 정책을 앱이 임의로 바꾸는 것은 놀라움이 크다. 기본값은 `off` 이고, 켜는 것은 명시적 행동이어야 한다.

## Consequences

- OS 자원을 실제로 잡고 놓는 지점이 `Inner::reconcile` 하나로 좁혀진다. `set`·watchdog(`revalidate`)·`Drop` 은 모두 그리로 들어가므로, 억제가 안 풀리는 버그를 볼 곳이 한 군데다.
- `whenBusy` 모드에서 마지막 터미널이 idle 로 바뀌는 즉시 억제가 풀린다. `outputActive` 는 버스트 타이머로 꺼지므로 억제 해제도 그 타이머만큼 지연된다 — 의도된 히스테리시스이며 별도 debounce 를 두지 않는다.
- 상단 바 버튼은 `whenBusy` 에서 "지금 억제 중"인지를 색으로 드러낸다. 모드와 실제 억제 상태가 다를 수 있다는 사실이 UI 에 노출돼야 사용자가 동작을 신뢰할 수 있다.
- 실기 검증 부채: 실제 절전 억제 여부(Windows `powercfg /requests`, Linux `systemd-inhibit --list`)는 단위 테스트로 확인할 수 없다. 순수 계산 함수와 커맨드 배선만 자동 테스트로 덮고, OS 반영은 수동 확인 항목으로 남긴다.
- Linux 에서 `systemd-inhibit` 이 없는 환경(비 systemd 배포판)은 이 기능이 동작하지 않는다. 대체 백엔드(xdg-screensaver 등)는 요청이 생기면 그때 추가한다.
- 재검토 조건: macOS 를 지원하게 되거나, 화면 절전 억제 요구가 생기거나, D-Bus 의존성이 다른 이유로 들어오는 경우.
