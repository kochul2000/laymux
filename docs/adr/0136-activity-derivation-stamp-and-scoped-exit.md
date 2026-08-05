# 0136. Activity 는 파생 시점 stamp 로 순서화하고, 종료 정리는 종료한 앱에만 적용한다

- Status: Proposed
- Date: 2026-08-05
- Source: PR #769 리뷰(pullrequestreview-4861206487), [ADR-0135](0135-activity-reconcile-backend-diff-push.md) (Decision 4·4-1·4-2 정정), [ADR-0134](0134-wsl-guest-interactive-app-liveness.md)

## Context

[ADR-0135](0135-activity-reconcile-backend-diff-push.md) 는 activity 를 쓰는 주체를 하나에서 **둘**로 늘렸다. PTY 콜백은 타이틀마다, reconcile 워커는 타이머마다 같은 pane 의 같은 필드를 쓴다. 그 ADR 은 "백엔드가 발행하면 이벤트 순서가 곧 진실 순서"(Decision 1)라는 전제 위에 서 있는데, 두 생산자 체제에서는 그 전제가 성립하지 않는다. 리뷰에서 드러난 네 가지 결함은 전부 같은 뿌리 — **판정을 내린 시점과 그 판정이 도착하는 시점이 다르다는 것을 모델이 표현하지 못한다** — 에서 나온다.

1. **순서 역전.** reconcile 패스는 스냅샷을 뜬 뒤 전 터미널을 돌고 마지막에 emit 한다. 그 사이에 도착한 타이틀은 더 늦게 파생됐지만 더 먼저 프론트에 닿는다. 프론트는 reconcile 을 무조건 적용하므로 오래된 판정이 최신 판정을 덮고, 다음 패스까지 그대로 남는다. 같은 창에서 pane 이 teardown 되고 같은 id 로 재생성되면(Restart View, 프로필 변경) 이전 세션의 판정이 새 세션에 적용된다 — 새 세션은 아직 아무 이벤트도 내지 않았으므로 순서만으로는 막을 수 없다.

2. **freshness 예산이 실제 최악 경로를 세지 않는다.** ADR-0135 Decision 4 의 불변식은 `cadence + 프로브 타임아웃 1회 ≤ 음성 창` 이다. 그러나 `wsl_liveness::refresh()` 는 기본 distro 해석에 먼저 최대 1회분을 쓰고, 그 뒤 distribution 마다 순차로 프로브한다(ADR-0134 5-1). distro 하나만 cache miss 여도 3s + 3s + 3s = 9s 로 8초 음성 창을 넘는다. 게다가 cadence 를 패스 *뒤* 의 sleep 으로 재면 패스 소요가 두 발행 사이 간격에 통째로 더해진다. 테스트는 통과하는데 steady state 에 `NoneAlive → Unknown` 구멍이 남는다.

3. **전량 재발행이 lifecycle 직전 상태를 지운다.** ADR-0135 4-1 은 60초마다 "발행 기록을 비운다"고 했다. 그런데 그 기록은 4-2 가 종료를 판정하는 **유일한 직전 상태**이기도 하다. 앱이 실제로 종료했고 그 사실이 하필 재발행 패스에서 처음 보이면, 비워진 기록 때문에 종료가 검출되지 않는다. 그 뒤에는 기록에 `shell` 이 저장되어 같은 종료를 다시 볼 기회도 없다 — 메시지·grace·exit marker 정리가 영구 누락된다.

4. **종료 정리가 후임 세션까지 지운다.** 4-2 는 handover(Codex→Claude)도 첫 앱의 종료로 취급한다. 그런데 정리는 terminal 단위였다. Codex 종료를 정리하면서 이미 자리를 잡은 새 Claude 의 `claude_was_working`·`claude_message`·grace 엔트리를 지우고 null 메시지 이벤트까지 발행한다. 반대로 정리가 **부족한** 축도 있다 — PTY 콜백이 자기 클로저 안에 들고 있는 `claude_detected`/`codex_detected` 플래그는 reconcile 이 닿을 수 없어, 다음 실행이 entry 가 아니라 continuation 으로 읽히고 entry 전용 정리(exit marker 소거)가 영영 돌지 않는다.

