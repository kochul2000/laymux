# 0335. WSL 게스트 관측은 distribution별 공유 run으로 합치고, 신선도는 호출자가 계약한다 (0120 probe 실행 단위·0238 진단 실행 방식 확장)

- Status: Proposed
- Date: 2026-10-16
- Source: issue #1214, 2026-10-16 prod 멈춤 조사(PR #1213, [ADR-0334](0334-console-less-wsl-runs.md)의 후속 항목) · [architecture/data-flow.md](../architecture/data-flow.md) §9 "WSL pane — 게스트 프로브가 권위"·§13.4·§13.5 · [api-contracts.md](../architecture/api-contracts.md) §14
- Extends: [ADR-0120](0120-wsl-agent-session-attribution.md)(WSL 귀속 probe의 실행 단위와 deadline 적용 방식), [ADR-0238](0238-codex-lifecycle-storage-checkpoint.md)(WSL Codex 진단 도구의 실행 방식)
- Related: [ADR-0134](0134-wsl-guest-interactive-app-liveness.md)·[ADR-0135](0135-activity-reconcile-backend-diff-push.md)(liveness probe와 3초 주기·8초 신선도 계약은 바꾸지 않는다), [ADR-0295](0295-codex-continuous-conversation-checkpoint.md)(checkpoint는 방금 읽은 guest 관측을 쓴다), [ADR-0334](0334-console-less-wsl-runs.md)(이 결정은 그 "distribution별 snapshot 공유·동시 요청 병합" 후속 항목이다)

## Context

laymux는 WSL pane의 에이전트를 게스트 `/proc`으로만 볼 수 있다. 세션 귀속 probe(`laymux-wsl-agent-probe`)는 `LX_TERMINAL_ID`가 있는 모든 프로세스의 PID·PPID·이름·홈·Codex rollout FD를 읽는다. provider 선택(`select_top_level_agent`)은 이 출력 위에서 하므로 스캔 자체는 provider와 무관하다. 그런데 호출자마다 자기 `wsl.exe`를 띄웠다.

- Codex turn 표시(응답 후 1초)는 조회마다 distribution당 스캔 1회와 Codex pane마다 진단 도구(`laymux-wsl-codex-probe`) 1회를 실행했다(D+N).
- 훅 상태(응답 후 2초)는 `get_terminal_session_attributions_impl`을 부르고, 이 함수는 Claude·Codex·Grok 조회를 병렬로 돌려 같은 스캔을 provider마다 반복했다(3D+N). 유효한 훅 snapshot이 있으면 재검증으로 한 번 더 부른다.
- Claude·Grok 세션 기록(1초, 조건부)은 provider마다 스캔했다.
- 세션 checkpoint(persist-session, 종료·업데이트·eviction·watchdog)도 같은 함수로 3D+N을 실행했고, critical 저장은 150ms 간격으로 두 번 관측한다.
- Codex 종료 `/status` 확인은 대상 수집·재확인·단계마다 Codex 프로세스를 다시 스캔한다.

2026-10-16 89초 캡처에서 laymux 직속 `wsl.exe`는 분당 약 87회였고 그중 `laymux-wsl-agent-probe`가 80회였다. ADR-0334로 실행마다 콘솔이 남지는 않지만, 실행마다 런처·클라이언트·wslhost·게스트 셸과 WSL 서비스 왕복이 든다. 같은 사고에서 서비스 쪽 상태가 망가졌을 때 실행 빈도가 피해를 곱했다. 줄일 대상은 실행 횟수다.

작용하는 force:

- **세션 영속 정확성.** checkpoint가 오래된 관측으로 이미 끝난 에이전트를 살아 있다고 저장하면 다음 실행에서 끝낸 대화가 resume된다. ADR-0295는 WSL checkpoint가 "방금 실행한 guest probe"를 쓰고 화면용 캐시로 판단하지 않게 했다. receipt(ADR-0296)는 capture 동안의 NoAgent·Codex proof를 증거로 쓴다.
- **deadline.** ADR-0120의 resolution당 3초 단일 deadline, 정상 종료 저장 5초 예산, critical 이중 관측의 두 번째 관측이 첫 관측과 독립이라는 성질을 지켜야 한다.
- **pane 정체성.** 게스트 프로세스는 terminal id만 상속하고 PTY generation은 모른다. Restart View처럼 같은 id에 새 PTY가 붙기 전에 찍은 스캔은 새 generation에 대해 말할 수 없다.
- **liveness 계약.** reconcile 3초 주기와 8초 음성 신선도(ADR-0135)에 묶여 liveness 주기만 늘릴 수는 없다.
- **Codex 진단 시간.** PR #1050에서 pane마다 `wsl.exe`를 순차 실행하면 16 pane·대용량 DB에서 3초 예산을 넘겨 최대 4개 병렬로 바꿨다. 실행 비용의 대부분은 `wsl.exe` 왕복(ADR-0134 실측 약 300ms)이고, 게스트 안 도구 1회는 92MB `logs_2.sqlite`에서 약 26ms였다(2026-10-16 실측).

