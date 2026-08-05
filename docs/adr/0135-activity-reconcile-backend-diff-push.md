# 0135. Activity 는 백엔드가 주기적으로 재판정해 변경분만 push 한다

- Status: Accepted
- Date: 2026-08-04
- Source: issue #767, ADR-0009 (확장), ADR-0134 (관측 게이팅 조항 정정), architecture/data-flow.md §8 · §9

## Context

activity 표시는 전부 이벤트 구동이다. PTY 콜백이 OSC 0/2 타이틀마다 판정을 내고 프론트에 push 하며, 프론트 스토어는 그 이벤트로만 갱신된다. 여기에 두 가지 구조적 누락이 있다.

1. **백엔드는 타이틀이 올 때만 말할 수 있다.** 프롬프트에 멈춘 인터랙티브 앱은 더 이상 타이틀을 내지 않는다. 그 시점의 판정이 틀렸으면 사용자가 뭔가 입력할 때까지 계속 틀린 상태로 남는다.
2. **프론트에는 되돌릴 경로가 없다.** 유일한 동기화는 마운트 시 `get_terminal_states` 1회(ADR-0009)이고, 그마저도 `activity` 가 아직 설정되지 않은 인스턴스에만 적용한다. 한 번 `shell` 로 찍히면 영구히 덮이지 않는다.

백엔드의 자가치유(grace window 만료, lazy 캐시 무효화)는 전부 false-positive 전용이다. 살아있는 앱을 놓친 false-negative 를 되돌리는 경로는 없었다.