비목표: activity 이외의 필드(activityMessage, outputActive) 순서화. 두 생산자가 겹치는 필드는 `activity` 뿐이다.

## Decision

**두 생산자는 판정을 *파생한 시점*의 단조 stamp 를 함께 발행하고, 프론트는 pane 마다 적용한 stamp 를 기억해 그보다 오래된 판정을 무시한다.** 종료 정리는 종료한 앱에만 적용하고, 두 생산자가 같은 helper 를 통과한다.

1. **stamp 는 파생 시점에 뜬다.** 프로세스 전역 단조 카운터를 PTY 콜백은 타이틀 판정 직전에, reconcile 워커는 스냅샷 직전에 읽는다. emit 시점에 뜨면 "내가 늦게 보냈으니 내가 최신" 이라는 거짓 주장이 된다. 프론트는 `activity` 에만 이 순서를 적용한다 — 같은 이벤트의 title·메시지·출력 신호는 그 이벤트 자신을 설명하므로 항상 유효하다. stamp 없는 입력(마운트 시 `get_terminal_states`)은 거부하지 않는다. 순서화는 오래된 값이 **이기는** 것만 막고, stale 을 고치는 일은 계속 reconcile 의 몫이다.

   **watermark 는 수락한 모든 판정에서 전진한다** — 값이 바뀌었는지와 무관하다. 값 변경 시에만 기록하면 "현재 값과 같은 더 최신 판정"이 흔적을 남기지 못하고, 그 뒤 도착한 오래된 판정이 통과해 pane 을 되돌린다(shell/5 → title shell/20 → reconcile Claude/10). 값이 같아도 그 판정은 그 이전에 파생된 모든 것을 기각할 자격을 갖는다.

2. **PTY 세대 교체는 백엔드에서 폐기하고, 세대 확인부터 발행까지는 원자적이다.** 프론트가 세대를 알 필요는 없다. reconcile 은 스냅샷 전후로 세대를 읽고 달라진 pane 의 판정을 버린 뒤 발행 기록에서도 지워, 다음 패스가 새 세션의 값을 발행하게 한다. 같은 pane 의 종료 전이도 건너뛴다 — 거기서의 "종료"는 옛 세션의 teardown 이고, 그 정리는 teardown 이 이미 한다.

   **폐기 대상은 diff 결과가 아니라 세대 비교 결과 전체다.** 같은 앱으로 재시작하면 판정이 동일해 diff 에 들어오지 않지만, 새 frontend instance 의 activity 는 비어 있다. 발행 기록만 그대로 두면 그 pane 은 전량 재발행 주기(60초)까지 빈 채로 남는다.

   **세대 확인·종료 정리·발행은 terminal catalog 락 아래 하나로 묶는다.** create 는 중복 검사와 세대 예약을, close 는 모든 id-keyed 정리를 그 락에서 한다 — 이미 존재하는 lifecycle 직렬화 지점이다. 확인 직후 시작된 close 가 정리·발행과 교차하면 close 가 지운 exit marker 를 되살리거나 새 instance 에 이전 세션 값을 적용한다. 이 구간에서 잡는 나머지 락은 전부 더 높은 번호라 락 순서가 유지된다.

3. **freshness 예산은 패스 전체를 센다.** 프로브 1회가 아니라 `refresh()` 패스 전체(기본 distro 해석 + 모든 distribution 프로브)에 `WSL_LIVENESS_PASS_BUDGET` 을 두고, 개별 프로브는 자기 타임아웃과 남은 예산 중 작은 쪽을 받는다. 예산이 바닥나면 남은 distribution 은 **판정 없이 건너뛴다** — 늦게 발행하면 그 pane 하나가 아니라 모든 pane 의 판정이 창 밖으로 늙는다. 건너뛴 수는 로그로 남긴다. cadence 는 패스 시작 기준으로 재고, 불변식은 `cadence + 패스 예산 ≤ 음성 창` 이다(ADR-0135 4 의 `cadence + 프로브 타임아웃` 을 대체).

