# 0084. desktop terminal output은 parsed ACK credit로 PTY producer를 유한하게 제한한다

- Status: Accepted
- Date: 2026-07-28
- Source: 사용자 보고(issue #624: 누적 출력 폭주 뒤 xterm discard와 dev 프로세스 종료) · PR #626 독립 리뷰 · 2026-07-28 dev 재측정 · [architecture/data-flow.md §8.4·§8.8](../architecture/data-flow.md) · [ADR-0026](0026-conpty-width-resize-repaint-filter.md) · [ADR-0072](0072-terminal-output-gap-sequence-exact-repair.md) · [ADR-0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md)
- Amends: [ADR-0072](0072-terminal-output-gap-sequence-exact-repair.md)의 Decision 마지막 항목 중 “PTY 읽기 스레드는 프론트 소비 속도에 묶이지 않는다”를 desktop parsed-credit lease에 한해 대체한다. 바로 앞의 “이벤트 전달을 신뢰성 채널로 바꾸지 않는다”와 sequence-exact gap 복구 결정은 유지한다.
- Extends: [ADR-0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md)의 visible xterm single-flight FIFO와 out-of-band 진단을 유지하면서, 당시 비범위였던 backend PTY producer/ring 경계까지 desktop credit으로 확장한다. 원 segment의 stabilizer·cursor·alternate-buffer·activity 처리는 계속 즉시 실행하고 ACK만 checkpoint와 visible parse의 교집합까지 늦춘다.
- Relation: [ADR-0026](0026-conpty-width-resize-repaint-filter.md)의 동일 미수락 batch 재시도 계약을 유지한다.

## Context

issue #624의 최초 실기는 PR #622 최종 single-flight 구현이 들어오기 전 코드에서 나왔다. 당시 visible drain은 여러 `terminal.write()`를 callback 대기 없이 제출할 수 있었고 xterm 6.0.0의 약 50 MB pending watermark를 넘으면 `write data discarded, use flow control to avoid losing data`가 동기로 발생했다. PR #622 최종 구현은 physical write를 callback 단위로 하나만 허용하고, 거절된 batch 객체와 buffer를 FIFO 선두에 복원해 이 직접 축적 경로를 닫았다.

xterm의 callback 순서에는 별도 위험이 있다. `WriteBuffer._innerWrite`는 embedder callback이 정상 반환한 뒤에야 buffer offset을 전진시키고 `_pendingData`를 차감한다. 현재 single-flight에서 callback이 throw하면 다음 작은 write 하나는 수락되지만 기존 `_writeBuffer`가 비어 있지 않아 새 drain이 예약되지 않는다. 두 번째 callback이 오지 않고 laymux의 `pendingTerminalWrites`가 1로 고정되어 FIFO가 멎는다. 이는 watermark 거절 반복과 다른 parser/FIFO stall이다. accepted write callback은 여전히 no-throw여야 하지만, 이 위험만 막아서는 누적 폭주를 제한하지 못한다.

PR #626 첫 커밋을 dev에서 이슈 원문의 WSL 폭주로 두 번 재측정했을 때 프로세스는 살아 있었고 discard·backpressure·callback failure는 모두 0이었다. 그러나 `deltaBytes`는 115,153,468, `writeQueueMaxBytes`는 74,770,614까지 늘고 마지막 report의 `xtermWrites`는 708에 머물렀다. probe lag는 최대 23,056 ms, stall은 6회였고 출력 종료 뒤에도 `lastReportAgeMs`가 30초까지 증가했다. callback 예외는 이 실기의 직접 원인이 아니다. PTY reader가 WebView 소비 속도와 무관하게 ring 기록과 Tauri event push를 계속하여 frontend가 수십 MB의 sequenced bytes·checkpoint 작업·visible write를 보유하는 것이 확인된 문제다.

frontend queue를 크기 제한 뒤 drop하면 event sequence에 구멍이 나고, 1 MiB ring이 wrap한 뒤에는 ADR-0072도 복구할 수 없다. accepted byte를 재시도하면 terminal state가 두 번 적용된다. lossless와 유한 메모리를 함께 만족하려면 소비 완료를 backend credit로 환류하고, 창이 소진되면 PTY master read를 멈춰 ConPTY와 자식 프로세스의 유한 pipe까지 backpressure를 전달해야 한다.

세션 생성 뒤 desktop attach 전에도 listener는 이미 등록되어 있지만 PTY가 먼저 출력할 수 있다. 이 구간에 credit이 없으면 startup command 폭주가 attach RPC보다 앞서 Tauri event queue를 키운다. 따라서 desktop이 생성한 session은 PTY spawn 전에 bootstrap lease를 활성화해야 한다.

과거 exit 1은 해당 시각의 Rust panic·`crash.log`·Windows Application/WER 증거가 없어 OS 직접 원인을 특정하지 않는다. 이 결정은 재현된 frontend 장기 정지와 byte backlog를 해결한다. WebView 프로세스 자체 복구 정책은 비목표이며 별도 증거가 생기면 새 issue로 분리한다.

## Decision

**desktop terminal output은 generation별 512 KiB parsed-credit window를 사용하고, 연속 byte prefix가 visible xterm과 rendererless checkpoint xterm 양쪽에서 파싱된 뒤에만 ACK하며, credit이 소진되면 락을 보유하지 않은 PTY reader callback 끝에서 producer를 대기시킨다.**

이 결정은 ADR-0072의 “PTY 읽기 스레드는 프론트 소비 속도에 묶이지 않는다”를 **desktop surface에 한해서만** 명시적으로 대체한다. `terminal-output-v2`는 계속 비신뢰 알림이고 누락은 ring 조회로 복구한다. Remote-only session과 Remote subscriber의 bounded overflow 계약도 그대로다. ADR-0080에서 비범위였던 backend PTY ring/producer를 확장하지만, 그 ADR의 원 segment 즉시 의미 처리 불변식은 바꾸지 않는다.

- `TerminalOutputSession`이 desktop flow-control의 SoT다. 한 generation에는 desktop lease가 정확히 하나만 활성화될 수 있으며 동일 terminal을 복수 desktop surface가 동시에 소비하는 것은 지원하지 않는다. 활성 lease는 JavaScript 숫자로 변환하지 않는 generation-scoped 불투명 문자열 token, 가장 큰 contiguous parsed ACK sequence, 512 KiB window를 가진다. frontend 숫자나 queue depth는 admission 결정을 소유하지 않는다.
- desktop create 경로는 PTY spawn 전에 sequence 0의 bootstrap lease를 활성화한다. 첫 `attach_terminal_output`은 snapshot capture와 같은 generation 경계에서 새 token을 발급해 bootstrap/이전 token을 원자적으로 교체한다. 생성→attach 사이에도 최대 window와 PTY read chunk 하나만 event 경계에 진입한다.
- attach의 최초 ACK prefix는 `snapshotStartSeq`다. 최대 1 MiB snapshot은 이미 복사된 bounded payload이며, `snapshotSeq`까지의 ACK는 snapshot이 두 frontend xterm에 실제 적용된 뒤에만 전진한다.
- live·repair segment ACK는 visible xterm의 `write` callback과 rendererless checkpoint의 write chain이 모두 같은 contiguous `seqEnd`에 도달한 뒤에만 전진한다. native Windows/WSL stabilizer가 bytes를 보류하면 parsed callback과 ACK도 함께 보류한다. out-of-order 완료는 hole 앞에서 멈추고 더 큰 sequence를 먼저 ACK하지 않는다.
- ACK sender는 한 번에 하나의 IPC만 보내고 그 사이 완료된 prefix를 가장 큰 contiguous sequence로 합친다. 일시적 IPC 실패는 같은 token/sequence를 재시도한다. reattach가 token을 교체하거나 effect가 폐기되면 stale sender를 종료하고 stale ACK는 새 lease를 절대 전진시키지 않는다.
- backend ACK는 generation과 불투명 token이 현재 lease와 같은지, sequence가 현재 ring `write_seq` 이하인지, 이미 ACK한 값 이상인지 검증한다. 같은 sequence의 재전송은 idempotent 성공이고 더 작은 sequence는 계약 오류다.
- backend가 ACK에 `false`를 반환하면 generation/token lease가 이미 stale인 것이므로 frontend는 재시도하지 않고 해당 sender를 폐기한 뒤 현재 epoch를 한 번 재부착한다.
- 활성 lease가 있고 attach/repair가 정착한 동안 frontend는 1초마다 현재 contiguous sequence에서 `resume_terminal_output` exact pull을 시작한다. event full-edge가 유실된 뒤 producer가 credit에서 잠들면 다음 event가 오지 않으므로, 알림과 독립적인 이 pull이 ring의 미전달 byte를 회수한다. event gap repair와 같은 coordinator `beginRepair()` 및 5초 왕복 watchdog을 사용하고 한 요청만 in-flight로 둔다.
- exact pull의 `[seq, seq)` 빈 응답은 idle 확인이지 recovery가 아니다. backend의 최신 geometry revision이 frontend parsed geometry보다 앞서도 빈 범위는 어떤 grid의 byte도 포함하지 않으므로 거절하거나 frontend geometry를 갱신하지 않는다. pull 중 도착한 live delta는 coordinator에 보류했다가 응답 뒤 sequence 순서로 정확히 한 번 적용한다. 실제 pull 응답에 byte가 있을 때만 `repair`를 세며, 빈 응답이나 pending live delta만 drain한 경우는 세지 않는다.
- checkpoint parse 실패나 visible xterm의 non-backpressure discard는 로그만 남긴 채 credit을 멈추지 않고, sender 폐기 → epoch 증가 → stabilizer/queue discard 순서로 현재 epoch의 재부착을 한 번 예약한다. discard callback은 자신이 캡처한 epoch가 이미 바뀌었으면 아무 작업도 하지 않는다. attach·ACK control IPC 영구 pending watchdog과 orphan completion 정책은 후속 issue #629 범위다.
- native stabilizer가 즉시 prefix를 내보내면서 frame tail을 보류할 때 prefix physical write에는 현재 보류 범위의 non-destructive discard snapshot을 붙이고, parse 완료는 tail까지 계속 보류한다. prefix 거절 뒤 tail 성공이 실패를 덮어써 ACK하는 일을 금지한다. 같은 live batch key·epoch·geometry의 callback-bearing request는 명시적으로 coalesce할 수 있지만 병합된 모든 parsed/discard callback을 보존해 batch 결과 뒤 각각 정확히 한 번 settle한다. 그 밖의 callback-bearing request는 barrier다.
- PTY callback은 protocol/ring 기록, bounded Remote subscriber fan-out, Tauri v2/legacy emit, activity·OSC 처리를 끝낸 뒤 flow gate를 확인한다. 이 대기 지점에서는 protocol/runtime/output/AppState 락을 하나도 보유하지 않는다. credit 소진 시 Condvar에서 기다려 다음 master read를 멈추고 OS PTY pipe까지 유한한 producer backpressure를 전달한다.
- steady-state 미ACK source 범위는 512 KiB와 현재 4 KiB PTY read chunk 하나를 합친 값 이하라 1 MiB sequenced ring보다 작다. 그러므로 ACK 전 live bytes는 ring에 남고 event gap은 ADR-0072의 exact repair로 이어 붙일 수 있다. attach bootstrap은 최대 1 MiB snapshot을 별도 소유한 채 producer를 즉시 막는다.
- reattach는 같은 generation에서도 새 token을 만들고 waiter를 깨워 새 lease 조건을 다시 평가한다. unmount의 기존 `close_terminal_session`은 session을 retire하고 모든 waiter를 깨운다. old epoch의 parsed/discard callback은 폐기된 ACK sender를 움직이지 못한다.
- Remote/cloud subscriber는 desktop token을 발급하지 않는다. remote-only registry/session은 기존 bounded subscriber overflow→gap→reattach 계약을 유지한다. desktop lease와 Remote가 함께 있으면 shared PTY producer가 잠시 멈춰 Remote에도 같은 sequence가 늦게 전달될 뿐, Remote frame 형식·wire sequence·overflow 정책은 바뀌지 않는다.
- `terminal.write` 호출만 admission `try/catch`에 둔다. accepted 뒤 진단 실패는 byte outcome을 `onDiscard`로 뒤집지 않는다. 동기 backpressure는 진단보다 먼저 같은 materialized batch와 buffer를 FIFO 선두에 복원하고, warning/counter는 각각 best-effort no-throw로 남긴다.
- accepted callback은 parse metric, sync monitor, consumer, refresh, drain 단계를 독립적으로 실행하고 어떤 예외도 xterm으로 돌려보내지 않는다. accepted byte는 callback 실패를 이유로 재시도하거나 `onDiscard`로 바꾸지 않는다. 실패 카운터와 source+stage 최초 경고 규율은 유지한다.
- Tauri `terminal-output-v2` listener 전체도 no-throw 경계다. payload normalize/coordinator ingest 실패만 `malformedDelta`로 세고 epoch를 재부착한다. pipeline counter·warning 같은 진단이 실패해도 이미 결정된 byte 적용 또는 exact repair를 바꾸지 않으며, detector·stabilizer·checkpoint·queue 실패는 callback 밖으로 빠져나가지 않고 해당 epoch를 재부착한다.
- protocol/runtime/desktop-flow mutex poison 또는 `record_output` 실패 뒤에는 정상 credit 상태를 신뢰하지 않는다. 그 chunk는 authoritative sequence를 얻지 못했으므로 legacy event·OSC·후속 output을 계속하지 않고 generation을 명시적으로 close/rollback할 때까지 PTY callback을 fail-stop한다. poisoned mutex를 정상 attach·ACK·capacity 경로에서 복구하여 gate를 여는 것은 금지한다.
- retirement는 별도 atomic retired bit를 먼저 publish한 뒤, 오직 discard·wake cleanup을 위해 poisoned guard를 회수해 active lease를 비우고 Condvar/subscriber를 깨운다. 이 cleanup은 보호 상태의 정상 사용을 재개하지 않고 mutex poison도 지우지 않는다. retirement 뒤 racing callback은 atomic fast path에서 bytes를 버린다. reader 자체를 즉시 중단하거나 generation을 자동 teardown하는 정책은 issue #630, 전역 poisoned-lock 정책 표준화는 issue #631의 후속 범위다.
- Tauri v2 event emit 실패는 byte가 ring에는 남은 delivery loss다. sequence와 누적 폐기 수를 로그로 남기고 1초 exact pull이 회수한다. 반대로 ring 기록 실패는 sequence가 없어 복구할 수 없으므로 위 fail-stop 경로를 따른다.

## Alternatives Considered

- **frontend queue를 cap하고 초과 byte/event를 drop한다.** ring이 남아 있는 짧은 gap만 복구할 수 있고 sustained flood가 1 MiB를 넘으면 exact prefix가 사라진다. 유실을 메모리 제한으로 위장하므로 기각했다.
- **ring을 수십 MB로 늘린다.** 지연을 뒤로 미룰 뿐 producer와 consumer 속도 차이를 제한하지 못하며 터미널 수만큼 상주 메모리가 증가한다. 재측정의 74 MB backlog도 이미 1 MiB보다 두 자릿수 크므로 기각했다.
- **event 수 또는 frontend queue depth를 backend에 주기적으로 보고한다.** event 크기가 다르고 수신은 parse 완료가 아니다. checkpoint·stabilizer·visible parser의 실제 보유 byte를 설명하지 못해 기각했다.
- **누락은 다음 delivered event가 만드는 gap으로만 찾는다.** credit window를 채운 마지막 event 자체가 유실되면 producer가 잠들어 다음 event가 영원히 오지 않는다. 활성 lease의 1초 exact pull을 독립 liveness 경로로 둔다.
- **visible xterm callback만 ACK한다.** rendererless checkpoint write chain이 segment closure와 byte buffer를 계속 보유할 수 있어 frontend 전체 메모리가 유한하다는 계약이 아니다. 두 xterm 완료의 교집합을 선택했다.
- **Remote subscriber도 같은 slowest-consumer credit에 포함한다.** 끊어진 브라우저 하나가 PTY 전체를 영구 정지시킬 수 있고 기존 Remote의 bounded overflow→reattach 계약을 바꾼다. desktop 렌더 경계만 producer credit을 소유하고 Remote 정책은 유지한다.
- **callback no-throw만 적용한다.** parser/FIFO stall은 막지만 callback failure 0에서도 수십 MB backlog와 장기 stall이 재현되었으므로 충분하지 않다. 보조 불변식으로 유지하되 해결책으로 삼지 않는다.
- **accepted callback 실패 뒤 batch를 재시도한다.** 같은 byte를 화면·reply·cursor state에 두 번 적용해 exactly-once를 깨므로 금지한다.

## Consequences

- sustained output이 frontend보다 빠르면 shell/명령이 PTY pipe에서 자연스럽게 느려진다. 이는 데이터 유실이나 무제한 메모리 대신 선택한 의도적 backpressure다.
- active desktop session 하나가 보유하는 미ACK live payload와 Tauri event backlog는 window와 한 read chunk로 제한된다. attach 중에는 여기에 최대 1 MiB snapshot payload가 더해지지만 producer는 parse ACK 전 진행하지 않는다.
- frontend가 일시 정지해도 backend와 프로세스는 살아 있고 PTY reader가 기다린다. frontend가 다시 callback/ACK를 처리하면 동일 sequence 다음 byte부터 재개한다. 영구 정지한 WebView의 자동 복구는 이 ADR의 범위가 아니다.
- stale ACK, ACK IPC 실패, reattach/reset race를 다루는 상태와 테스트가 추가된다. token 교체·retire는 Condvar wake를 반드시 동반하므로 old waiter가 새 lease나 종료 뒤 영구 대기하지 않는다.
- idle 상태에서도 활성 desktop pane마다 초당 한 번 exact-resume IPC가 발생한다. 응답은 빈 bounded payload이고 동시 요청은 하나뿐이며, attach·ACK control IPC 영구 pending과 orphan completion은 별도 issue #629가 다룬다.
- poisoned terminal-output generation은 explicit close까지 output reader callback 하나가 drain/drop 경계에서 대기할 수 있다. 자동 reader stop/teardown은 issue #630에서 결정하며, 이 PR은 손상된 prefix를 정상 output으로 재개하는 것보다 fail-stop 정확성을 우선한다.
- Remote output은 desktop backpressure 때문에 지연될 수 있지만 byte 순서·snapshot/delta wire 계약·subscriber overflow 의미는 그대로다. desktop flow가 없는 remote-only terminal output registry는 기존 동작을 유지한다.
- callback no-throw 진단은 실기 직접 원인으로 주장하지 않는다. 실제 xterm 6.0.0 모델 테스트는 첫 callback throw 뒤 두 번째 write가 수락되지만 drain/callback이 오지 않는 FIFO stall을 재현한다.
- 완료 조건은 원 이슈 WSL 폭주 반복에서 process 생존, discard/backpressure/callback failure 0, frontend report 지속, `writeQueueMaxBytes`가 window 부근의 유한 상한 안에 머묾, 종료 뒤 prompt/tail 응답 복귀, gap/repair 불필요 또는 sequence-exact 성공이다. 과거 exit 1의 직접 원인은 별도 증거 없이는 확정하지 않는다.
- xterm, ring 크기, PTY read chunk를 변경할 때 `window + max read chunk < ring capacity` 관계와 callback-before-accounting 계약을 함께 재검토한다.
