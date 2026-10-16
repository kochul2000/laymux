# 0334. laymux 내부 WSL 실행은 콘솔 없이 lifted `wsl.exe`를 직접 띄운다 (0120·0104 실행 수단 정정)

- Status: Proposed
- Date: 2026-10-16
- Source: 2026-10-16 prod 멈춤 조사(세션 USER 자원 고갈) · [AGENTS.md](../../AGENTS.md) "외부 프로세스는 `headless_command()`" · [api-contracts.md](../architecture/api-contracts.md) §14 프로세스 실행 · [ADR-0120](0120-wsl-agent-session-attribution.md) · [ADR-0134](0134-wsl-guest-interactive-app-liveness.md) · [ADR-0104](0104-codex-usage-app-server-probe.md)
- 정정: ADR-0120의 "`crate::process::headless_command()`로 `wsl.exe … --exec sh` probe를 실행한다"와 ADR-0104 WSL usage profile의 app-server 실행 수단. probe 내용·주기·deadline·인자 검증은 그대로다.

## Context

laymux는 WSL pane을 이해하려고 짧은 `wsl.exe` 실행을 자주 한다. activity reconcile의 liveness probe(3초 주기, distribution당 1회, [ADR-0134](0134-wsl-guest-interactive-app-liveness.md)·[ADR-0135](0135-activity-reconcile-backend-diff-push.md)), 에이전트 세션 귀속 probe(Codex turn 1초·hook 상태 2초·session record 폴링이 각각 호출, ADR-0120), Codex 진단·status probe, default distribution `--list`, hook helper, WSL usage app-server가 모두 그렇다. 2026-10-16 실측으로 laymux의 직속 `wsl.exe` 실행은 분당 약 87회였다.

이 실행은 모두 `headless_command()`, 즉 `CREATE_NO_WINDOW`로 만들어진다. 창만 숨길 뿐 실행마다 새 콘솔이 생기고 그 콘솔 호스트 `conhost.exe`가 사용자 세션의 window manager 객체를 쥔다(실측 USER 3, GDI 10). inbox `System32\wsl.exe`는 lifted 클라이언트(`C:\Program Files\WSL\wsl.exe`)를 다시 띄우는 런처라, 클라이언트가 그 콘솔을 물려받는다. 클라이언트는 자기 콘솔 참조 핸들을 `CreateLxProcess`로 WSL 서비스에 넘기고, 서비스의 console manager는 콘솔별 매핑을 만들어 클라이언트 종료 콜백에서 정리한다.

2026-10-16에는 이 정리가 멈췄다. 게스트 저널에 14:54·15:02 session leader vsock accept 타임아웃과 15:02:46 WSL init 크래시(`CaptureCrash … !init, signal: 6`)가 남았고, 15:14:21부터 laymux의 `wsl.exe` 실행마다 콘솔이 풀리지 않았다. 세 시간 동안 부모가 없는 `conhost.exe`가 17,174개(서비스 핸들 138,103개) 쌓였다. 18:28부터 세션의 chrome·Explorer·SearchHost·StartMenu가 CoreMessaging·XAML failfast와 `0x80070486`(`ERROR_NO_MORE_USER_HANDLES`)로 연쇄 크래시했고, 18:33 laymux의 WebView2 browser 프로세스가 죽어 화면이 멈췄다. 회복은 재부팅뿐이었다. 남은 콘솔 생성률은 laymux 실행 빈도와 같았고, WebView가 죽어 프론트 폴링이 멈춘 순간 분당 약 60개에서 15개로 함께 떨어졌다.

누수 자체는 WSL 결함이다. 그러나 실행마다 콘솔을 하나씩 만드는 laymux의 실행 방식이 그 결함을 세션 전체 장애로 키웠다. 콘솔이 없으면 같은 상태에서도 잃을 window manager 자원이 없다.

제약: inbox 런처를 `DETACHED_PROCESS`로 띄우면 런처가 클라이언트에 새 **보이는** 콘솔을 붙여 주고, 리다이렉트한 stdout/stderr가 사라진다(실측). 런처는 콘솔이 있어야 파이프를 넘긴다.

범위는 laymux가 스스로 만드는 비대화형·파이프 기반 `wsl.exe` 실행이다. 비목표: PTY pane의 WSL 셸(pseudoconsole 필요), 사용자가 지정한 gh prefix 같은 사용자 정의 커맨드, probe 주기와 공유 캐시, WebView2 프로세스 실패 복구.

## Decision