범위는 세션 귀속 스캔과 WSL Codex 진단 실행이다. 비목표: liveness probe(스크립트·주기·예산), default distribution 캐시, 종료 `/status` 확인의 다른 WSL 읽기(cmdline·stat·설정·rollout 부재), home probe, 프론트 폴링 주기.

## Decision

**WSL 에이전트 프로세스 스캔과 Codex 진단은 AppState가 소유한 공유 run 테이블(`wsl_probe::snapshot`)로만 실행한다. 같은 probe·distribution·argv·PTY catalog의 요청은 run 하나를 공유하고, 각 호출자는 "표시 폴링 재사용" 또는 "경계 이후 시작된 관측" 중 하나를 신선도 계약으로 명시한다.**

1. **소유와 SoT.** `AppState.wsl_guest_snapshots`(`GuestProbeCache`)가 run 테이블을 소유한다. run 결과는 probe의 원시 stdout이고, 해석은 형식을 아는 소유자(`commands::wsl_agent_session`, `commands::codex_session::wsl`)가 읽을 때 한다. 테이블 mutex와 run별 결과 mutex는 leaf다. guest I/O 동안·서로를 기다리는 동안·순서 있는 AppState 락과 함께 잡지 않는다. catalog를 만들 `pty_handles`는 들어오기 전에 놓는다.
2. **캐시 키.** `(probe 이름, distribution, argv)`와 `TerminalCatalog`. 에이전트 스캔은 argv가 없어 distribution당 하나다. Codex 진단은 정렬된 `(PID, terminal id)` 묶음이 argv다.
3. **무효화는 PTY catalog로 한다.** `TerminalCatalog`는 모든 live PTY의 `(terminal id, generation)` 정렬 목록이다. run은 시작할 때의 catalog에만 유효하다. 생성·종료·fatal teardown·같은 id 재생성·데몬 adoption은 모두 catalog를 바꾸므로 이전 run을 재사용하지 않는다. 사용 시점에 `pty_handles`와 비교하므로 lifecycle 경로마다 무효화 호출(`wsl_liveness::forget` 같은)을 둘 필요가 없고, 빠뜨릴 경로도 없다.
4. **신선도 계약(`GuestObservation`).**
   - `StartedAfter(경계)`: 경계 이후 시작된 run만 받는다. 실행 중인 run이 경계 이후 시작됐으면 합류하고, 아니면 새 run을 시작한다. run의 시작 시각은 스레드를 띄우기 전 요청 시각이라 경계 판정은 보수적이다.
   - `Reusable`: `WSL_GUEST_SNAPSHOT_MAX_AGE`(3초) 안에 시작된 run이면 끝났든 실행 중이든 쓴다.
   - 재사용된 표시용 관측은 checkpoint 증거가 되지 않는다. `Reusable` 조회는 receipt에 NoAgent를 기록하지 않고 Codex proof(`remember_checkpoint`)를 남기지 않는다.

   | 호출자 | 경로 | 계약 |
   |---|---|---|
   | `get_terminal_session_attributions`(Tauri) | persist-session·종료·업데이트·eviction·watchdog checkpoint | 명령 시작이 경계. 세 provider가 같은 경계를 공유해 distribution당 스캔 1회. critical 두 번째 관측은 첫 관측 뒤의 새 경계 |
   | `verified_status_sessions` | 위 명령 안의 종료 `/status` 결과 합치기 | 그 명령의 관측을 그대로 쓴다 |
   | `status_probe::targets` | 종료 `/status` 대상 수집·재확인·단계 확인 | 대상 수집과 훅 선택은 한 경계를 공유하고, 끝의 재확인과 `require_current_process`는 매번 새 경계 |
   | `get_{claude,codex,grok}_session_ids`(Tauri) | 일회성 조회 | 호출 시각이 경계 |
   | `get_codex_turn_states` | Codex turn 표시(1초) | `Reusable`. rollout 읽기는 조회마다 한다 |
   | `get_agent_hook_states` | 훅 상태 표시(2초) | `Reusable`. 재검증은 제목·훅 연결·generation과 native 프로세스·세션 파일을 다시 읽고, WSL 게스트 관측(스캔·Codex 진단)은 같은 run일 수 있다 |
   | `get_agent_session_states` | Claude·Grok 기록 표시(1초) | `Reusable` |
