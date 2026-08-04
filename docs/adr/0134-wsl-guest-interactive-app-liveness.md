# 0134. WSL pane 의 인터랙티브 앱 liveness — 게스트 프로브가 권위

- Status: Proposed
- Date: 2026-08-04
- Source: issue #766, ADR-0009 (확장·정정), architecture/data-flow.md §8 · §9, PR #768 코드 리뷰(codex)

## Context

[ADR-0009](0009-process-tree-interactive-app-liveness.md) 는 인터랙티브 앱의 "살아있는가" 판정 권위를 **PTY 자식 프로세스 트리**로 옮겼다. 그 결정은 호스트 프로세스 열거가 PTY 자손을 전부 볼 수 있다는 전제 위에 서 있었고, 그 전제는 문서화되지 않았다.

WSL pane 에서 이 전제가 깨진다. PTY 자식은 `wsl.exe` 이고 `claude`/`codex` 는 게스트 VM 안의 리눅스 프로세스다. Windows Toolhelp32 스냅샷에는 존재하지 않는다. 그 결과 `classify()` 는 "스냅샷은 읽혔고 PID 도 아는데 트리 안에 앱이 없다"로 해석해 **`NoneAlive`(권위적 부정)** 를 반환한다.

`NoneAlive` 는 PR #292 에서 도입된 강한 신호다. 배너 스캔·스피너 타이틀 판정·grace window 를 전부 선점하고 캐시 엔트리까지 지운다. 그래서 WSL pane 은 Claude/Codex 를 실행 중이어도 영구히 `shell` 로 보고됐다. 실측(21 pane)에서 살아있는 에이전트 pane 중 인식된 것은 네이티브 `claude.exe` 를 띄운 PowerShell pane 하나뿐이었고, WSL pane 11 개(claude 5 · codex 6)가 전부 `shell` 이었다.

작용하는 force:

- **호스트에서 게스트를 볼 방법은 `wsl.exe` 를 통한 왕복뿐이다.** 왕복 실측 비용은 ~300ms(대부분 relay 기동 지연, 호스트 CPU 는 ~9ms).
- **PTY 콜백 스레드는 절대 막을 수 없다.** OSC 0/2 스피너 타이틀은 초당 수 회 도착하고 감지는 그 경로에서 동기 실행된다.
- **`NoneAlive` 를 약화시키는 것만으로는 안 된다.** WSL 에서 권위적 부정이 사라지면 16KB 창에 남은 배너가 죽은 pane 을 다시 pin 하는 PR #292 회귀가 그대로 돌아온다.
- 게스트 프로세스를 pane 에 귀속시킬 마커는 이미 있다 — 터미널 환경에 주입되는 `LX_TERMINAL_ID` 를 자식이 상속한다. 세션 귀속용 WSL 프로브(`wsl_agent_session`)가 이미 같은 방식을 쓴다.