laymux 내부의 `wsl.exe` 실행은 `crate::process::headless_wsl_command()` 하나로만 만들고, lifted WSL이 있으면 그 클라이언트를 `DETACHED_PROCESS`로 직접 실행해 콘솔을 만들지 않는다.

- lifted 클라이언트 위치의 SoT는 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Lxss\MSI`의 `InstallLocation`이다(64-bit view). 프로세스 수명 동안 한 번 읽고, 실행마다 `<InstallLocation>\wsl.exe`가 파일로 있는지 확인한다.
- 값이 없거나 파일이 없으면(inbox 전용 WSL, 제거된 설치) 기존 `headless_command("wsl.exe")`로 되돌아간다. 이 경로의 노출은 기존과 같다.
- 인자 구성·distribution 검증·stdio·timeout은 호출부 책임 그대로다. 콘솔 없는 실행은 stdin/stdout/stderr를 파이프나 NUL로 받는 실행에만 쓴다.
- 불변식: 소스 트리에 `headless_command("wsl.exe")`가 없다(테스트가 강제한다). 대화형 WSL(PTY)은 이 헬퍼를 쓰지 않는다.
- WSL은 콘솔 없는 클라이언트를 console ID 0 하나의 매핑으로 묶어 session leader를 공유한다. laymux 실행은 콘솔 상태나 TTY에 의존하지 않으므로 이 공유를 가정하지도, 피하지도 않는다.

## Alternatives Considered

- **inbox 런처에 `DETACHED_PROCESS`** — 런처의 콘솔은 사라지지만 런처가 클라이언트에 새 보이는 콘솔을 만들고 출력이 사라진다. 실행마다 창이 뜨므로 기각.
- **probe 주기 축소·distribution별 snapshot 공유만** — 누수 속도는 줄지만 실행마다 콘솔이 생기는 구조는 남아, WSL이 같은 상태가 되면 시간 문제다. liveness 3초는 ADR-0135의 8초 freshness 계약에 묶여 주기만 늘릴 수도 없다. 별도 결정으로 함께 추진할 가치는 있지만 이 결정을 대체하지 못한다.
- **laymux가 콘솔 하나를 만들어 모든 실행이 공유** — conhost가 하나로 묶이지만 GUI 프로세스의 `AllocConsole`은 창 표시·숨김, 수명, 다른 자식의 콘솔 상속 같은 부작용이 크고 std `Command`로 표현하기 어렵다.
- **콘솔 누수를 감지해 probe를 멈추는 circuit breaker** — 콘솔이 없으면 감지할 대상이 사라진다. inbox fallback 경로의 보호책으로만 후속 검토한다.
- **`%ProgramFiles%\WSL\wsl.exe` 하드코딩** — 대부분 맞지만 설치 위치의 SoT가 아니다. MSI가 기록한 레지스트리 값을 쓴다.

## Consequences

- WSL이 콘솔 정리를 멈춰도 laymux 실행은 세션의 USER/GDI 자원을 쓰지 않는다. 실행당 `conhost.exe`가 2개(런처 콘솔 + wslhost 자체 콘솔)에서 1개(wslhost 자체 콘솔, wslhost와 함께 종료)로 줄고, 런처 프로세스 하나도 사라진다.
- 실측: 콘솔 없는 클라이언트로 병렬 6 × 4회 실행에서 출력·종료코드가 모두 정확했고 `conhost.exe` 수는 늘지 않았다.
- 비용: 레지스트리를 읽는 Windows 전용 코드와 windows-sys `Win32_System_Registry` feature가 생긴다. inbox 전용 WSL 사용자는 보호받지 못한다.
- 재검토 조건: WSL이 콘솔 없는 클라이언트 처리(console ID 0 공유)나 lifted 설치 위치 기록 방식을 바꿀 때, 또는 콘솔 없는 실행에서 guest 동작 차이가 드러날 때.
- 테스트: 런처 선택 로직, Windows에서 콘솔 없는 실행이 `conhost.exe`를 만들지 않음(대조군 포함), lifted WSL 실기 테스트(`--ignored`), `headless_command("wsl.exe")` 재유입을 막는 소스 가드.
- 문서: AGENTS.md와 api-contracts.md §14의 프로세스 실행 규칙에 이 예외를 적는다.
- 후속(별도 결정): distribution별 WSL `/proc` snapshot 공유·동시 요청 병합으로 실행 횟수 축소, WebView2 `ProcessFailed` 복구, inbox fallback 경로의 콘솔 누수 감지.