5. **재사용 창.** `WSL_GUEST_SNAPSHOT_MAX_AGE`는 3초다. `WSL_AGENT_PROBE_TIMEOUT` 이상이어야 폴링이 실행 중인 run에 합류하고 느린 guest 옆에 run을 하나 더 띄우지 않는다. `ACTIVITY_RECONCILE_INTERVAL` 이하여야 폴링 귀속이 함께 쓰는 liveness 판정보다 한 패스 넘게 뒤처지지 않는다. 두 경계는 테스트로 고정한다. 실패도 답처럼 창 안에서 공유한다. 고장 난 guest를 폴링은 창마다 한 번만 묻고, 경계가 있는 호출자는 새로 묻는다.
6. **deadline은 대기자 것이다.** run은 자기 스레드에서 `WSL_AGENT_PROBE_TIMEOUT`으로 실행된다. run을 시작한 호출자를 포함해 모든 대기자는 자기 deadline까지만 기다린다. 대기자가 먼저 포기해도 run은 끝까지 가서 다음 요청을 위해 게시된다. 짧게 남은 예산이 다른 대기자의 run을 자르지 않고, 공유가 호출자의 예산을 늘리지도 않는다. deadline이 이미 지난 요청은 run을 시작하지 않는다. 한 resolution은 모든 distribution의 run을 먼저 요청하고 나서 기다리므로 distribution들이 같은 3초 안에서 겹친다.
7. **Codex 진단 묶음.** distribution마다 정렬한 Codex pane을 `WSL_CODEX_PROBE_BATCH_PANES`(4)개씩 묶어 묶음당 `wsl.exe -d <distro> --exec sh -c <batch> laymux-wsl-codex-probe <도구> <pid> <id> …` 1회로 읽는다. 게스트 셸은 동봉 도구를 pane마다 순서대로 실행하고 pane별 종료 상태와 JSON을 한 줄씩 낸다. 값은 argv로만 전달하고 보간하지 않는다. 형식이 깨진 run은 그 묶음의 pane 전부를 실패시키고, pane별 종료 상태·프로세스 식별 검증은 그 pane에만 결부한다. 같은 distribution의 묶음들은 동시에 실행한다. 동봉 도구의 인자·출력 계약(ADR-0238)은 바꾸지 않는다.
8. liveness probe와 그 주기·예산·회전은 바꾸지 않는다.

## Alternatives Considered

- **TTL 캐시만 두기(single-flight 없음).** checkpoint의 세 provider는 동시에 시작하므로 첫 요청이 셋 다 캐시를 비켜 간다. 동시 병합이 없으면 가장 흔한 중복이 남는다.
- **모든 호출자가 같은 재사용 창 쓰기.** 실행은 더 줄지만 checkpoint가 경계 이전 관측으로 끝난 에이전트를 저장할 수 있어 ADR-0295와 receipt 증거를 깬다.
- **lifecycle 지점의 명시적 무효화(`wsl_liveness::forget` 옆과 생성 경로).** 모든 생성·종료·재생성·adoption 경로를 찾아야 하고 하나만 빠져도 이전 generation의 프로세스를 새 pane에 붙인다. 사용 시점 catalog 비교는 경로를 열거하지 않는다. 대가로 native pane 생성·종료도 WSL run을 무효화하지만 드물다.
- **run을 시작한 호출자의 스레드에서 실행.** 스레드는 아끼지만 시작한 호출자의 남은 예산이 짧으면 합류한 대기자 모두의 run이 잘린다. 그렇게 잘린 실패와 진짜 실패를 구분할 수 없어 실패를 공유할 수도 없다.
- **liveness probe를 공유 스캔에 합치기.** distribution당 3초에 한 번으로 둘을 함께 줄일 수 있지만 두 스크립트의 의미가 다르다. liveness는 읽을 수 없는 environ의 조상을 따라 올라가고 귀속 불가 `U` 행으로 distribution 권위를 포기하며 패스 예산·회전을 갖는다(ADR-0134·0135). 합치면 reconcile 패스 예산이 무거운 environ 스캔에 묶인다. 이 결정에 넣지 않는다.
- **Codex 진단을 에이전트 스캔에 넣기(distribution당 `wsl.exe` 하나).** 실행은 가장 적지만 느린 Codex SQLite가 같은 distribution의 Claude·Grok 귀속까지 실패시키고, Claude만 읽는 호출자도 SQLite 비용을 낸다. 실패 범위가 섞여 기각한다.
- **동봉 도구가 여러 pane을 받아 내부 병렬로 읽기.** 프레이밍은 깔끔하지만 정적 바이너리 계약(ADR-0238)을 바꾸고 모든 개발 트리의 `gen/wsl` 재빌드를 요구한다. 게스트 안 1회 약 26ms라 셸 루프로 충분하다. 묶음이 시간 초과로 실패하기 시작하면 다시 검토한다.
- **재사용 창을 5초 이상으로.** 실행은 더 줄지만 폴링 귀속이 liveness 판정보다 한 패스 넘게 늦어진다. 3초로 목표를 맞춘다.
- **프론트 폴링 주기 늘리기.** checkpoint의 세 배 스캔을 못 고치고 turn 표시 응답성만 잃는다. 공유 run에서는 rollout 읽기를 1초로 유지하면서 guest 왕복만 줄일 수 있다.

