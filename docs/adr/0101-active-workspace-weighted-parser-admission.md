# 0101. parser admission 의 starvation floor 는 우선순위 등급별이며 활성 워크스페이스가 지분을 지배한다

- Status: Proposed
- Date: 2026-07-31
- Source: 사용자 요구(issue #686: 렌더 round robin 에서 활성 워크스페이스 우선순위를 높여 달라 — "현재는 그냥 공평하게 배분됨") · [ADR-0098](0098-terminal-parser-weighted-starvation-free-admission.md) · [ADR-0092](0092-app-wide-terminal-write-round-robin.md) · [architecture/data-flow.md §8.8](../architecture/data-flow.md)
- Amends: [ADR-0098](0098-terminal-parser-weighted-starvation-free-admission.md) Decision 3 의 4:2:1 가중치와 Decision 4 의 등급 무관 `K=8` age promotion 을 16:8:1 가중치와 등급별 promotion bound 로 정정한다. Decision 11 의 성능 acceptance 구성, Decision 7 의 quantum, Decision 5·6·8·9·10 의 lossless·lease·watchdog 계약은 그대로 유지한다.

## Context

ADR-0098 은 pane owner 선택을 smooth weighted round-robin 으로 정하고(focused 4, visible unfocused 2, hidden 1) 어떤 owner 도 굶지 않도록 "다른 owner 에게 `K=8` turn 을 양보하면 age-promote" 라는 floor 를 두었다. floor 의 bound `K + P - 1` 은 등급과 무관한 단일 상수였다.

이 두 규칙은 pane 수가 늘면 서로 충돌한다. 가중 서비스 간격은 owner 마다 `총가중치 / 자기가중치` turn 인데, hidden pane 이 여러 개면 hidden 의 가중 간격이 곧 `K` 를 넘어선다. 그러면 hidden owner 들이 매 `K` turn 마다 전원 overdue 가 되고, urgent 경로는 balance 를 보지 않고 pending FIFO 순서로 하나씩 뽑기 때문에 turn 대부분이 floor 로 소비된다. 가중치는 사실상 무력화되고 배분이 균등 round-robin 으로 되돌아간다.

결정적 scheduler 측정으로 확인한 수치다. 계속 backlog 를 가진 hidden pane 8개와 focused pane 1개를 두고 12 turn(= 옛 총가중치 4+8)을 돌리면 focused 는 가중치가 요구하는 4회가 아니라 2회만 서비스됐다. 균등 배분값 12/9 ≈ 1.33회 와 거의 같다. 사용자가 보고한 "활성 워크스페이스가 더 갱신되지 않는다" 는 이 무력화의 관측면이다.

또한 laymux 는 비활성 workspace 의 pane 을 `display:none` 으로 유지한다(`WorkspaceArea`). 즉 ADR-0098 의 hidden 등급이 곧 "비활성 workspace" 이고, focused/unfocused 구분은 활성 workspace **내부**의 구분이다. 활성 workspace 우선순위를 올리는 축은 focus 축이 아니라 visible↔hidden 축이다. 기존 8:4:2:1 대비 visible:hidden 이 2:1 뿐이었던 것이 두 번째 원인이다.

제약은 ADR-0098 그대로다. hidden 도 drop·pause 없이 유한하게 전진해야 하고(parsed ACK 지연과 PTY backpressure 로 전달), active write 를 선점하거나 lease 를 조기 반환할 수 없으며, rendererless checkpoint 의 3초 catch-up 과 receipt 5초 deadline 에 여유가 남아야 한다. 범위는 desktop `TerminalWriteFairScheduler` 의 owner 선택 정책뿐이다. quantum, lane 교대, envelope/ACK 계약, Remote browser scheduling, 사용자 노출 설정은 비목표다.

## Decision

**parser admission 의 가중치는 focused 16 · visible unfocused 8 · hidden 1 이고, age promotion bound 는 등급별 상수(visible 8 turn, hidden 32 turn)다. 즉 활성 워크스페이스가 지분을 지배하고, floor 는 지분이 아니라 굶주림 방지선으로만 작동한다.**

1. 가중치는 `focused: 16`, `foreground: 8`, `background: 1` 이다. 등급 판정 입력은 ADR-0098 Decision 3 그대로다 — container 가 `display:none` 또는 0 px 이면 focus 보다 먼저 hidden 으로 판정하고, dequeue 시점의 최신 committed visibility/focus ref 를 읽으며, 사용자 설정이나 OS lock/minimize 는 입력이 아니다. focused:foreground 비 2:1 은 유지하고 visible:hidden 비만 2:1 에서 8:1 로 넓힌다. 비활성 workspace 는 hidden 으로 판정되므로 이 비가 곧 활성 워크스페이스 우선순위다.
2. age promotion bound 는 등급별 상수다. `focused`·`foreground` 는 8 turn, `background` 는 32 turn 을 다른 owner 에게 양보하면 overdue 가 된다. bound 는 owner 의 **현재** 등급으로 판정하므로 workspace/focus 전환은 다음 dequeue 부터 새 bound 를 따른다. 등급 판정 실패는 ADR-0098 대로 background 로 fail-safe 하며 그 owner 는 hidden bound 를 받는다.
3. overdue owner 의 선택 규칙은 바꾸지 않는다. pending FIFO 순서로 하나를 고르고 그 owner 의 balance 를 0 으로 되돌린다(빚도 credit 도 남기지 않는다). 새 arrival 은 overdue owner 를 앞지르지 않는다. skipped turn 카운터는 등급 bound 중 가장 큰 값에서 포화한다.
4. 따라서 continuously pending owner 의 최대 대기 `B` 는 `K_등급 + P - 1` 개의 다른 completed turn 이다. hidden 은 `31 + P`, visible 은 `7 + P` 다. 두 lane 이 모두 saturated 인 lane 의 보수적 최대 대기 `2B + 1` 규칙도 그대로 각 등급의 `B` 로 계산한다.
5. hidden bound 32 는 "현실적 pane 수에서는 floor 가 가중치보다 먼저 발동하지 않는다" 를 불변식으로 삼아 고른 값이다. focused pane 1개와 hidden pane N개가 모두 backlog 를 가지면 hidden 의 가중 서비스 간격은 `16 + N` turn 이므로 N ≤ 16 까지는 floor 가 발동하지 않고 가중치가 배분을 결정한다. N 이 더 크면 floor 가 다시 지분을 평탄화하지만 그 열화는 bound 안이며, 어떤 pane 수에서도 hidden 의 서비스 간격은 `31 + P` turn 을 넘지 않는다.
6. floor 는 여전히 pause 나 presentation drop 이 아니다. hidden 의 두 parser 와 parsed ACK 는 계속 전진하고 부족한 처리량은 ADR-0097 대로 PTY backpressure 로 전달한다. congestion 을 reset/replay/replacement attach/fail-stop 사유로 승격하지 않는다.
7. 가중치·bound 는 내부 상수이며 설정으로 노출하지 않는다. 두 값은 한 곳(`terminal-write-fair-scheduler.ts`)에서만 정의하고 결정적 테스트가 등급별 지분과 등급별 bound 를 각각 고정한다.

## Alternatives Considered

- **가중치만 넓힌다(16:8:1, `K=8` 유지).** 같은 결정적 fixture 에서 focused 는 24 turn 중 16회가 아니라 6회만 서비스됐다. hidden 이 8개면 `K=8` floor 가 여전히 매 turn 을 지배하므로 가중치 조정만으로는 issue #686 이 해결되지 않는다. 이 관측이 등급별 bound 를 필수로 만들었다.
- **bound 만 등급별로 한다(4:2:1 유지).** floor 무력화는 사라지지만 visible:hidden 이 2:1 이라 hidden flood pane 이 여러 개면 활성 워크스페이스 지분이 여전히 소수다(예: hidden 8개에서 focused 4/12). 사용자가 요구한 "더 갱신" 폭이 나오지 않는다.
- **hidden bound 를 pane 수 `P` 에 비례해 계산한다.** floor 가 가중 간격을 항상 넘도록 자동 조정되지만, floor 가 pane 수에 따라 늘어나 wall-clock 대기 상한이 사라지고 재현 가능한 bound 를 문서화할 수 없다. 등급별 상수로 두고 bound 를 명시하는 쪽을 택했다.
- **hidden 을 promotion 대상에서 제외하거나 strict foreground priority 로 간다.** ADR-0098 이 기각한 대안 그대로다. hidden 의 5초 parsed-progress expiry, ring pressure, reconnect checkpoint stale 을 정상 부하에서 만들 수 있다.
- **overdue owner 에게 가중 빚을 청구해 promotion 남용을 줄인다.** floor 발동 빈도 자체는 등급이 아니라 bound 가 정하므로 무력화를 못 막는다. 게다가 balance 가 무한히 음수로 흘러 등급이 hidden→visible 로 바뀐 pane 이 한동안 굶을 수 있다. balance 0 복귀를 유지한다.
- **가중치를 사용자 설정으로 노출한다.** ADR-0098 과 같은 이유로 기각했다. 재현성이 낮아지고 정확성 acceptance 보다 정책 공간이 먼저 커진다.

## Consequences

- 활성 workspace 의 pane 이 비활성 workspace 의 flood 보다 명확히 자주 parser turn 을 얻는다. hidden 8개 + focused 1개 fixture 에서 focused 는 24 turn 중 16회(옛 정책 12 turn 중 2회 = 균등 배분 수준)를 얻고 각 hidden 은 1회를 얻는다. workspace/focus 전환은 xterm 재생성 없이 다음 dequeue 부터 반영된다.
- hidden pane 의 총 처리량은 경쟁 중에 더 낮아진다. 가시 pane 이 동시에 폭주할 때 hidden drain 과 최종 catch-up 이 옛 정책보다 늦어질 수 있으며, 이는 byte 를 버리지 않고 PTY backpressure 로 나타난다. hidden 만 backlog 를 가지는 구성(ADR-0098 Decision 11 의 background scenario)은 경쟁이 없으므로 catch-up 이 사실상 영향받지 않는다.
- floor 가 늦어졌으므로 hidden 의 최악 서비스 간격은 turn 수로 `31 + P`, wall-clock 으로는 turn 당 최대 64 KiB parse 비용에 비례해 늘어난다. 8 pane 급 구성에서 이 값은 여전히 checkpoint 3초 catch-up 과 receipt 5초 deadline 아래지만, 실측에서 hidden sampled service gap 이 3초에 접근하면 hidden bound 를 먼저 낮추고 quantum·lossless 계약은 건드리지 않는다.
- 결정적 테스트가 (a) 16:8:1 지분, (b) hidden crowd 에서도 focused 가 가중 지분을 유지(issue #686 회귀), (c) hidden 32 turn·visible 8 turn 이라는 등급별 promotion bound, (d) 두 bound 가 동시에 overdue 일 때 visible 이 먼저 promote 됨을 고정한다. 사보타주로 hidden bound 를 8 로 되돌리면 (b) 가 16회→6회로 실패한다.
- ADR-0098 Decision 11 의 dev acceptance 구성(2/4/7/8 hot pane, 150,000 라인, active/background scenario, 3초 catch-up·5초 control/bridge 한계)은 그대로 유효하며 이 변경의 검증도 같은 하네스로 한다. 이 결정은 hidden 지분을 낮추므로 재검토 조건은 "hidden 의 sampled service gap 또는 고정 `writeSeq` target catch-up 이 3초에 도달" 이다.