4. **전량 재발행은 발행량만 바꾼다.** 발행 기록은 diff 기준이자 lifecycle 직전 상태다. 재발행은 플래그로 전달하고 기록은 유지한다.

5. **종료 정리는 `(terminal, app)` 단위이고, 감지 epoch 로 세션까지 구분한다.** grace 엔트리는 그 앱을 가리킬 때만 지우고, known 캐시는 종료한 앱의 것만 비우며, `claude_*` 세션 필드는 Claude 가 종료했을 때만 건드린다. 세션 teardown 은 예외로 남는다 — 거기에는 보호할 후임이 없으므로 무조건 지운다.

   앱 이름만으로는 Claude→Claude 재실행을 구분하지 못한다. 같은 PTY·같은 id·같은 이름이라 `(terminal, app)` 범위가 후임과 전임을 같은 것으로 본다. 그래서 `PtyCallbackState` 에 **감지 epoch** 를 두고 타이틀 상태머신의 entry 분기마다 증가시킨다. 판정을 만든 쪽은 그 시점의 epoch 를 함께 읽고, 정리 시점에 값이 달라졌으면 **정리 전체를 포기한다** — 그 상태는 이미 후임의 것이다. 콜백 자신의 종료 판정은 같은 스레드에서 그 타이틀로 즉시 결정되므로 epoch 를 요구하지 않는다. epoch 가 없는 pane(콜백 상태 미등록)도 정리하지 않는다 — create/close 가 그 상태를 소유한다.

6. **PTY 콜백의 감지 플래그는 공유 상태다.** `PtyCallbackState` 를 `AppState` 에 공개해 콜백 밖에서 관측된 종료도 같은 플래그를 끌 수 있게 한다. 두 종료 경로 — 콜백의 타이틀 상태머신과 reconcile — 는 같은 helper 를 호출한다. 두 벌의 정리 코드가 갈라지는 것이 4번 결함의 형태였다.

   등록 시점은 **다른 id-keyed 테이블과 같다** — spawn 직후가 아니라 catalog 에 publish 하는 시점. spawn 이나 commit 이 실패하면 그 id 로는 어떤 close 도 돌지 않으므로, 먼저 넣으면 실패마다 항목이 남는다. 제거는 close·commit 롤백·fatal teardown 세 경로 모두에서 한다.

## Alternatives Considered