## Consequences

- 실행 수(GUI 없는 폴링 재현 하네스, WSL distribution 1개·Codex pane 2개·Claude pane 1개·셸 pane 1개, Codex turn 1초·훅 상태 2초·세션 기록 1초·liveness 3초·critical checkpoint 20초를 모두 동시에 켠 상한 부하, 60초): 에이전트 스캔 248회 → 23회, Codex 진단 164회 → 23회, liveness 19회 → 19회. 기준 코드 수치는 실제 폴링 횟수에 기존 코드의 조회당 실행 수를 곱했고, 변경 코드는 run 테이블이 센 실행 수다. 23회 중 6회는 critical checkpoint의 경계 관측이고 나머지가 재사용 창당 1회인 폴링 몫이다. 같은 실행을 밖에서 `Win32_Process` 폴링으로 센 값(219 → 41)은 짧게 사는 `wsl.exe`를 놓쳐 하한이다.
- checkpoint·종료 확인의 신선도는 그대로다. 항상 자기 경계 이후 시작된 run을 쓴다. checkpoint 한 번의 스캔은 distribution당 3회에서 1회로 준다.
- 표시 폴링은 최대 3초(실행 중 run이면 그 실행 시간까지) 늦은 guest 관측을 볼 수 있다. 새 에이전트의 turn·훅·기록 표시, `/new` 같은 대화 전환 반영이 그만큼 늦을 수 있고, 그동안은 기존 title/휴리스틱이 메운다. 훅 상태의 재검증은 창 안에서는 WSL 게스트 스캔과 Codex 진단을 다시 읽지 않으므로, WSL Codex의 대화 전환은 다음 창의 관측에서 잡힌다.
- 고장 난 guest를 폴링이 창마다 한 번만 묻는다. 이전에는 폴링마다 시간 초과 실행이 겹쳤다.
- Codex 묶음은 시간 제한을 공유한다. 느린 pane 하나가 같은 묶음의 최대 3개 pane을 함께 실패시킬 수 있다. 이전에는 느린 pane만 실패했다. 한 distribution의 pane은 대개 같은 `logs_*.sqlite`를 읽어 실제로 함께 느려진다.
- run마다 짧은 스레드 하나가 생긴다. 완료된 stdout은 창이 지나면 다음 요청에서 버린다.
- 테스트: run 테이블(single-flight, 재사용 창, 경계, catalog, deadline, 실패·panic 공유, 늦게 끝난 오래된 run), provider 공유(세 provider·distribution 동시 요청·수명주기 변경·deadline), Codex 묶음(묶음 크기·pane별 실패·형식 오류·만료), Linux에서 실제 게스트 셸 프레이밍, receipt 증거 계약, 상수 경계. 폴링 재현은 `live_wsl_load_tests`(ignored)다.
- 문서: data-flow.md §9·§13.4·§13.5, api-contracts.md 세션 귀속 계약과 §14, AGENTS.md 작업 규칙.
- 재검토 조건: 묶음이 시간 초과로 실패할 때, 이 변경 뒤 liveness 실행이 주된 비용이 될 때, 새 호출자가 다른 신선도를 요구할 때, WSL이 게스트 프로세스를 더 싸게 읽는 API를 낼 때.
