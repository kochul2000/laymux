# 0088. PTY output fatal은 reader를 멈추고 해당 generation을 비동기 teardown한다

- Status: Accepted
- Date: 2026-07-29
- Source: issue #630 · [architecture/data-flow.md §8.8](../architecture/data-flow.md) · [ADR-0001](0001-osc-rust-single-pass.md) · [ADR-0072](0072-terminal-output-gap-sequence-exact-repair.md) · [ADR-0084](0084-desktop-terminal-output-parsed-credit.md) · [ADR-0087](0087-mutex-poison-fail-closed-discard-only.md)
- Extends: [ADR-0084](0084-desktop-terminal-output-parsed-credit.md)의 output authoritative-state fatal을 explicit close 대기에서 generation-scoped 자동 teardown으로 확장한다.
- Amends: [ADR-0087](0087-mutex-poison-fail-closed-discard-only.md)의 terminal-output fatal Condvar discard-wait 예외를 제거한다. callback은 recovered guard를 기다리지 않고 `Stop`을 반환한다.

## Context

ADR-0084는 protocol/runtime/sequenced ring 또는 desktop parsed-credit 상태를 더 이상 신뢰할 수 없을 때 PTY callback을 fail-stop했다. 기존 구현은 callback을 현재 호출에서 끝내지 않고 generation retirement Condvar에서 대기했다. 따라서 explicit close가 오기 전까지 reader thread 하나가 남고, callback 반환 뒤 다음 read를 막는 계약도 PTY 계층에 표현되지 않았다.

fatal 시점은 PTY handle 설치보다 빠를 수 있다. output generation은 child spawn 전에 reserve되지만 `pty_handles`와 terminal catalog는 spawn 뒤에 설치된다. id만 보고 비동기 close하면 그 사이 같은 id로 생성된 새 generation을 종료할 수 있고, callback 또는 AppState 락 안에서 `PtyHandle::terminate()`를 기다리면 reader/close/creation lock 경합이 deadlock으로 바뀔 수 있다. terminate는 platform control call 취소에서 장기 지연될 수 있으므로 하나의 직렬 worker가 catalog cleanup과 resource 종료를 함께 맡아도 다른 terminal teardown을 막는다.

범위는 PTY output callback의 reader 제어 계약, authoritative output fatal의 generation-local teardown 요청, create-before-handle-install race, explicit close/rollback과의 수렴, Windows/Linux 공통 reader loop다. 정상 EOF 자동 catalog 정리, Tauri event 전달 실패의 정책, UI attach·ACK watchdog, 전역 mutex poison 분류는 비목표다.

## Decision

**PTY output callback은 `Continue` 또는 `Stop`을 반환하며, authoritative output fatal은 `Stop`을 즉시 반환한 뒤 해당 generation을 정확히 한 번 비동기 teardown한다.**

- PTY reader loop는 callback이 `Stop`을 반환하면 다음 master read와 다음 callback dispatch를 모두 수행하지 않는다. Windows ConPTY와 Unix PTY가 같은 loop와 같은 제어 enum을 사용한다.
- fatal은 현재 generation의 `TerminalOutputSession`이 소유한 원자적 teardown-request bit로 exactly-once 예약한다. 중복 record/credit fatal은 새 worker를 만들지 않지만 항상 `Stop`을 반환한다.
- `AppState`는 terminal을 받기 전에 cleanup coordinator와 reaper coordinator를 시작한다. fatal callback은 request bit를 claim한 뒤 live cleanup channel에 generation-scoped job만 enqueue한다. coordinator 시작 실패는 terminal이 생기기 전 `AppState` 생성을 실패시킨다.
- `record_output`의 protocol/runtime/ring 오류와 desktop-flow capacity 오류는 authoritative prefix 또는 credit 상태를 신뢰할 수 없는 fatal이다. callback은 그 이후 legacy event, activity, OSC 처리나 추가 output을 수행하지 않는다. sequenced ring 기록 뒤의 Tauri v2 emit 실패는 ADR-0072/0084의 exact-pull 복구 가능 delivery loss이므로 fatal로 승격하지 않는다.
- cleanup coordinator는 terminal catalog 락 아래 현재 output session이 캡처한 `Arc`와 registry의 current generation이 같은지 비교한다. 일치할 때만 session/protocol/ring compatibility projection, catalog, auxiliary per-terminal state와 PTY handle을 분리한다. 일치하지 않으면 stale job은 아무 상태도 바꾸지 않는다.
- cleanup은 `terminals → terminal-output registry → protocol → output ring → pty_handles` 순서를 유지한다. retirement와 제거는 ADR-0087의 discard-only helper만 사용하고 poison된 상태를 정상 운영에 재노출하지 않는다.
- `exec_locks` entry는 terminal generation을 lock Arc와 함께 저장한다. 새 generation은 더 낮은 generation entry를 새 Arc로 교체하고 stale caller가 더 높은 current generation을 역교체하려 하면 실패한다. lock 선택 뒤 table이 비었다가 같은 id가 재생성되는 경합도 있으므로 write/execute operation은 선택한 expected generation을 보존한다. async lock 획득 뒤 physical write admission은 terminal catalog 락 아래 current output generation을 다시 검증하고 같은 임계구역에서 그 generation의 `PtyHandle`을 clone한다. body·CR을 포함한 이후 write는 id table을 다시 조회하지 않고 그 handle만 사용한다. close가 admission 뒤 이기면 old handle 종료가 후속 write를 실패시키며 새 generation handle로 넘어가지 않는다. fatal cleanup은 모든 다른 AppState 락을 놓은 뒤 expected generation과 entry generation이 같은 경우만 제거한다.
- cleanup coordinator는 추출한 handle을 reaper channel로 넘긴 뒤 다음 terminal job을 처리한다. reaper coordinator는 handle마다 독립 OS thread를 기동하고, thread 생성 실패 시 closure와 handle 소유권을 회수해 성공할 때까지 재시도한다. 한 `PtyHandle::terminate()`가 지연돼도 다른 terminal cleanup이나 reaper를 head-of-line block하지 않는다.
- `PtyHandle::terminate()`와 플랫폼 child/master/writer 종료 대기는 callback과 모든 AppState 락 밖에서만 실행한다. cleanup이 handle을 map에서 추출한 뒤에는 explicit close나 중복 job이 같은 handle을 다시 소유하지 못한다.
- fatal이 handle 설치 전에 이기면 worker는 reserved generation만 retire한다. create는 generation의 request bit 또는 commit 실패를 보고 아직 설치하지 않은 handle을 직접 terminate하며 registration guard가 compatibility projection을 rollback한다.
- fatal이 설치와 경합하면 catalog 락이 승자를 정한다. 설치가 먼저면 worker가 handle을 추출하고, retirement가 먼저면 create commit이 실패해 create가 handle을 종료한다. 어느 경우든 OS resource 종료 소유자는 하나다.
- explicit close, creation rollback, automatic teardown은 모두 idempotent하게 수렴한다. old worker는 같은 id의 새 generation을 retire하거나 그 PTY handle을 가져갈 수 없다.

