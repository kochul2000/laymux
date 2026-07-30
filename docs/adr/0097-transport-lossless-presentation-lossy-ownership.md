# 0097. terminal output은 transport lossless·presentation lossy 계층 계약으로 분리한다

- Status: Proposed
- Date: 2026-07-30
- Source: 사용자 지시(2026-07-30, Codex 대량 출력 처리 원칙) · xterm.js 공식 flow-control 가이드(고속 producer는 caller가 high/low watermark와 write callback으로 PTY까지 backpressure를 전달해야 함) · [ADR-0072](0072-terminal-output-gap-sequence-exact-repair.md) · [ADR-0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md) · [ADR-0084](0084-desktop-terminal-output-parsed-credit.md) · [ADR-0086](0086-terminal-output-control-epoch-watchdog.md) · [ADR-0087](0087-mutex-poison-fail-closed-discard-only.md) · [ADR-0088](0088-pty-output-fatal-generation-teardown.md) · [ADR-0092](0092-app-wide-terminal-write-round-robin.md) · [ADR-0094](0094-terminal-output-control-capacity-admission.md) · [ADR-0095](0095-terminal-output-bounded-envelope-and-frame-continuation.md)
- Aligns: 위 ADR들이 개별 결함(#624, #659, #661, #670 등)마다 정한 credit·envelope·admission·fail-stop 결정을 하나의 계층 원칙으로 고정한다. 개별 ADR의 수치·프로토콜·소유권 결정은 수정하지 않는다.

## Context

Codex 같은 고속 producer가 대량 출력을 쏟아낼 때마다 "터미널이 감당 못 하는 게 당연하다"는 판단이 반복 제안되었다. 그 판단은 세 가지 형태로 나타난다 — alt buffer에 진입했으니 이전 raw output을 버려도 된다, renderer가 밀리니 미파싱 바이트를 폐기해도 된다, queue가 가득 찼으니 치명적 오류로 세션을 내려도 된다. 세 판단 모두 과거 결함(#624 xterm discard, #659 pane 오염, #661 ingress 과부하, #670 frame 교착)의 직접 원인이거나 잘못된 복구를 유발했다.

xterm.js 공식 flow-control 안내도 같은 방향이다: 빠른 producer는 xterm을 무응답 상태로 만들 수 있으므로, caller(embedder)가 high/low watermark와 write callback을 이용해 PTY까지 backpressure를 전달할 책임이 있다. 즉 "출력이 너무 많다"는 라이브러리가 해결해 줄 문제가 아니라 터미널 host가 bounded하고 responsive하게 흡수해야 하는 문제다.

ADR-0072/0080/0084/0086/0088/0094/0095가 각 결함의 국소 결정을 이미 고정했지만, 결정들을 관통하는 계층 원칙 — 어느 계층이 lossless여야 하고 어느 계층이 lossy여도 되는가, 무엇이 backpressure이고 무엇이 fail-stop인가, xterm.js와 host의 책임 경계는 어디인가 — 는 명문화된 곳이 없었다. 새 결함마다 같은 논쟁이 재발하므로 원칙 자체를 ADR로 고정한다.

이 ADR은 새 프로토콜이나 수치를 도입하지 않는다. Remote 계약, ADR-0092의 scheduler, ADR-0095의 envelope/credit 수치는 그대로다.

## Decision

**terminal output 경로를 transport / parse / presentation 세 계층으로 나누고, transport와 parse는 lossless, presentation만 lossy를 허용한다. 정상 과부하는 backpressure로 흡수하고 fail-stop은 계약 손상 4가지 사유로만 제한한다.**

### 계층 계약

1. **Transport (PTY read → retained ring → delivery → parser 진입).** generation 안에서 ordered, lossless, bounded다. 미파싱·미ACK prefix는 어떤 이유로도 폐기하지 않는다. 용량이 소진되면 폐기 대신 producer에 backpressure를 전달한다 — PTY master read를 멈춰 OS pipe와 자식 프로세스까지 유한하게 밀어낸다.
2. **VT parse.** parser는 normal/alternate buffer 상태 및 synchronized-output(DECSET 2026) 여부와 무관하게 모든 바이트를 순서대로 적용한다. 화면 모드가 바뀌었다는 사실은 바이트를 건너뛸 근거가 아니다.
3. **Presentation.** lossy할 수 있다. 같은 animation frame 전에 여러 parser state가 완성되면 중간 paint를 생략하고 최신 state만 렌더링한다. DECSET 2026 내부에서는 paint를 보류하고 close 후 최신 state를 렌더링한다. 생략되는 것은 화면 갱신뿐이며 parser state·scrollback·checkpoint는 모든 바이트를 반영한다.

### alt buffer와 snapshot 폐기

alt buffer 진입 자체는 raw output 폐기의 근거가 아니다. superseded snapshot을 폐기할 수 있는 것은 명시적인 application keyframe 계약이 있을 때뿐이다 — 예: ADR-0076/0078의 인프레임 커서 주차처럼 애플리케이션이 프레임 경계를 스스로 선언하는 경우. 그 계약이 없으면 이전 출력은 scrollback/ring의 lossless 계약을 따른다.

### backpressure vs fail-stop

- 정상 queue 충만, ACK 지연, renderer 과부하는 **backpressure**다. 치명적 상태가 아니며 폐기·reset·replay·세션 종료의 근거가 아니다. 대기는 항상 유한해야 한다(ADR-0086/0095의 watchdog·expiry).
- **fail-stop** 사유는 다음 4가지 계약 손상뿐이다: sequence gap(정확 repair 불가), identity 충돌(같은 identity 다른 payload), authoritative ring/ledger 손상, 유한 timeout 만료. 이때도 복구는 reset/replay가 아니라 typed fail-stop과 명시적 close/recreate다(ADR-0088/0095).
- 정상 과부하를 계약 손상으로 승격하는 것, 계약 손상을 정상 과부하로 강등해 계속 진행하는 것 모두 금지한다.

### 소유권 경계

xterm.js가 소유하는 책임:

- VT sequence parsing
- normal/alternate buffer 상태
- cursor와 terminal mode 상태
- DECSET 2026 중 dirty-range 병합
- renderer 실행
- parse completion callback

laymux 같은 terminal host가 소유하는 책임:

- PTY read의 pause/resume
- transport queue와 ring capacity
- ACK/credit와 backpressure
- 여러 pane 사이 공정성
- WebView main-thread starvation 방지
- unparsed byte를 덮어쓰지 않는 retention
- 정상 과부하와 실제 계약 손상 구분
- paint·checkpoint·telemetry의 critical-path 분리

host 책임을 xterm.js에 기대하거나(예: "xterm이 알아서 flow control 해야 한다"), xterm 책임을 host가 재구현하는(예: host가 VT 의미를 해석해 선별 전달) 설계는 이 경계 위반이다.

## Alternatives Considered

- **"producer가 너무 많이 출력하면 유실은 불가피" — 과부하 시 raw output 폐기.** xterm.js 공식 가이드가 명시적으로 반박하는 방향이다. flow control 부재는 embedder 결함이지 라이브러리·producer 한계가 아니다. #624/#661의 원인 재생산이므로 기각한다.
- **alt buffer 진입 시 이전 출력 폐기.** TUI 앱 종료 후 normal buffer 복원, scrollback 조회, exact repair가 모두 깨진다. keyframe 계약 없는 폐기는 기각한다.
- **presentation도 lossless — 모든 parser state를 paint.** 고속 출력에서 paint가 병목이 되어 main thread starvation과 입력 지연을 만든다. 화면은 최신 state만 보이면 충분하므로 기각한다.
- **backpressure를 fail-stop으로 취급.** 정상 부하에서 세션이 죽어 가용성이 무너진다. 유한 대기와 watchdog으로 충분하므로 기각한다.
- **계층 원칙을 각 ADR에 흩어둔 채 유지.** 새 결함마다 같은 논쟁("이번엔 버려도 되지 않나")이 재발했다. 원칙을 단일 정본으로 고정하는 쪽을 선택한다.

## Consequences

- 이후 output 경로 설계 리뷰는 "어느 계층의 결정인가"부터 판정한다. transport/parse 계층에서 폐기를 제안하는 변경은 이 ADR과 충돌하므로 새 ADR로 번복하지 않는 한 기각된다.
- 고속 producer 아래에서 shell/자식 프로세스가 PTY pipe에서 느려지는 것은 의도된 동작이다. "Codex가 느려졌다"는 보고는 결함이 아니라 backpressure 작동 증거일 수 있으며, 진단은 폐기 여부가 아니라 대기의 유한성을 본다.
- presentation 생략(중간 paint skip, DECSET 2026 보류)은 화면 기준 테스트에서 최종 state만 검증 대상임을 의미한다. 중간 프레임 검증이 필요하면 parser state/checkpoint 계층에서 한다(ADR-0074).
- fail-stop 사유 4가지는 닫힌 목록이다. 새 사유가 필요하면 이 ADR을 확장하는 새 ADR이 필요하다.
- 재검토 조건: xterm.js가 자체 bounded flow control을 네이티브로 제공하거나, WebView transport가 ordered lossless stream을 플랫폼 차원에서 보장하는 경우.