실측(#766 조사): WSL pane 11 개가 `shell` 로 오보고되고 있었고, 그중 idle Claude/Codex pane 들은 백엔드를 고친 뒤에도 다음 타이틀 이벤트가 없어 프론트에서 `shell` 로 굳은 채였다.

작용하는 force:

- 백엔드 판정은 authoritative ring 과 프로세스/게스트 liveness 에서 나온다 — 즉 재판정은 **언제든** 이벤트와 같은 신선도로 가능하다. 없는 것은 그 재판정을 정기적으로 돌리고 알릴 주체였다.
- 재판정 sweep 은 터미널마다 16KB 스캔 + 락 획득이고, WSL pane 이 있으면 게스트 왕복(~300ms)까지 딸린다. 무한정 촘촘하게 돌릴 수 없다.
- ADR-0009 가 마운트 스냅샷에 "덮어쓰지 않는다"를 넣은 이유는 실재한다: 왕복 중 도착한 최신 라이브 이벤트를 오래된 pull 결과가 덮는 리로드 레이스.

비목표: activityMessage·outputActive 등 다른 원시 상태. 이 ADR 은 `activity`(type/name) 한 필드만 다룬다.

## Decision

**백엔드가 주기적으로 전 터미널 activity 를 재판정하고, 직전에 발행한 값과 달라진 pane 만 이벤트로 push 한다.** 프론트는 그 이벤트를 라이브 이벤트와 동일하게, 양방향으로 적용한다.

1. **pull 이 아니라 diff push 다.** 프론트가 주기적으로 조회하는 방식은 ADR-0009 가 막아둔 리로드 레이스를 되살린다("내 값이 더 신선한가?"를 프론트가 판단해야 한다). 백엔드가 발행하면 이벤트 순서가 곧 진실 순서이므로 그 판단이 아예 필요 없다.

2. **변경분만 보낸다.** 재판정 결과 전체를 매번 보내면 21 pane 짜리 워크스페이스에서 조용한 순간에도 매 패스 21건이 흐른다. 직전 발행 값과 다른 pane 만 payload 에 담는다.

3. **적용은 양방향이다.** reconcile 은 `interactiveApp → shell` 강등도 그대로 적용한다. 그것이 #767 의 핵심이다 — 이벤트 경로가 남긴 stale 분류를 고칠 수 있어야 한다. 대신 프론트가 모르는 terminal_id 는 무시한다(이미 제거된 pane 을 되살리지 않는다).

4. **cadence 는 고정 3초다.** 적응형 backoff 를 검토했지만 성립하지 않는다 — 이 워커가 게스트 스냅샷을 갱신하고, 게스트 **부정**은 `WSL_LIVENESS_AUTHORITATIVE_MAX_AGE`(8초) 동안만 권위를 갖는다. cadence 가 그 창을 넘기면 패스 사이에 부정이 `Unknown` 으로 강등되고, 판정이 타이틀/버퍼 휴리스틱으로 되돌아가 16KB 창에 남은 배너가 종료된 앱을 다시 pin 할 수 있다(PR #292 가 막은 회귀). 프로브 자체가 타임아웃(3초)까지 쓸 수 있으므로 예산에 포함해 `cadence + probe timeout ≤ 음성 창` 을 불변식으로 고정한다. 결과적으로 backoff 상한이 3~5초 근방으로 눌리므로 적응형의 이득이 없다.

4-1. **주기적으로 전체를 다시 발행한다.** diff 는 **백엔드 쪽** 변화만 본다. 프론트가 자기 경로로 값을 되돌리면(예: 타이틀 상태머신의 `interactiveAppExited` 는 핸들러 보존 가드를 하드 오버라이드해 `shell` 로 만든다) 그 뒤로 백엔드 변화가 없으므로 diff 는 영구히 침묵한다. 그래서 `ACTIVITY_RECONCILE_FULL_RESYNC_INTERVAL`(60초)마다 발행 기록을 비우고 전량 재발행해, 원인이 무엇이든 drift 가 그 창 안에 수렴하게 한다. 프론트가 동일한 값은 건너뛰므로 일치 상태의 재발행은 스토어를 건드리지 않는다.

4-2. **WSL pane 의 종료는 게스트 프로브가 소유한다** — [ADR-0134](0134-wsl-guest-interactive-app-liveness.md) Decision 3-1(종료 판정에 캐시 양성 사용 금지)을 **대체한다**. 3-1 의 근거는 "잘못된 억제를 되돌릴 reconcile 경로가 없다(#767)" 였고, 이 ADR 이 그 경로다. 그 결과 WSL pane 에서는:

   - 살아있는 에이전트에 대한 타이틀 유래 종료가 억제된다 — 억제가 없으면 프론트가 `shell` 로 하드 오버라이드하고, 백엔드는 여전히 `Claude` 라 diff 가 침묵해 영구 불일치가 된다.
   - 억제가 틀렸다면(정말 종료한 경우) 다음 프로브가 부재를 확인하고 reconcile 이 `shell` 을 발행한다. 지연 상한은 reconcile cadence.

   즉 표시·종료 판정이 같은 게스트 판정을 읽고, 타이틀 상태머신은 WSL pane 의 종료를 단정하지 않는다.

   **소유한다는 것은 전이 전체를 실행한다는 뜻이다.** activity 만 바꾸고 끝내면 PTY 콜백의 종료 분기가 하던 나머지가 남는다 — 마지막 상태 메시지가 pane 에 그대로 붙어 있고, grace window 엔트리가 살아 있어 감지가 여전히 그 앱을 부를 수 있으며, exit marker 가 없어 16KB 창의 배너가 다음 타이틀 한 번에 앱을 다시 pin 한다. 그래서 reconcile 은 `InteractiveApp{app}` → 그 앱이 아닌 상태로 바뀐 pane 마다 `claude_was_working`·`claude_last_working_title`·`claude_message` 를 정리하고, exit marker 를 기록하고, grace window 를 지우고, 메시지가 있었다면 그 소거를 프론트에 발행한다. 에이전트 간 handover(Claude→Codex)도 첫 앱의 종료로 취급한다. pane 자체가 사라진 경우는 제외한다 — 세션 teardown 이 같은 정리를 이미 한다.

5. **이 워커가 WSL 게스트 프로브의 유일한 주체다** — [ADR-0134](0134-wsl-guest-interactive-app-liveness.md) 의 "관측되지 않는 동안에는 경계를 넘지 않는다"(Decision 5)를 **정정한다**. reconcile 은 관측 여부와 무관하게 돌아야 하므로 관측 게이팅은 성립하지 않는다. 대신 별도 refresher 스레드를 없애고 reconcile 패스가 매번 `wsl_liveness::refresh()` 를 호출한다 — 프로브 주기 = reconcile 주기, 조율 지점 하나. cadence 가 게스트 freshness 창에 묶이는 이유가 여기에 있다(4번).

6. **실패한 패스는 아무것도 발행하지 않는다.** 감지가 에러(poisoned ring/registry)면 그 패스를 버리고 직전 발행 뷰를 유지한다 — 오류를 "전부 shell" 로 번역하지 않는다. emit 실패도 마찬가지로 발행 기록에서 되돌려, 다음 패스가 다시 시도한다.

## Alternatives Considered

- **프론트 주기 폴링(`get_terminal_states`) + 덮어쓰기 허용.** 백엔드 변경이 거의 없다. 기각: ADR-0009 의 리로드 레이스가 그대로 돌아오고, 신선도 판정 책임이 프론트로 넘어간다.
- **마운트 스냅샷의 `!inst.activity` 조건만 제거.** 한 줄이다. 기각: 마운트 1회라는 성질이 그대로라 idle pane 의 누락은 여전히 영구적이다. 레이스만 새로 생긴다.
- **PTY 콜백에서 더 많은 신호를 잡기(주기적 합성 타이틀 등).** 이벤트 경로를 강화하는 방향. 기각: 타이틀이 없는 상태를 타이틀로 만들 수는 없다. 앱이 조용한 것 자체가 신호원의 부재다.
- **전체 상태를 매 패스 발행.** diff 상태를 들고 있지 않아도 된다. 기각: 조용한 시스템에서 pane 수만큼 이벤트가 매 패스 흐르고, 프론트는 매번 같은 값을 다시 쓴다.
- **ADR-0134 의 관측 게이팅을 유지하고 refresher 를 별도로 두기.** 기각: reconcile 이 매 패스 liveness 를 조회하므로 게이팅은 항상 열린 상태가 된다 — 이름만 게이팅이고 실제로는 프로브 주기가 refresher 간격에 고정된다. 조율 지점이 둘로 갈리는 대가만 남는다.

## Consequences

- 이벤트 경로가 놓친 분류가 한 cadence(3초) 안에 교정된다. idle Claude/Codex pane 이 `shell` 로 굳는 #767 증상이 사라진다. 원인 불명의 프론트 drift 는 전량 재발행 주기(60초)가 상한이다.
- 비용: 3초마다 sweep 1회(터미널당 16KB 스캔) + WSL pane 이 있으면 게스트 왕복 1회(~300ms, 호스트 CPU ~9ms). ADR-0134 의 "아무도 안 보면 0회" 성질은 잃는다 — 앱이 떠 있는 동안은 항상 돈다. 고정 cadence 를 늦추려면 음성 freshness 창을 함께 늘려야 하는데, 그러면 갓 시작한 에이전트가 stale 부정에 막히는 시간이 늘어난다(4번).
- 프론트의 낙관적 분류(사용자가 `claude` 를 입력한 시점의 `detectActivityFromCommand`)와 백엔드가 잠깐 어긋나면 reconcile 이 백엔드 쪽으로 되돌린다. 백엔드는 `mark_claude_terminal` 시드로 같은 창을 커버하므로 실제 어긋남은 앱 기동 구간에 한정된다. 실기에서 flapping 이 관측되면 "직전 로컬 변경 후 N ms 는 강등 보류" 가드를 추가한다.
- 마운트 스냅샷(ADR-0009)은 그대로 남는다. 리로드 직후 첫 reconcile 패스를 기다리지 않고 즉시 복원하는 역할이며, 덮어쓰지 않는 조건도 유지한다 — 덮어쓰기는 이제 push 경로가 담당한다.
- 새 외부 계약: `terminal-activity-reconciled` 이벤트(`[{terminalId, activity}]`). Remote/Automation surface 는 아직 이 이벤트를 구독하지 않는다 — 필요해지면 별도로 다룬다.
- WSL pane 은 ADR-0134 가 포기했던 false-exit 억제를 되찾는다(4-2). 대신 진짜 종료의 인지가 최대 reconcile cadence 만큼 늦어질 수 있다. 표시가 틀린 채 고정되는 것보다 늦게 맞는 쪽이 낫다는 판단이다.
- 전량 재발행(4-1)은 원인을 모르는 drift 까지 덮는 안전망이지만, 원인을 감추기도 한다. 특정 pane 이 매 60초마다 되돌아가는 패턴이 보이면 그건 프론트 쪽 별도 결함의 신호로 읽어야 한다.
- 재검토 조건: sweep 비용이 문제가 되면(pane 수 증가) 변경 가능성이 있는 pane 만 좁혀 재판정한다. cadence 를 늘리는 쪽은 4번의 freshness 불변식과 함께 움직여야 하므로 단독으로는 못 건드린다.