## Alternatives Considered

- **callback을 retirement Condvar에 계속 주차한다.** 다음 read는 막지만 reader thread가 explicit close에 종속되고 자동 resource 회수가 없다. callback 반환/reader stop 계약도 검증할 수 없어 기각했다.
- **fatal callback에서 `close_terminal_session`을 동기로 호출한다.** platform terminate가 callback 안에서 reader 자신과 child/master 종료를 기다릴 수 있고 AppState lock 경계를 넓혀 deadlock 위험이 있으므로 기각했다.
- **terminal id만 queue에 넣어 나중에 close한다.** queue 지연 중 같은 id가 재사용되면 새 generation을 종료하는 ABA 오류가 생기므로 캡처한 session identity를 사용한다.
- **cleanup과 terminate를 단일 worker에서 직렬 실행한다.** 하나의 platform terminate 지연이 다른 terminal의 catalog cleanup과 resource 회수를 막는 head-of-line failure가 되므로 분리된 cleanup coordinator와 독립 reaper를 사용한다.
- **Tauri async runtime의 blocking pool에 직접 enqueue한다.** library test가 production `AppHandle` emit 경로와 함께 이 generic을 링크할 때 Windows GUI import(`TaskDialogIndirect` 포함)가 추가되어 test harness가 loader 단계에서 종료됐다. backend-only teardown이 GUI runtime linkage에 종속되지 않도록 표준 channel coordinator를 사용한다.
- **reader만 멈추고 catalog/handle은 남긴다.** UI와 Automation에는 살아 있는 terminal처럼 보이지만 output은 영구히 진행하지 않는 half-dead generation이 남아 완료 조건을 충족하지 못하므로 기각했다.
- **Tauri output event emit 실패도 모두 fatal로 처리한다.** bytes는 sequenced ring에 남고 exact pull로 복구할 수 있다는 ADR-0072/0084 결정을 불필요하게 뒤집으므로 기각했다.

## Consequences

- 복구 불가능한 output prefix 손상 뒤 추가 PTY read/callback, legacy output, activity·OSC side effect가 발생하지 않고 terminal generation과 OS resource가 사용자 close 없이 제거된다.
- create 초기 출력에서 fatal이 나도 orphan child나 handle을 남기지 않으며, close/remount와 경합해도 새 generation을 손상하지 않는다.
- fatal close 알림은 일반 terminal 목록 변경과 같은 resource-list 갱신 경로를 사용한다. create 응답 직전 경합에서는 생성 성공 직후 close 알림을 볼 수 있으므로 소비자는 기존과 같이 catalog를 다시 조회해야 한다.
- `AppState`마다 cleanup/reaper coordinator 두 개와 unbounded channel 두 개가 추가되며 fatal handle마다 독립 reaper thread 하나가 종료 때까지 존재한다. generation별 request bit가 중복 cleanup enqueue를 막고 spawn 실패 job은 handle 소유권을 잃지 않은 채 retry queue에 남는다.
- 테스트는 공통 reader loop의 Stop 후 추가 read 금지, pending-create retirement, installed handle 종료, 중복 teardown, stale generation 보호, 동일 Arc를 재사용한 cleanup ABA와 empty exec table에서의 stale write/execute admission, reaper spawn 재시도와 terminate HOL 격리를 고정한다. 실제 spawn→fatal→registry/compat cleanup→child/master/writer 종료 테스트는 Windows ConPTY와 Unix PTY에서 같은 소스로 실행된다.
- 재검토 조건은 다수의 platform terminate가 동시에 장기 고착되어 reaper thread 수 상한·관측 지표·강제 process-level reaper가 필요하다는 실측이 생기는 경우다.
