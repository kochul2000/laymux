# 0341. 종료 결과와 관측 상태를 서로 다른 아이콘으로 표시하고, PowerShell 중단을 OSC 133 D로 전달한다

- Status: Accepted
- Date: 2026-10-17
- Source: 사용자 요구("—와 체크의 경계가 다소 모호해 보여서", "정확히 고칠 수 있는 것만 고쳐", ADR-0340 후속 제한점), [ADR-0251](0251-single-terminal-status-icon.md), [ADR-0250](0250-terminal-task-state-and-notification-transitions.md), [ADR-0340](0340-claude-transcript-turn-result.md), [ADR-0262](0262-powershell-command-lifecycle.md), [ADR-0001](0001-osc-rust-single-pass.md), [ADR-0205](0205-lucide-application-icon-source.md)
- Partially Supersedes: [ADR-0251](0251-single-terminal-status-icon.md)의 "다섯 표시만 사용, 중단과 결과 없는 종료와 미확인은 `—`, 중단·결과 미관측 전용 아이콘 없음, 접근성 이름은 다섯 의미만" 결정. 단일 아이콘, 상태 툴팁 제거, 출력 파형·지연 시계 미표시, 알림 테두리, Desktop·Remote 공용 순수 함수 결정은 유지한다.
- 보완: ADR-0262의 PowerShell 통합이 `Stopped`를 결과 없는 종료로만 보내던 부분에 중단 표지를 더한다.

## Context

ADR-0250은 작업 상태(작업 없음·진행 중·입력 대기·종료)와 종료 결과(성공·실패·중단, 결과 미관측)와 관측 상태(확인·미확인·지연)를 구별했다. 이어서 ADR-0251은 사용자 합의에 따라 화면을 간결하게 하려고 표시를 `— / ⏳ / ! / ✓ / ✗` 다섯 개로 줄였다. 중단은 실패 X가 아닌 중립 대시로 두고, 상시 노출되던 미확인 물음표를 없앴다. 그 결과 현재 `taskStatusGlyph`는 다음을 모두 `—`로 그린다.

| 의미               | 데이터                            | 현재 |
| ------------------ | --------------------------------- | ---- |
| 작업 없음          | `state=idle`                      | `—`  |
| 종료 + 중단        | `state=ended, result=interrupted` | `—`  |
| 종료 + 결과 미관측 | `state=ended, result` 없음        | `—`  |
| 미확인 (관측 없음) | `state` 없음, 출력 없음           | `—`  |

ADR-0340 이후 Claude·Codex·Grok은 중단과 결과를 관측하는데, 화면에서는 "끝났지만 결과를 모름", "사용자가 멈춤", "아직 아무것도 모름", "작업 없음"이 같은 대시로 보인다. 사용자는 이 대시와 성공 체크의 경계가 모호하다고 보고 구분을 요청했다. 데이터는 이미 구분되어 있어 표시만 나누면 된다. 라벨(`commandStatus.interrupted`·`ended`·`unknown`)도 이미 번역되어 있지만 쓰이지 않는다. ADR-0251이 피하려던 것은 상시 노출되는 경고성 물음표의 소음이므로, 미확인은 가장 약한 점으로 표시해 그 의도를 유지한다.

PowerShell 통합 스크립트(ADR-0262)는 Ctrl+C로 멈춘 명령(`Get-History`의 `ExecutionStatus = Stopped`)을 이미 구별하지만, 이전 종료 코드를 재사용하지 않으려고 OSC 133 D를 종료 코드 없이 보낸다. 그래서 laymux는 이 경우를 결과 미관측으로만 받는다. 표준 OSC 133 D에는 중단을 나타내는 칸이 없다.

범위 밖:

- 응답 시작 전 Esc로 끝난 Claude 턴. Claude가 중단 표지를 남기지 않으므로, Esc 입력이나 신호 부재로 추론하지 않는다(ADR-0250, ADR-0340).
- bash(laymux가 WSL에 주입하는 통합 포함)의 중단. bash 통합은 `$?`만 알고, SIGINT로 끝난 명령과 스스로 130을 반환한 명령이 같은 값이다. foreground 작업은 별도 프로세스 그룹이라 셸 자신은 Ctrl+C를 받지 않으므로 정확히 구별할 근거가 없다. bash의 130은 지금처럼 실패다.
- laymux가 주입하지 않는 셸(zsh·cmd 등)의 중단. 사용자 통합이 보내는 OSC 133은 해석하지만 중단 표지를 요구하지 않는다.
- 출력 활동 배지 분리, 관측 지연 표시. 별도 결정이다.