- **라이브·reconcile 발행을 하나의 순서화 지점(뮤텍스/채널)으로 모은다.** 리뷰가 제시한 첫 번째 선택지이고 순서 보장이 가장 강하다. 기각: PTY 콜백은 pane 마다 초당 여러 번 도는 hot path 이고, 그 지점은 reconcile 패스가 전 터미널을 도는 동안 — 즉 게스트 왕복과 pane 당 16KB 스캔을 포함해 — 잡혀 있게 된다. 타이틀 처리 지연은 곧 화면 지연이다. stamp 는 같은 역전을 락 없이 막는다. 반면 **lifecycle 교체와의 직렬화**(Decision 2)는 대상이 다르다 — 잡는 구간이 세대 확인부터 발행까지로 짧고, 이미 존재하는 catalog 락을 그대로 쓴다.
- **lifecycle 직렬화용으로 새 최상위 락을 만든다.** 기각: create/close 가 이미 terminal catalog 락으로 그 직렬화를 하고 있다. 락을 하나 더 얹으면 순서 규칙만 늘고 보장은 같다.
- **세대를 프론트 payload 로 보내 적용 시 검증한다.** 리뷰가 제시한 다른 선택지. 기각: 프론트 스토어는 PTY 세대를 모른다(출력 프로토콜 경로가 `TerminalView` 로컬로 들고 있을 뿐이다). 스토어까지 끌어올리면 계약이 하나 더 늘고, 새 세션이 아직 아무 이벤트도 내지 않은 구간은 여전히 열려 있다. 백엔드에서 폐기하면 그 구간까지 닫힌다.
- **exit 정리를 앱 이름 대신 콜백 identity(`Arc::ptr_eq`)로 묶는다.** 기각: 같은 PTY 안의 Claude→Claude 재실행은 `PtyCallbackState` 를 공유하므로 identity 가 바뀌지 않는다. 구분해야 하는 것은 PTY 가 아니라 감지 세션이고, 그것을 세는 것이 epoch 다.
- **stamp 대신 payload 에 PTY generation 만 싣고 프론트가 비교한다.** 기각: generation 은 세션 교체만 잡고 같은 세션 안의 순서 역전(주된 증상)은 못 잡는다. 반대로 stamp 는 세션 교체를 못 잡으므로 둘 다 필요하고, 세대 비교는 백엔드에서 끝낼 수 있어 프론트에 계약을 하나 덜 늘린다.
- **stamp 를 emit 직전에 뜬다.** 구현이 단순하다. 기각: 그러면 stamp 는 도착 순서를 되풀이할 뿐 아무것도 순서화하지 못한다.
- **프로브를 distribution 병렬 실행해 패스 시간을 상수로 만든다.** 기각: 패스당 `wsl.exe` 프로세스가 distro 수만큼 동시에 뜬다. 예산 초과는 distro 가 여럿인 드문 구성에서만 발생하고, 그때 한 패스를 건너뛰는 비용은 판정 없음 1회다. 병렬화는 이 예산이 실제로 자주 바닥날 때 다시 본다.
- **음성 창(`WSL_LIVENESS_AUTHORITATIVE_MAX_AGE`)을 늘려 예산을 맞춘다.** 기각: 그 창은 갓 시작한 에이전트가 stale 부정에 막히는 시간이기도 하다(ADR-0134). 예산을 늘리는 쪽이 아니라 패스를 묶는 쪽이 옳다.
- **재발행용 기준 맵과 lifecycle 용 직전 상태를 두 개로 나눈다.** 리뷰가 제시한 대안. 기각: 같은 값을 두 벌 들고 동기화 규칙을 새로 만드는 대신, 재발행을 상태가 아니라 인자로 표현하면 맵은 하나로 족하다.

## Consequences

- 두 생산자 사이의 순서 역전이 사라진다. 최악의 경우 오래된 판정이 무시될 뿐이고, 그 pane 은 다음 reconcile 패스(3초) 안에 재확인된다.
- 새 외부 계약: `terminal-activity-reconciled` 엔트리와 `terminal-title-changed` payload 에 `activitySequence` 가 실린다(ADR-0135 의 `[{terminalId, activity}]` 를 확장). 프론트 스토어는 pane 마다 적용한 stamp 를 보관한다. 구독자가 stamp 를 무시해도 기존 동작으로 degrade 할 뿐이다.
- `AppState` 에 `pty_callback_states` 가 생긴다. 테이블 락은 한 pane 의 `Arc` 를 넣고 빼거나 epoch 를 읽는 동안만 잡는다(락 순서 18).
- reconcile 패스의 꼬리(세대 확인 → 종료 정리 → emit)가 terminal catalog 락을 잡는다. 3초마다 짧게, 발행할 것이 없으면 정리만 하고 놓는다. 그 사이 PTY 콜백의 `terminals` 접근과 create/close 가 대기한다 — 감지 sweep 자체는 이 구간 밖이라 락 유지 시간은 맵 조작과 이벤트 직렬화 수준이다.
- distro 가 여럿인 구성에서는 한 패스가 일부 distribution 을 건너뛸 수 있다. 그 pane 들은 그 패스 동안 게스트 판정 없이 휴리스틱이 소유한다 — 판정 지연 1패스이고, 로테이션 때문에 매번 같은 distribution 이 밀리지는 않는다.
- 비용: pane 당 정수 하나(백엔드 stamp, 프론트 스토어 필드). 락 없음.
- 재검토 조건: stamp 로도 못 막는 역전(같은 파생 시점에 두 판정이 갈리는 경우)이 관측되면 순서화 지점을 실제로 하나로 모으는 첫 번째 대안으로 돌아간다. 패스 예산 초과가 상시화되면 프로브 병렬화를 다시 검토한다.
