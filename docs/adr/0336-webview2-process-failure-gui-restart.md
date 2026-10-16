# 0336. WebView2 프로세스가 실패하면 PTY 데몬 세션을 인계하고 GUI를 다시 시작하며, 재시작 예산으로 반복을 멈춘다 (0080 일부 대체)

- Status: Proposed
- Date: 2026-10-16
- Source: [issue #1215](https://github.com/kochul2000/laymux/issues/1215), 2026-10-16 18:33 사고([ADR-0334](0334-console-less-wsl-runs.md) Context), [WebView2 process-related events](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-related-events), [data-flow.md §8.23](../architecture/data-flow.md#823-pty-소유자와-pty-데몬), [data-flow.md §13.9](../architecture/data-flow.md#139-webview2-프로세스-실패-복구-windows), dev 실기(아래 Consequences)
- 관계: [ADR-0084](0084-desktop-terminal-output-parsed-credit.md)가 비목표로 남긴 WebView 프로세스 복구와 [ADR-0334](0334-console-less-wsl-runs.md)가 후속으로 남긴 `ProcessFailed` 복구를 결정한다. [ADR-0308](0308-pty-daemon-generations-across-updates.md)의 업데이트 인계(데몬 세션을 끝내지 않고 다음 GUI가 재결합)를 WebView 복구 재시작에 그대로 쓰며, [ADR-0301](0301-pty-daemon-default-adoption.md)의 재결합, [ADR-0312](0312-pty-daemon-grace-without-gui.md)의 유예, [ADR-0319](0319-update-handoff-carries-terminal-title.md)의 title 인계는 바꾸지 않는다. [ADR-0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md)의 "어떤 control path도 이 metric으로 동작을 바꾸지 않는다"를 일부 대체한다. WebView 무응답 복구 하나만 마지막 frontend health report의 **시각**을 읽는다.

## Context

2026-10-16 18:33 laymux의 WebView2 browser 프로세스가 `msedge.dll` `0x80000003`으로 죽었다(`%LOCALAPPDATA%\com.laymux.app\EBWebView\Crashpad\reports`, `WV=laymux.exe`). `laymux.exe`는 살아 있었지만 WebView 자식 프로세스가 0개가 되어 화면이 멈췄고, 재부팅 전까지 돌아오지 않았다. 근본 원인은 세션의 USER 핸들 고갈이었고 ADR-0334가 처리했다. 그러나 WebView2 프로세스는 GPU 드라이버, 런타임 결함, 메모리 부족, 외부 종료로도 죽는다. 지금은 그때마다 사용자가 앱을 직접 죽이고 다시 열어야 한다.

- 현재 GUI는 WebView2 `ProcessFailed`를 구독하지 않는다. wry와 tauri-runtime-wry도 구독하지 않는다. run 이벤트 처리는 `RunEvent::Exit` 정리뿐이다.
- WebView2 공식 규칙은 다음과 같다.
  - browser 프로세스 종료(`BROWSER_PROCESS_EXITED`)는 환경의 모든 컨트롤을 닫는다. 앱이 컨트롤을 다시 만들어야 한다.
  - main frame renderer 종료(`RENDER_PROCESS_EXITED`)는 내용을 오류 페이지로 바꾼다. `Reload`하거나 컨트롤을 닫고 다시 만든다.
  - main frame renderer 무응답(`RENDER_PROCESS_UNRESPONSIVE`)은 "무응답이 이어지는 동안 반복 보고"되며(예: 15초마다), 행동할 임계는 앱이 정한다.
  - GPU·utility·sandbox helper·PPAPI·unknown 프로세스는 WebView2가 스스로 다시 만든다. subframe renderer 종료(`FRAME_RENDER_PROCESS_EXITED`)는 main frame을 남긴다. 앱이 복구할 필요가 없다.
- **무응답 보고는 타이머가 아니라 응답받지 못한 입력에서 나온다.** dev 실기에서 renderer main thread를 막자, 입력이 없는 동안에는 보고가 없었다. 입력 하나를 보내면 약 15초 뒤 보고가 한 번 왔다. 그 뒤 무응답이 23초 더 이어졌지만, 새 입력이 없으니 다시 보고되지 않았다. 그래서 "보고가 몇 번, 얼마 동안 이어졌는가"로는 정지 시간을 잴 수 없다. 반면 프론트는 main thread가 도는 동안 1초 간격으로 health report를 보낸다(ADR-0080). 마지막 report 이후 시간이 곧 main thread가 멈춘 시간이다.
- **프론트엔드는 reload를 견디지 못한다.** `TerminalView`는 pane에서 정해지는 안정 id(`terminal-<paneId>`)로 `create_terminal_session`을 부르는데, backend는 같은 id의 세션이 살아 있으면 `Session '…' already exists`로 거절한다. 같은 GUI 프로세스 안의 재결합도 첫 생성에만 허용된다(ADR-0301). dev에서 페이지를 reload하자 모든 터미널 pane이 이 오류로 비었다. 같은 프로세스 안에서 WebView를 다시 만들어도 같은 일이 생긴다.
- 반면 **GUI 프로세스 교체는 이미 설계·검증된 경계다.** 업데이트 인계(ADR-0308)는 데몬 세션을 끝내지 않고 GUI만 바꾼다. 새 GUI는 저장된 레이아웃을 복원하고, 같은 terminal id의 첫 생성에서 세션을 재결합한다. 화면 redraw(ADR-0307), 놓친 OSC(ADR-0309), title(ADR-0319), 표시 문맥(ADR-0329)도 따라온다. GUI가 없어도 데몬은 유예 시간(기본 10분, ADR-0312) 동안 세션을 유지한다.
- **Tauri `restart()`는 Windows에서 쓸 수 없다.** `std::process::Command`로 새 프로세스를 띄우는데, std는 Windows에서 항상 `bInheritHandles = TRUE`를 넘긴다. tokio(mio) 소켓은 상속 가능하게 만들어지므로 새 GUI가 이전 GUI의 Automation listen 소켓을 물려받는다. 포트는 아무도 accept하지 않는 소켓에 묶이고, 새 GUI 자신의 bind는 `os error 10048`로 실패한다. dev 실기에서 재현했다.
- 사고처럼 세션 자원이 고갈된 상태라면 다시 시작한 GUI도 곧 다시 죽는다. 재시작마다 새 프로세스라 메모리만으로는 재시작 횟수를 셀 수 없다.

범위는 Windows 메인 WebView의 `ProcessFailed`다. 비목표는 다음과 같다: Linux WebKitGTK web process 종료 처리, 같은 프로세스 안의 WebView 재생성이나 reload 생존, subframe 복구, `CoreWebView2Environment.BrowserProcessExited` 구독, health report의 내용(vitals·카운터)을 제어에 쓰는 것.

## Decision

**Windows에서 메인 WebView의 `ProcessFailed`를 구독해 모든 보고를 기록한다. main frame을 잃는 실패, 곧 browser 프로세스 종료와 main frame renderer 종료, 그리고 프론트가 30초 넘게 health report를 보내지 못한 상태의 무응답 보고는 업데이트와 같은 데몬 인계로 GUI를 다시 시작해 복구한다. 최근 10분 안에 자동 재시작이 2번 있었으면 더 이상 자동으로 재시작하지 않고 네이티브 대화상자로 묻는다.**

### 구독과 기록

- setup 끝(`AppState`를 관리한 뒤)에 `WebviewWindow::with_webview` → `controller().CoreWebView2()` → `add_ProcessFailed`로 한 번 구독한다. 구독에 실패하면 경고만 남긴다. 복구만 잃고 앱은 그대로다.
- 핸들러는 UI 스레드에서 args를 읽는다. args는 콜백 동안만 유효하다. 종류, `ICoreWebView2ProcessFailedEventArgs2`의 `Reason`·`ExitCode`·`ProcessDescription`, `…Args3`의 `FailureSourceModulePath`를 읽고, 런타임에 없는 인터페이스는 건너뛴다. 모든 보고를 프론트 침묵 시간과 함께 `tracing`으로 남긴다(복구는 error, 대기·기록은 warn).
- 히스토리 파일, 인계, 대화상자처럼 막히는 일은 worker 스레드에서 한다. 스레드를 만들 수 없으면(자원 고갈) UI 스레드에서라도 한다.
- `webview2-com`·`windows-core`를 wry가 링크하는 것과 같은 버전(0.39.1/0.62.2)으로 Windows 전용 직접 의존에 둔다.

### 종류별 정책

정책은 순수 함수다. 프론트 침묵 시간과 재시작 기록은 입력이다.

| 보고 | 판단 |
| --- | --- |
| `BROWSER_PROCESS_EXITED` | 복구 |
| `RENDER_PROCESS_EXITED` | 복구 |
| `RENDER_PROCESS_UNRESPONSIVE` | 프론트가 30초 이상 health report를 보내지 않았으면 복구, 아니면 대기 |
| `FRAME_RENDER_PROCESS_EXITED`·GPU·utility·sandbox helper·PPAPI plugin·PPAPI broker·unknown·모르는 값 | 기록만 |

- **프론트 침묵 시간**은 마지막 health report가 도착한 시각부터 잰다. 한 번도 보고하지 않았으면 구독을 시작한 시각부터 잰다. 부팅 중 멈춘 프론트도 그래서 잡힌다. 시계가 뒤로 가면 0으로 읽고, 0은 재시작하지 않는다. health 상태를 읽지 못하면(mutex poison) 0으로 읽는다(fail closed).
- 이 판단은 health report의 **도착 시각**만 읽는다. report 내용(probe 지연, bridge·pipeline 카운터)은 여전히 진단 전용이다.
- 보고 하나로 판단한다. 사용자가 멈춘 창에 다시 입력하면 다음 보고가 오고, 그때의 침묵 시간으로 다시 판단한다.
- `Reason`은 기록과 안내에만 쓴다. 판단에는 쓰지 않는다.
- 복구가 시작되면 이 프로세스의 이후 보고는 무시한다. 복구 하나가 WebView 전체를 바꾼다.
- Windows 세션이 로그오프·종료 중이면(`SM_SHUTTINGDOWN`) 복구하지 않는다. WebView2가 세션과 함께 끝나므로, 재시작한 GUI도 곧 끝난다.

### 복구는 데몬 인계 GUI 재시작이다

1. 재시작 예산을 확인하고, 허가되면 **재시작하기 전에** 기록한다(아래).
2. 업데이트 설치와 같은 순서로 인계한다: 인계 표시(`begin_update_handoff`) → 에이전트 터미널 title 선택(ADR-0319) → `terminate_child_processes`(GUI 소유 PTY와 usage probe는 끝내고, 데몬 handle은 종료 요청 없이 놓는다) → title 저장. 인계는 어느 경로에서든 한 번만 한다.
3. 다음 GUI를 띄운다. `CreateProcessW`를 `bInheritHandles = FALSE`로 직접 호출하고, 인자는 `--relaunch-after <이 PID>` 하나다. GUI는 자기 인자를 쓰지 않으므로 잃는 인자가 없다. 새 GUI는 `main()`에서 그 PID가 끝날 때까지 최대 10초 기다린 뒤 시작한다. 그래서 Automation 포트, lx endpoint, WebView2 프로필을 이전 GUI가 놓은 뒤에 잡는다. 인계를 먼저 하는 것도 이 10초가 정리 시간에 쓰이지 않게 하기 위해서다.
4. `exit(0)`으로 정상 종료한다. exit 경로는 인계 표시 때문에 데몬 세션을 끝내지 않는다.
5. 새 GUI는 저장된 레이아웃을 복원하고 데몬 세션을 재결합한다. 프론트가 죽었거나 멈췄으므로 마지막 checkpoint를 남기지 못한다. 복원점은 마지막으로 commit된 것이다.

GUI가 소유한 PTY(데몬을 못 쓴 fallback, `LAYMUX_PTY_DAEMON=0`)는 업데이트 때처럼 끝나고, 새 GUI에서 새로 시작한다.

### 재시작 예산

- 자동 재시작 시각(wall clock epoch ms)을 설정 cache 디렉터리의 `webview-recovery.json`(`{"restartsMs": [...]}`)에 둔다. 재시작은 새 프로세스이므로 디스크가 SoT다.
- 지금으로부터 앞뒤 10분 안의 기록이 2개 이상이면 소진이다. 시계가 뒤로 간 경우 미래 시각도 한 창 안이면 센다. 한 창보다 먼 미래 시각은 세지 않아 복구를 영구히 막지 않는다.
- 허가된 재시작은 재시작 전에 기록한다. 기록을 읽거나 쓸 수 없으면 재시작하지 않는다(fail closed). 기록 없는 재시작은 다음 GUI가 예산을 모르게 해 루프를 막지 못한다. 파일이 없거나 파싱되지 않으면 기록이 없는 것으로 본다. 쓰기는 임시 파일과 rename으로 하므로, 파싱 실패는 손으로 고친 경우다. 다음 기록이 파일을 고친다.
- 파일에는 창 안의 최근 기록 2개만 남긴다.

### 자동으로 재시작하지 않을 때

- 기존 네이티브 대화상자 수단(`rfd::MessageDialog`, crash reporter와 같은 MessageBoxW)으로 예/아니요를 묻는다. 본문은 실패 종류·이유·종료 코드, 멈춘 이유(예산 소진, 기록 실패, 새 GUI 기동 실패), 데몬 작업이 유예 시간 동안 남는다는 안내다.
- 예산 소진·기록 실패는 묻고 나서 인계한다. 사용자가 답할 때까지 Remote와 Automation API가 터미널을 계속 쓸 수 있게 하기 위해서다. 기동 실패는 이미 인계한 뒤라 그대로 묻는다.
- **예**: 다시 시작한다. 예산 밖이지만 기록해서, 창 안의 다음 실패가 다시 묻게 한다.
- **아니요**, 또는 대화상자를 띄우지 못하면: 데몬 세션을 인계하고 종료한다. 사용자가 유예 시간 안에 다시 열면 이어지고, 열지 않으면 데몬이 끝낸다(ADR-0312).
- 어느 쪽이든 죽은 창을 남기지 않는다. 남은 프로세스가 고정 Automation 포트와 lx endpoint를 쥐어 다음 실행을 방해하기 때문이다.

### 플랫폼

구독, 재기동, 대화상자는 Windows 코드다. 정책·예산·안내문은 플랫폼 중립 코드이며 모든 플랫폼에서 단위 테스트한다. Linux 동작은 바뀌지 않는다.

## Alternatives Considered

- **renderer 종료·무응답에 `Reload`(공식 권장):** 프론트가 같은 terminal id로 터미널을 다시 만들다 `already exists`로 실패한다(dev 실측). 같은 프로세스 안의 재결합도 막혀 있다. reload를 견디게 하려면 프론트 수명과 backend 터미널 상태(출력 sequence·credit·generation·재결합 기회)를 분리하는 새 계약이 필요하다. 프로세스 교체는 검증된 경계(ADR-0308)를 그대로 쓴다.
- **같은 프로세스에서 WebView(창) 다시 만들기:** Tauri는 기존 창의 컨트롤러 재생성을 노출하지 않는다. 새 창은 `main` 라벨, capability, 창 위치를 다시 맞춰야 하고, 마지막 창이 닫히면 exit 경로가 돈다. 프론트는 reload와 같은 이유로 터미널을 다시 만들지 못한다.
- **Tauri `AppHandle::restart`/`request_restart`:** handle 상속 때문에 새 GUI가 Automation 포트를 쓰지 못한다(dev 실측). std `Command`로는 상속을 끌 수 없다. PTY 데몬 기동(ADR-0300)과 같은 이유로 `CreateProcessW`를 직접 부른다.
- **새 GUI의 포트 bind를 재시도:** 상속된 소켓이 새 GUI 안에 남는 한, 기다려도 풀리지 않는다. 상속을 끄더라도 이전 GUI가 끝나기 전에 WebView2 프로필과 lx endpoint를 다투게 된다. 이전 PID를 기다리는 편이 순서를 보장한다.
- **무응답 보고가 30초 이상 이어지면 복구(보고 간격으로 정지 시간 추정):** 보고는 입력이 있어야 오고 저절로 반복되지 않는다(dev 실측). 사용자가 몇 번 누르다 멈추면 영원히 복구되지 않는다. 짧은 정지 두 번이 이어진 것과 긴 정지 하나도 구분하지 못한다.
- **무응답 첫 보고에서 바로 복구:** 출력 폭주가 main thread를 십수 초 붙잡을 수 있다(#606의 42~87초 정지). 그런 정지마다 GUI를 다시 시작하게 된다. 30초 침묵은 사용자가 반쯤 기다린 뒤에만 복구한다.
- **report 내용(probe 지연·stall 수)으로 판단:** 진단 계약(ADR-0080)을 넓게 깬다. 도착 시각 하나로 충분하다.
- **안내만 하고 재시작하지 않기:** 사고처럼 사용자가 앱을 직접 죽이고 다시 열어야 한다. 데몬이 작업을 이어 줄 수 있는데 쓰지 않는다.
- **예산을 메모리·환경 변수로 전달:** 재시작하면 메모리는 사라진다. 환경 변수는 새 GUI가 띄우는 터미널에 샌다.
- **기록에 실패해도 재시작:** 다음 GUI가 예산을 모르므로 자원 고갈 세션에서 무한 재시작이 된다.
- **`BrowserProcessExited`(environment 이벤트)도 구독:** browser 크래시는 `ProcessFailed`로도 온다. 이 이벤트는 정상 종료에도 오므로 구분이 더 필요하다. 사용자 데이터 폴더 관리 같은 용도도 없다.
- **"아니요"에서 데몬 세션도 끝내기(앱 닫기 = 작업 종료):** 사용자는 망가진 창을 닫겠다고 했지 작업을 끝내겠다고 하지 않았다. GUI crash와 같은 유예 보호를 준다.

## Consequences

- browser나 main frame renderer가 죽으면 1초 남짓 뒤 화면이 돌아온다. 프론트가 멈춘 창에 사용자가 입력하면, WebView2가 무응답을 보고하는 시점(입력 약 15초 뒤)에 침묵이 30초를 넘었으면 화면이 돌아온다. 데몬 터미널(셸·에이전트·빌드)은 끊기지 않고 같은 프로세스로 이어진다.
- dev 실기(Windows 11, WebView2 데이터 폴더 분리, vite 별도 기동)에서 다음을 확인했다. 매번 같은 셸(같은 `$$`, 앞서 export한 변수)이 재결합됐다.
  - renderer 강제 종료: `RenderProcessExited`/`Crashed`, 새 GUI 기동·포트 획득·재결합까지 약 1초.
  - browser 강제 종료: `BrowserProcessExited`/`Unexpected`, 같은 결과.
  - 세 번째 실패: 예산 소진으로 대화상자가 떴다. 대화상자가 떠 있는 동안 Automation API로 터미널 입출력이 됐다. 아니요를 고르면 종료 후 데몬 세션이 남았고, 다시 열자 재결합됐다. 예를 고르면 재시작했고 기록이 남았다.
  - CDP로 main thread를 막고 입력 하나: 침묵 51초에서 보고가 와 복구했다. 28초 정지에서는 침묵 19초에서 보고가 와 대기했고, 프론트는 스스로 돌아왔다.
  - 수정 전 Tauri `restart()`로는 새 GUI가 포트를 얻지 못했다.
- 비용과 위험:
  - 마지막 commit 이후의 프론트 메모리 상태(저장 전 초안 등)와 GUI가 소유한 PTY는 잃는다. 재시작 직전 checkpoint와 출력 캐시 저장은 없다. 재결합한 터미널의 화면은 데몬 화면 모델로 다시 그린다(ADR-0307).
  - 자원이 고갈된 세션에서는 최대 2번 재시작한 뒤 묻는다. 그동안 창이 두 번 사라졌다 나타난다.
  - 10분·2회·30초는 문서와 실측, 사고 경험에서 잡은 값이다. 실사용에서 무응답 오탐이나 미탐이 보이면 다시 정한다.
  - 프론트 health report의 도착 시각이 제어 입력이 됐다. report 주기나 timer throttling을 바꾸는 변경은 이 판단도 함께 본다.
  - 새 GUI는 이전 GUI가 끝날 때까지 최대 10초 기다린다. 이전 GUI가 그보다 오래 끝나지 않으면 포트를 잡지 못할 수 있다.
  - `cargo tauri dev`에서는 이전 GUI가 끝날 때 CLI가 vite를 끝내므로, 재시작한 GUI가 화면을 불러오지 못한다(업데이트 restart 검증과 같다). dev 실기는 vite를 따로 띄워 검증한다([dev-repro-methodology.md §4.8](../dev-repro-methodology.md)).
  - 대화상자는 사용자가 고를 때까지 떠 있다.
  - Linux에는 여전히 복구가 없다.
- 검증: 정책·예산·안내문·SDK 값 대응 단위 테스트, 재기동 인자·선행 PID 대기 테스트, frontend health 시각 테스트, 데몬 인계 adoption 테스트, dev 실기.
- 재검토 조건: Tauri/wry가 같은 프로세스 WebView 재생성이나 `ProcessFailed` 처리를 제공하거나, 프론트가 reload를 견디는 계약이 생기면 Reload 복구를 다시 검토한다. Linux에서 WebKitGTK web process 종료가 관측되면 같은 정책을 별도로 결정한다.