비목표: 프론트엔드가 판정 누락을 되돌리는 reconcile 경로(issue #767). 이 ADR 은 백엔드 판정 자체만 다룬다.

## Decision

**WSL pane 의 liveness 권위는 호스트 프로세스 트리에서 게스트 프로브로 옮긴다.** 호스트 스냅샷은 WSL pane 에 대해 어떤 판정도 내리지 않는다 — `NoneAlive` 도 포함한다.

1. **도메인 경계는 PTY 핸들이 소유한다.** `PtyHandle.wsl_backed` 가 spawn 시점의 `is_wsl_command` 결과를 들고 있고, `app_in_pty` 는 이미 잡고 있는 `pty_handles` 락에서 그 값을 읽는다. WSL pane 이면 호스트 스냅샷을 아예 열지 않는다. 추가 락도, 콜드 스타트 구멍도 없다.

2. **게스트 왕복은 백그라운드 refresher 전담이다.** 감지 경로는 refresher 가 발행한 스냅샷을 읽기만 한다. 프로브는 pane 단위가 아니라 distribution 단위이므로 pane 수가 비용을 곱하지 않는다.

3. **freshness 정책은 비대칭이다.** 신선한 스냅샷은 양방향 권위를 갖는다. 낡은 스냅샷에서는 `Running` 만 살아남고 **부정은 `Unknown` 으로 강등**된다. 낡은 부정을 유지하면 방금 시작한 에이전트를 스테일 윈도가 끝날 때까지 가리게 되는데, 그것이 바로 이 ADR 이 없애려는 실패다. 반대로 낡은 양성은 종료 인지가 늦어질 뿐이다.

3-1. **종료 판정에는 캐시된 양성을 쓰지 않는다.** ADR-0009 의 false-exit 억제(`suppresses_false_exit`)는 **일회성** 결정이다 — 억제하면 그 종료는 다시 발화하지 않는다. 게스트를 PTY 콜백 스레드에서 호출할 수 없으므로 "지금 살아있다"를 증명할 수단이 없고, 따라서 종료 판정 목적(`Purpose::ExitDecision`)의 조회에는 양성을 반환하지 않는다. 결과적으로 WSL pane 은 ADR-0009 의 false-exit 억제를 갖지 못한다 — 이 ADR 이전에도 갖지 못했다(호스트 트리가 항상 `NoneAlive` 였으므로 억제가 성립하지 않았다). 잘못된 억제는 이미 종료된 pane 을 다음 타이틀까지 고정시키고 되돌릴 reconcile 경로가 없으므로(#767), 표시 지연보다 나쁘다. 게스트 프로브가 종료 자체를 소유하고 이벤트로 발행하는 방향은 후속 과제다.

4. **판정이 없는 pane 은 판정 없음이다.** 마지막 패스가 대변할 수 있었던 pane 만 스냅샷에 들어가고, 없으면 `Unknown` 이다. 프로브 실패·타임아웃·distribution 미해결·동일 depth 경합·귀속 불가 에이전트 존재는 전부 여기로 떨어지고, 타이틀/버퍼 휴리스틱이 판정을 되찾는다. 즉 **모든 실패 경로의 종착지는 ADR-0009 이전의 휴리스틱**이며, 어떤 실패도 `shell` 을 단정하지 않는다.

4-1. **판정은 PTY 세대에 바인딩한다.** pane 은 같은 terminal_id 로 즉시 재생성될 수 있다(Restart View, 프로파일 변경). 이전 세대에 대한 판정은 새 프로세스에 대해 아무 말도 하지 않으므로, 스냅샷은 `(terminal_id, generation)` 로 기록하고 조회 시 세대가 다르면 `Unknown` 이다. 세션 종료 경로에서도 해당 항목을 지워, 종료 이전에 시작된 프로브 패스가 뒤늦게 판정을 되살리지 못하게 한다. 이 판정은 표시뿐 아니라 CWD 전파 게이트(`detect_terminal_state_for_control`)도 읽으므로 세대 혼동은 표시 오류로 끝나지 않는다.

4-2. **귀속하지 못한 에이전트가 있으면 그 distribution 의 부정을 포기한다.** 다른 게스트 사용자로 실행된 에이전트(`sudo claude`, root pane)는 자기 `environ` 을 읽을 수 없다. 프로브는 조상 체인을 따라 올라가 첫 읽을 수 있는 `LX_TERMINAL_ID` 로 귀속을 시도하고 — `sudo claude` 는 pane 의 셸을 조상으로 가지므로 대개 성공한다 — 끝까지 실패했고 그 과정에 읽지 못한 항목이 있었다면 `U` 로 보고한다. 그 패스는 해당 distribution 의 어느 pane 도 "비어 있음"으로 확정하지 않는다. 반면 체인이 모두 읽혔는데 마커가 없으면 laymux 가 띄우지 않은 게스트 에이전트이므로 무시한다(그런 프로세스가 커버리지를 영구히 무력화하면 안 된다).

5. **관측되지 않는 동안에는 경계를 넘지 않는다.** refresher 는 감지가 WSL pane 을 최근에 물어본 경우에만 프로브한다. 아무도 보지 않는 창에서는 `wsl.exe` 호출이 0 이다.

5-1. **distribution 마다 독립 예산과 순환 순서를 준다.** 패스 하나가 공유 deadline 을 쓰면, 정렬상 앞의 distribution 하나가 예산을 다 태우는 순간 뒤의 distribution 은 매 패스마다 영구히 프로브되지 않는다(순서가 고정이므로 일시 장애가 영구 누락으로 굳는다). 각 distribution 은 자기 타임아웃을 갖고, 시작 인덱스는 패스마다 회전한다.

6. **pane 내부 순위는 게스트에서 계산한 조상 깊이로 정한다.** 가장 얕은 프로세스가 이긴다(Claude pane 이 Codex 를 서브프로세스로 띄워도 Claude 로 보고). 같은 depth 에 서로 다른 에이전트가 있으면 순위를 매길 수 없으므로 판정을 포기한다 — 추측보다 휴리스틱이 낫다.

7. **게스트 프로브 스크립트에 값을 보간하지 않는다.** distribution 은 `wsl.exe` argv 로 전달되며 `is_safe_distro_name` 검증을 통과해야 한다. 나머지 값은 전부 게스트 자신의 `/proc` 에서 나온다. 두 프로브(세션 귀속·liveness)가 이 검증에서 갈라지지 않도록 distribution 해석·검증·실행 plumbing 은 `wsl_probe` 단일 모듈이 소유한다.

## Alternatives Considered

- **WSL pane 에서 `NoneAlive` 를 `Unknown` 으로 강등만 하기.** 한 줄이면 되고 즉시 증상이 사라진다. 기각: 권위적 부정이 사라져 PR #292 가 막은 stale-banner 회귀가 WSL 에 그대로 돌아온다. 다만 이 강등은 정공법의 **실패 모드로 그대로 흡수**된다 — 프로브가 답을 못 주면 정확히 이 상태가 된다.

- **감지 경로에서 온디맨드로 프로브.** 캐시 미스마다 `wsl.exe` 를 부른다. 기각: PTY 콜백 스레드가 스피너 틱마다 300ms 씩 막힌다.

- **세션 귀속 프로브(`wsl_agent_session`) 재사용.** 이미 게스트 프로세스를 `LX_TERMINAL_ID` 로 귀속시킨다. 기각: 그 스크립트는 모든 PID 의 `environ` 을 읽고 모든 fd 를 `readlink` 한다 — 저장 시 1회라면 타당하지만 수 초 주기에는 과하다. liveness 프로브는 `comm` 이 `claude`/`codex` 인 프로세스만 더 들여다본다. 대신 distribution 해석·검증·실행 부분은 공유한다.

- **게스트에 상주 에이전트를 띄워 push 로 받기.** 폴링이 사라진다. 기각: pane 마다 게스트 프로세스 수명을 관리해야 하고, 그 수명 자체가 지금 풀려는 문제와 같은 종류의 신뢰성 문제를 새로 만든다.

- **`session.wsl_distro` 를 감지 경로에서 읽기.** distribution 을 pane 별로 정확히 안다. 기각: `terminals` 락이 필요한데 `detect_all_terminal_states` 가 그 락을 잡은 채 감지를 호출한다 — 같은 스레드에서 재진입하면 데드락이다. refresher(별도 스레드)만 그 락을 만진다.

## Consequences

- WSL pane 의 Claude/Codex 가 인식된다. 실측에서 `shell` 로 보고되던 11 개 pane 이 프로브에 전부 잡혔다.
- 비용: 관측 중인 동안 distribution 당 3초에 1회, 왕복 ~300ms(호스트 CPU ~9ms). pane 수와 무관하다. 아무도 보지 않으면 0.
- 인식 전환에 최대 한 refresh 주기의 지연이 붙는다. 그 사이는 타이틀/버퍼 휴리스틱이 메꾸므로 사용자에게는 ADR-0009 이전과 같거나 낫다.
- 낡은 양성이 최대 `WSL_LIVENESS_POSITIVE_MAX_AGE` 동안 종료된 앱을 살아있다고 **표시**할 수 있다. 이 창을 부정 창보다 길게 잡은 것은 의도적 트레이드오프다(3번). 단 종료 판정에는 이 양성을 쓰지 않으므로(3-1) 종료 이벤트가 지연되거나 유실되지는 않는다.
- WSL pane 은 ADR-0009 의 false-exit 억제를 받지 못한다. 살아있는 에이전트가 일시적으로 비-앱 타이틀을 내면 종료로 오판될 수 있고, 그때 표시는 다음 감지 패스(게스트 스냅샷)에서 회복되지만 종료 이벤트는 이미 발행된다. 이 ADR 이전과 동일한 동작이므로 회귀는 아니며, 게스트 프로브가 종료를 소유하도록 만드는 것이 정공법이다(후속).
- 다른 게스트 사용자로 에이전트를 돌리면서 그 조상 체인 어디에도 laymux 마커가 없는 경우(예: 전체가 root 소유인 pane) 그 distribution 은 매 패스 부정을 포기하므로, 같은 distribution 의 다른 pane 들도 게스트 권위 없이 휴리스틱으로만 판정된다. 안전한 방향의 열화다.
- distribution 별 타임아웃으로 한 패스의 최대 소요는 distribution 수에 비례한다. refresher 는 배경 스레드이므로 다음 패스가 늦어질 뿐이고, 감지 경로 지연에는 영향이 없다.
- `wsl_probe` 추출로 세션 귀속 프로브와 liveness 프로브가 distribution 검증을 공유한다. 한쪽만 고쳐서 갈라지는 부채가 사라진다.
- 게스트가 `comm` 을 `claude`/`codex` 로 노출하지 않는 설치 형태(래퍼 스크립트, `node` 로 뜨는 배포)는 잡히지 않는다. 그런 pane 은 `covered` 에 남되 앱이 없으므로 `NoneAlive` 로 보고되어 **휴리스틱까지 함께 막힌다** — 현재 알려진 배포는 모두 `claude`/`codex` 네이티브 런처이므로 수용하되, 다른 형태가 보고되면 `comm` 매칭 목록 확장 또는 `covered` 판정 완화로 재검토한다.
- 후속: 프론트엔드에는 판정 누락을 되돌릴 reconcile 경로가 없다(issue #767). 백엔드가 옳게 판정해도 이미 `shell` 로 굳은 인스턴스는 다음 타이틀 이벤트까지 갱신되지 않는다.