## Decision

**작업 없음·중단·결과 미관측·미확인을 서로 다른 아이콘으로 표시하고, laymux PowerShell 통합은 `Stopped` 명령을 OSC 133 D의 laymux 전용 옵션으로 중단이라 알린다.**

### 아이콘

| 의미               | glyph | Lucide      | 색        | 라벨               |
| ------------------ | ----- | ----------- | --------- | ------------------ |
| 진행 중            | `⏳`  | Hourglass   | yellow    | 활동 중            |
| 입력 대기          | `!`   | CircleAlert | yellow    | 응답·승인 필요     |
| 종료 + 성공        | `✓`   | Check       | green     | 성공               |
| 종료 + 실패        | `✗`   | X           | red       | 실패               |
| 종료 + 중단        | `⊘`   | Ban         | yellow    | 중단               |
| 종료 + 결과 미관측 | `○`   | Circle      | secondary | 종료 · 결과 미관측 |
| 작업 없음          | `—`   | Minus       | secondary | 대기               |
| 미확인             | `·`   | Dot         | secondary | 작업 미확인        |

- 판정은 지금처럼 `taskStatusGlyph(state, result, outputActive)` 하나가 소유하고, Desktop·Remote·selector가 같은 함수를 쓴다. 출력 활동이 있는 미확인은 지금처럼 `⏳`다(범위 밖).
- 중단은 실패와 다른 색(yellow)이다. 사용자가 멈춘 것은 오류가 아니다. 알림 수준(`warning`)과도 맞다.
- 결과 미관측은 "끝났다"는 확인이 있으므로 작업 없음(`—`)과 다른 빈 원으로 표시한다. 미확인은 근거가 없다는 뜻이므로 가장 약한 점으로 표시한다. 비통합 셸 pane은 늘 미확인이므로 눈에 거슬리지 않아야 한다.
- glyph 문자는 표시용 호환 값이다. 상태 판정이나 정책의 근거로 쓰지 않는다(ADR-0250).

### PowerShell 중단 표지

- 통합 스크립트는 `Stopped`인 명령에 `OSC 133 ; D ; ; lx=interrupted`를 보낸다. 종료 코드 칸은 비워 둔다. OSC 133 D를 해석하는 다른 쪽(xterm.js, 사용자 도구)은 종료 코드 없는 종료로 읽으므로 호환된다.
- Rust OSC 단일 패스(ADR-0001)가 D의 데이터를 `종료 코드[;옵션...]`으로 나눈다. 첫 칸은 지금처럼 정수일 때만 종료 코드다. 옵션 중 `lx=interrupted`가 있으면 lifecycle 이벤트에 `result: "interrupted"`를 싣는다. 이 옵션과 종료 코드가 함께 오면 중단을 우선한다.
- 프론트는 `result: "interrupted"`를 종료 결과로 쓴다. 옵션이 없으면 지금처럼 종료 코드 0은 성공, 그 밖의 정수는 실패, 없으면 결과 미관측이다.
- 셸이 Ctrl+C를 받을 수 있어야 한다. PTY 데몬(ADR-0308)은 `CREATE_NEW_PROCESS_GROUP`로 시작하므로 Windows가 "Ctrl+C 무시" 플래그를 켜고, 이 플래그는 자식 프로세스에 상속된다. 그래서 데몬이 만든 native 셸에서는 Ctrl+C가 명령을 멈추지 못했다(dev 실측과 PTY 통합 테스트로 재현). 셸을 만드는 공통 경로(`open_and_spawn`)가 첫 생성 전에 한 번 `SetConsoleCtrlHandler(NULL, FALSE)`로 정상 Ctrl+C 처리를 복원한다. 이 호출은 프로세스 매개변수의 플래그만 바꾸므로 콘솔이 없는 release 데몬에서도 동작한다(콘솔을 떼고 플래그를 켠 전용 테스트로 확인). 호출한 프로세스(데몬·GUI)는 PTY의 콘솔에 붙어 있지 않으므로 PTY 콘솔의 Ctrl+C는 받지 않는다. 자기 콘솔에 붙은 프로세스(예: `cargo tauri dev`로 띄운 dev GUI)는 그 콘솔의 Ctrl+C를 일반 콘솔 프로그램처럼 받는다. WSL bash는 Linux tty가 Ctrl+C를 처리하므로 이 플래그와 무관하다.
- 종료 코드 130이나 `STATUS_CONTROL_C_EXIT` 같은 값을 중단으로 해석하지 않는다. 명령이 그 값을 직접 반환할 수 있어 중단의 증거가 아니다. 중단은 PowerShell이 기록한 `Stopped`만 근거로 한다.

