# 0101. parser admission 은 pane 가중치가 아니라 클래스 몫으로 나누고 그 몫은 설정값이다

- Status: Proposed
- Date: 2026-07-31
- Source: 사용자 요구(issue #686: 렌더 round robin 에서 활성 워크스페이스 우선순위를 높여 달라 — "현재는 그냥 공평하게 배분됨") · 사용자 지적(pane 100개·workspace 10개 규모에서는 pane 단위 가중치로 활성 workspace 몫을 지킬 수 없다) · [ADR-0098](0098-terminal-parser-weighted-starvation-free-admission.md) · [ADR-0092](0092-app-wide-terminal-write-round-robin.md) · [architecture/data-flow.md §8.8](../architecture/data-flow.md)
- Amends: [ADR-0098](0098-terminal-parser-weighted-starvation-free-admission.md) Decision 3·4 의 pane 단위 4:2:1 가중치와 `K=8` age promotion 을 **클래스 단위 몫 + 클래스 내 round-robin** 으로 대체한다. Decision 4 의 `K + P - 1` bound 는 클래스 몫에서 파생되는 bound 로 대체된다. Alternatives 의 "가중치를 사용자 설정으로 노출한다 → 기각" 판단도 정정한다(설정 노출, Settings UI 는 비목표). Decision 7 의 quantum, Decision 5·6·8·9·10 의 lossless·lease·watchdog 계약, Decision 11 의 acceptance 구성은 유지한다.

## Context

ADR-0098 은 pane owner 하나하나에 가중치를 주고(focused 4, visible 2, hidden 1) smooth weighted round-robin 으로 admission turn 을 나눴다. 이 구조에서 한 pane 의 몫은 `자기 가중치 / 살아 있는 pending pane 가중치 합`이므로 **pane 수에 희석된다.**

세 가지가 실측·분석으로 드러났다.

1. **floor 가 가중치를 먹는다.** 등급 무관 `K=8` age promotion 때문에 hidden flood pane 이 여러 개면 전원이 매 8 turn 마다 overdue 가 되고, promotion 경로는 balance 를 보지 않고 FIFO 로 뽑는다. 결정적 fixture(hidden 8 + focused 1)에서 focused 는 12 turn 중 가중치가 요구하는 4회가 아니라 2회만 서비스됐다 — 균등 배분값 1.33회 와 사실상 같다.
2. **가중치만 넓혀도 부족하다.** 같은 fixture 에서 16:8:1 로 넓히고 `K=8` 을 유지하면 focused 는 24 turn 중 16회가 아니라 6회였다.
3. **pane 단위 가중치는 규모에서 무너진다.** 사용자가 지적한 100 pane·10 workspace(workspace 당 10 pane) 구성에서 16:8:1 을 적용하면 활성 workspace 합계는 약 49%지만 focused pane 자기 몫은 16/178 ≈ 9%다. 게다가 `P ≈ 100` 이면 hidden bound 32 로도 hidden 90개가 131 turn 중 90 turn 을 floor 로 가져가 #686 의 무력화가 규모만 키워 재발한다.

세 번째가 결정적이다. "활성 워크스페이스를 더 갱신한다" 는 요구는 pane 개수와 무관한 성질이어야 하는데, pane 단위 가중치로는 그 성질을 표현할 수 없다. 비활성 workspace 의 pane 은 `WorkspaceArea` 가 `display:none` 으로 유지하므로 hidden 등급이 곧 비활성 workspace 이고, 지켜야 할 몫은 pane 이 아니라 **클래스**(focused / 활성 workspace 의 나머지 visible / hidden)의 몫이다.

제약은 ADR-0098 그대로다. hidden 도 drop·pause 없이 유한하게 전진해야 하고(부족한 처리량은 parsed ACK 지연과 PTY backpressure 로 전달), active write 를 선점하거나 lease 를 조기 반환할 수 없으며, rendererless checkpoint 의 3초 catch-up 과 receipt 5초 deadline 에 여유가 남아야 한다. 범위는 desktop `TerminalWriteFairScheduler` 의 owner 선택 정책과 그 정책값의 설정 경로다. quantum, lane 교대, envelope/ACK 계약, Remote browser scheduling, Settings UI 는 비목표다.

## Decision

**admission turn 은 먼저 우선순위 클래스에게 그 클래스의 몫만큼 배분하고, 그 다음 클래스 안에서 대기 순서 round-robin 으로 pane 을 고른다. 클래스 몫은 `settings.json` 의 `terminal.parserAdmission` 이며 기본값은 focused 5 · visible 3 · hidden 2 다.**

1. **2단 배분.** 1단은 클래스 선택이다. pending pane 이 하나라도 있는 클래스만 cycle 에 참여하고, 그 클래스들의 몫으로 smooth weighted round-robin 을 돌린다. 2단은 선택된 클래스 안에서 가장 오래 기다린 pane(pending FIFO 선두)을 고르고, 서비스된 pane 은 다시 대기열 꼬리로 간다. 따라서 클래스 몫은 pane 수와 무관하고, pane 수는 그 클래스 **안에서만** 몫을 나눈다.
2. **클래스 판정 입력은 ADR-0098 Decision 3 그대로다.** container 가 `display:none` 또는 0 px 이면 focus 표시보다 우선해 hidden 으로 판정하고, 값은 request 시점에 동결하지 않고 dequeue 시점의 최신 committed visibility/focus ref 에서 읽는다. resolver 실패는 hidden 으로 fail-safe 하며 admission 을 멈추지 않는다. 클래스가 바뀐 pane 은 다음 dequeue 부터 새 클래스의 대기열에서 자기 차례를 받는다.
3. **몫은 설정값이다.** `terminal.parserAdmission.{focusedShare,visibleShare,hiddenShare}` 는 상대값이고 합이 한 cycle 이다. 유효 범위는 `1..=1000` 이며 `0` 은 그 클래스의 parser 를 멈추는 뜻이므로 허용하지 않는다. Rust `ParserAdmissionSettings::sanitized()` 와 프론트엔드 `sanitizeTerminalWriteClassShare()` 가 같은 범위로 clamp 하고 누락·비수치 항목은 기본값으로 되돌리므로, 잘못된 파일이 admission 을 멈추게 할 수 없다. `validate_settings` 는 범위 위반을 `/terminal/parserAdmission/<field>` 로 보고한다. 기본값·범위 상수는 Rust `constants.rs` 와 `terminal-write-fair-scheduler.ts` 에 각각 한 곳만 둔다.
4. **Settings UI 는 만들지 않는다.** 이 값은 정책 튜닝 knob 이며 settings.json 직접 편집 경로만 지원한다. ADR-0098 은 "재현성이 낮아진다" 는 이유로 노출 자체를 기각했지만, 실측 결과 적정 비율이 pane 구성과 사용 습관에 따라 달라진다는 것이 확인됐으므로 기본값은 코드가 고정하고 조정 여지는 파일로 남긴다.
5. **적용 시점.** 몫 변경은 다음 dequeue 부터 반영한다. 이미 active 인 write 를 선점하지 않고 materialized batch·envelope identity·sequence·callback 을 바꾸지 않으며 xterm 을 재생성하지 않는다. 이전 몫으로 계산된 클래스 balance 는 폐기해 새 비율로 다음 cycle 을 시작한다. 앱 전체가 drain 되면 balance 를 비워 다음 burst 가 균등한 cycle 에서 시작한다.
6. **starvation floor 는 클래스 몫에서 파생된다.** pane 단위 절대 turn bound(age promotion)는 제거한다 — 그것이 위 Context 1·3 의 원인이다. 모든 클래스 몫이 양수이므로 각 클래스는 `cycle / 자기 몫` turn 마다 한 turn 을 받고, 클래스 안에서는 round-robin 이므로 pane 은 자기 클래스 구성원 수만큼의 자기 클래스 turn 안에 반드시 서비스된다. 즉 pending pane 의 최대 대기는 `ceil(cycle / 자기 클래스 몫) × 자기 클래스 pane 수` turn 이며, 기본값에서 hidden pane N개면 `5N` turn 이다. wall-clock 상한은 이 bound 가 아니라 ADR-0098 의 3초 checkpoint catch-up·5초 parsed-progress 계약으로 검증한다.
7. **hidden 은 pause 가 아니다.** hidden 몫 20% 는 pane 수가 늘어도 사라지지 않고 N 등분된다. hidden 의 두 parser 와 parsed ACK 는 계속 전진하고 부족한 처리량은 ADR-0097 대로 PTY backpressure 로 전달한다. congestion 을 reset/replay/replacement attach/fail-stop 사유로 승격하거나 visible parse 전에 ACK 하지 않는다.

## Alternatives Considered

- **pane 단위 가중치를 넓히고 floor 만 등급별로 둔다(16:8:1, hidden bound 32).** 8 pane 급에서는 실제로 동작했고(활성 pane 지분 10.7% → 25~28% 실측) 이 PR 의 첫 구현이었다. 그러나 몫이 pane 수에 희석되는 성질이 남아 100 pane 급에서 활성 workspace 몫을 지키지 못하고, hidden 이 많아지면 floor 가 다시 지배한다. 규모 무관 성질을 원한 요구를 충족하지 못해 클래스 몫으로 대체했다.
- **pane 단위 가중치 + pane 수에 비례하는 hidden bound.** floor 가 가중 간격을 항상 넘도록 자동 조정되지만 wall-clock 대기 상한이 pane 수에 따라 무한히 늘어나고 문서화 가능한 bound 가 사라진다.
- **strict foreground priority 또는 hidden parser pause.** ADR-0098 이 기각한 대안 그대로다. hidden 의 5초 parsed-progress expiry, ring pressure, reconnect checkpoint stale 을 정상 부하에서 만들 수 있다.
- **클래스 몫을 pane 수로 다시 나눠 "pane 당 몫" 으로 환산한다.** pane 단위 가중치와 수학적으로 같아지므로 같은 희석 문제로 되돌아간다.
- **몫을 자동 튜닝한다(부하·backlog 기반 적응).** 재현성이 떨어지고 acceptance 를 고정할 수 없다. 고정 기본값 + 설정 override 로 둔다.
- **클래스를 더 쪼갠다(workspace 별, pane group 별).** 정책 공간이 커지고 상태가 늘어난다. 요구는 활성 workspace 대 나머지의 구분이므로 세 클래스로 충분하다.

## Consequences

- 활성 workspace 몫이 pane 수와 무관해진다. hidden pane 이 2개든 40개든 focused 클래스는 자기 몫을 그대로 받고, hidden 몫은 hidden pane 들이 N 등분한다. hidden pane 이 많아질수록 개별 hidden 이 느려지는 것은 의도한 방향이다.
- pane 단위 balance·skip 카운터가 사라지고 상태는 클래스 balance 3개와 pending FIFO 로 줄었다. 클래스 안의 fairness 는 가중치가 아니라 순수 round-robin 이므로, 같은 클래스 pane 들 사이에는 장기 지분 보정이 없다(같은 클래스는 동등 대우한다).
- hidden 처리량은 경쟁 중 낮아진다. 실측: 활성 pane 과 hidden 8 pane 이 동시에 폭주할 때 활성 pane 의 parsed 지분은 pane 가중치(4:2:1·`K=8`) 정책의 10.7%(활성:hidden 비 0.96 = 균등 배분)에서 클래스 몫 정책으로 크게 올라가고, hidden 은 그만큼 늦어진다. byte 는 버리지 않고 PTY backpressure 로 나타난다.
- 설정값이 생겼으므로 성능 회귀 보고에는 `terminal.parserAdmission` 값이 함께 필요하다. acceptance·벤치는 기본값에서 수행한다.
- 결정적 테스트가 (a) 한 cycle 의 클래스 배분, (b) hidden pane 2/8/40 에서 활성 몫 불변(issue #686 회귀), (c) 클래스 안 round-robin 순서, (d) focused pane 을 늘려도 hidden 몫이 줄지 않음, (e) idle 클래스의 몫이 backlog 클래스로 넘어감, (f) 클래스 몫 starvation bound 안에서 모든 hidden pane 서비스, (g) 설정값 채택과 clamp, (h) 설정 변경 구독을 고정한다.
- ADR-0098 Decision 11 하네스(`terminal_output_661.py`, `background`, 150,000 라인)는 그대로 acceptance 다. 재검토 조건은 "hidden 의 sampled service gap 또는 고정 `writeSeq` target catch-up 이 screenshot capture 정지와 무관하게 3초에 도달" 이다. 이 환경에서 `screenshotSucceeded` 는 정책과 무관하게 이미 실패하며(dev debug 빌드 html2canvas capture 3.3~3.9 s > 3 s) 별도 이슈(#700)로 분리했다.