## Alternatives Considered

- **ADR-0251대로 `—`로 유지:** 간결하지만, 결과 관측이 늘어난 뒤로는 "끝났지만 결과 모름"과 "작업 없음"을 구별할 수 없다는 사용자 지적을 해결하지 못한다.
- **미확인에 `?` 사용:** ADR-0251이 없앤 상시 물음표 소음이 돌아온다. 비통합 셸 pane 전부에 경고처럼 보인다.
- **중단을 실패(`✗`, red)로 합침:** 사용자가 멈춘 명령을 오류로 보이게 한다. Codex·Claude는 둘을 구별해 관측한다.
- **종료 코드 130으로 중단 전달:** POSIX 관례지만 PowerShell·Windows 명령에는 해당하지 않고, 명령이 130을 반환하면 구별할 수 없다.
- **별도 OSC 코드(예: 사설 번호)로 중단 전달:** 파서와 훅 테이블에 새 코드를 추가해야 하고, D와 순서가 어긋나면 다른 명령에 붙을 수 있다. 같은 D 이벤트의 옵션이 원자적이다.

## Consequences

- Desktop selector, Remote, MCP 상태 투영에서 중단·결과 미관측·작업 없음·미확인이 서로 다르게 보인다. 기존 `—`를 성공 이외의 종료로 읽던 사용자는 새 아이콘을 익혀야 한다.
- 관측이 없는 pane(아직 마운트되지 않은 workspace의 pane, OSC 133이 없는 셸)은 `—` 대신 `·`로 보인다.
- native PowerShell 셸에서 Ctrl+C로 명령을 멈출 수 있게 된다. 이전에는 PTY 데몬에서 상속된 무시 플래그 때문에 멈추지 않았다. 멈춘 명령은 중단(`⊘`)과 `종료 (중단)` 알림으로 나타난다. dev 실측에서 `Start-Sleep`과 native `ping -t` 모두 `Stopped`로 기록되었다(`ping`의 `$LASTEXITCODE`는 `-1073741510`).
- 플래그 복원은 PowerShell만이 아니라 laymux가 만드는 모든 native 콘솔 프로세스에 적용된다. cmd, native Claude·Codex가 띄운 도구, 종료 시 `interruptTerminals`(ADR-0048)와 clear의 `interrupt` 모드가 보내는 Ctrl+C도 이제 일반 콘솔에서처럼 전달된다. 이는 그 경로들이 원래 의도한 동작이다.
- 이미 실행 중인 셸은 업데이트 전의 통합과 플래그를 그대로 가지므로 결과 미관측으로 남는다. 새로 만든 셸부터 적용된다.
- 검증
  - 단위: glyph 매핑 전 조합, Desktop 아이콘 컴포넌트(종류·Lucide·라벨), Remote 아이콘 이름, OSC D 옵션 파싱(옵션만·코드와 함께·알 수 없는 옵션·옵션 없음·130), lifecycle 이벤트의 `result`, 프론트 종료 결과와 `(중단)` 알림.
  - PTY 통합: `powershell_lifecycle`이 콘솔 신호 fixture 없이 실제 ConPTY PowerShell에 Ctrl+C를 보내 `D;;lx=interrupted`를 확인한다. 이전에는 테스트가 상속된 무시 플래그를 스스로 풀어야 했다. 실행 환경과 무관하게 회귀를 잡도록, 전용 테스트 바이너리 `ctrl_c_inheritance`가 무시 플래그를 직접 켜고 콘솔을 뗀 뒤(release 데몬과 같은 조건) 셸을 만들어 Ctrl+C 중단을 확인한다.
  - dev 실기: PowerShell `Start-Sleep`·`ping -t` Ctrl+C → 중단 아이콘·알림, 실패·성공 명령, Claude 응답 도중 Esc(Windows·WSL) → 중단, Claude 응답 전 Esc → 빈 원, 관측 없는 pane → 점, selector 스크린샷.
- 재검토 조건: OSC 133 D에 중단을 표준으로 나타내는 옵션이 생기거나, 사용자 셸 통합이 같은 옵션을 보내기 시작할 때.
