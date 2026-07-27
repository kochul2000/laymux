# 0071. output delta 유실은 재부착이 아니라 sequence-exact 복구로 갚는다

- Status: Accepted
- Date: 2026-07-27
- Source: issue #600(출력 폭주 시 셀 영구 유실) · issue #596(원 증상) · PR #597(같은 재부착에서 파생된 overlay caret 결함) · [architecture/data-flow.md §8.8](../architecture/data-flow.md) · [ADR-0069](0069-remote-render-checkpoint-attach.md) · [ADR-0038](0038-remote-height-shrink-surface-crop.md)
- Relation: ADR-0069 가 Remote attach 에 세운 "truncated raw tail 은 차분 렌더 TUI 화면의 권위 상태가 아니다" 결론을 데스크톱 live attach 에도 확장한다. data-flow §8.8 의 "다음 expected sequence 보다 큰 delta 는 임의 보간하지 않고 새 attach 를 시작한다" 계약을 정정한다.

## Context

데스크톱 `TerminalView` 는 `terminal-output-v2-{id}` 이벤트로 sequenced delta 를 받는다.
`TerminalOutputAttachCoordinator` 가 `seqStart > expectedSeq` 를 관측하면 그 delta 를 **버리고**
`kind: "gap"` 을 돌려주며, `TerminalView` 는 전체 재부착(`attach_terminal_output` → `terminal.reset()`
→ ring snapshot replay)으로 스트림을 갈아끼운다.

이 복구가 화면을 복원하지 못한다. 차분(differential) 재그림만 하는 TUI 는 자기 화면 모델을 기준으로
"바뀐 셀만" 쓴다. codex 의 실측 프레임은 행 전체를 지우는 시퀀스 없이 `ESC[80;27H` + `ESC[K` 처럼
자기 모델이 계산한 열부터만 지운다. `reset()` 으로 비운 화면 위에 임의의 바이트 오프셋에서 시작한
replay 를 얹으면, TUI 가 "이미 올바르다"고 가정해 다시 쓰지 않는 셀은 **영구히** 빈 채로 남는다.
issue #596 의 픽셀 측정에서 21–22·24–28·36–38 열이 비어 있고 codex 가 park 한 열(39)과 실제 글리프
수(9개)가 어긋난 것이 그 증거다. 한 pane 만 그런 것도 같은 이유다 — 구멍은 그 pane 의 xterm 버퍼에만 있다.

issue #600 은 유실 지점을 `commands/terminal.rs` 의 `let _ = app_clone.emit(...)` 로 지목했다.
그러나 이 리포가 쓰는 Tauri 2.10.3 / tauri-runtime-wry 2.10.1 에서 `emit` 의 실패 경로는 백프레셔가
아니다. `Emitter::emit` → `listeners.emit_js` → `Webview::eval` → `WebviewDispatcher::eval_script` 는
`tracing` feature 가 꺼진 이 빌드에서 `send_user_message` 로 **무한 용량** event-loop proxy 에
메시지를 넣는 것이 전부이고, 실패는 event loop 가 이미 닫힌 경우(`FailedToSendMessage`)와 payload
직렬화 실패뿐이다. 즉 `emit` 을 재시도하거나 용량을 키우는 것으로는 폭주 시의 유실을 설명할 수도,
막을 수도 없다. bounded `try_send` 로 실제 폐기가 일어나는 곳은 Remote/Cloud subscriber
(`TERMINAL_OUTPUT_SUBSCRIBER_CAPACITY = 256`) 쪽이고, 그 경로는 이미 `Gap` 신호로 stream 을 닫는다.

반대로 gap 을 만들 수 있는 원인은 emit 하나가 아니다. 프론트 listener 콜백의 예외, malformed
delta, attach 실패, checkpoint model 적용 실패가 모두 같은 재부착 경로로 수렴한다. 재부착 자체가
화면을 잃는 연산인 한, **어떤 원인이든** 한 번 발생하면 그 pane 은 자가 복구 없이 어긋난 상태로 남는다.
"한번 놓치기 시작하면 계속 놓친다"는 사용자 관측이 이것이다. 재부착은 [ADR-0069](0069-remote-render-checkpoint-attach.md)
의 checkpoint model 도 함께 망가뜨린다 — `reconstructable` 은 `snapshotStartSeq === 0` 일 때만 참이므로,
1 MiB ring 을 이미 한 바퀴 돌린 터미널이 재부착하면 그 generation 은 Remote attach 에도 영구히 쓸 수 없게 된다.

issue #600 이 후보로 든 "snapshot 을 프레임 경계에서 자르기"는 데스크톱에서 성립하지 않는다.
`TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES` 와 ring `DEFAULT_MAX_SIZE` 가 모두 1 MiB 이므로
`output_buffer.rs` 의 `truncated` 분기(첫 `\n` 까지 버리기)는 데스크톱 attach 에서 **도달하지 않는다**.
실제 절단은 ring eviction 이며, evicting ring 에는 보존할 프레임 경계가 애초에 없다.

범위는 데스크톱 live output attach 의 gap 복구 계약과 그것을 지원하는 Tauri output 명령이다.
Remote/Cloud attach 경계(ADR-0069), PTY 입력·resize 소유권, raw ring 을 쓰는 Automation/MCP 진단
계약, 세션 복원 캐시 replay 는 비목표다.

## Decision

**delivery gap 은 화면을 버리는 재부착이 아니라, ring 이 아직 보존하고 있는 정확한 바이트 구간을
당겨와 이어 붙이는 sequence-exact 복구로 갚는다. `reset()` + snapshot replay 는 ring 이 그 구간을
더 이상 보존하지 않을 때만 남는 최후 수단이다.**

- output ring 이 sequenced 바이트의 유일한 진실원이다. `terminal-output-v2` 이벤트는 **알림**이고
  전달 보장이 아니다. 이벤트가 유실돼도 바이트는 ring 에 있으므로 복구는 추측이 아니라 조회다.
- backend 는 `resume_terminal_output(id, generation, seq)` 를 노출한다. generation 과 geometry 를
  `record_output` 과 같은 protocol → runtime gate 아래에서 확인하고 `seq` 부터 현재 write sequence
  까지의 정확한 구간을 하나의 delta 로 돌려준다. generation 이 교체됐거나 `seq` 가 ring 보존 범위
  밖이면 부분 결과를 만들지 않고 `null` 을 돌려준다. **clamping 금지** — 계약은 `delta_since` 와 같다.
- `TerminalOutputAttachCoordinator` 는 gap 을 관측해도 그 delta 를 버리지 않는다. gap 을 보고하면서
  delta 를 pending 으로 유지하고, `beginRepair()` → `completeRepair(repair)` 로 복구 구간을 적용한
  뒤 pending 을 sequence 순서대로 소비한다. 중복/경계 교차 처리는 attach 경로와 동일한 산술을 쓴다.
- 복구 중에는 visible xterm 을 건드리지 않는다. `reset()` 도, epoch 무효화도, stabilizer reset 도 없다.
  복구 바이트는 일반 live 경로로 쓰이므로 xterm 버퍼는 `expectedSeq` 이전 상태를 그대로 유지하고
  ADR-0069 checkpoint model 의 `reconstructable` 도 유지된다.
- gap 구간이 geometry revision 을 가로지르면 sequence-exact 복구를 포기한다. ring 은 바이트별
  geometry 를 보존하지 않으므로 복구 delta 하나에 두 격자의 바이트를 담을 수 없다. 이 경우와
  `resume` 이 `null` 을 준 경우만 기존 전체 재부착으로 승격한다.
- gap·복구·승격·malformed delta·attach 실패는 각각 별개의 사건으로 센다. backend 는 폐기한
  delta 의 sequence 구간과 누적 폐기 수를 `tracing::warn!` 으로 남기고, 프론트는 terminal 별 누적
  카운터를 경고에 실어 출력한다. `emit` 실패를 `let _` 로 삼키는 것은 금지한다.
- 이벤트 전달을 신뢰성 채널로 바꾸지 않는다. PTY 읽기 스레드는 프론트 소비 속도에 묶이지 않는다.

## Alternatives Considered

- **(issue 안 a) `emit` 실패를 재시도·백프레셔·채널 용량으로 막는다** — 이 빌드의 `emit` 경로는
  무한 용량 event-loop proxy 이고 실패는 event loop 종료뿐이다. 막을 대상이 애초에 없고, 신뢰성
  채널을 만들면 PTY 읽기 스레드가 WebView 소비 속도에 묶여 ConPTY 쪽 백프레셔로 번진다. 또한
  emit 이 유일한 gap 원인도 아니어서(listener 예외, malformed delta, attach 실패, checkpoint 실패)
  전달 계층만 고쳐도 재부착이 화면을 잃는 사실은 남는다. 기각.
- **(issue 안 b-1) snapshot 을 프레임 경계에서 자른다** — 데스크톱 attach 는 snapshot 상한이 ring
  크기와 같아 첫 `\n` 절단 분기에 도달하지 않는다. 실제 절단은 ring eviction 이며 evicting ring
  에는 보존할 경계가 없다. 게다가 "프레임 경계"는 VT parser checkpoint 가 아니다(ADR-0069 에서
  같은 이유로 기각한 대안). 기각.
- **(issue 안 b-2) 전체 버퍼 replay** — 이미 하고 있는 것이다. 데스크톱 snapshot 상한이 1 MiB ring
  전체이므로 "더 많이 재생"할 여지가 없고, 문제는 양이 아니라 `reset()` 뒤 임의 오프셋에서 시작한다는
  점이다. 기각.
- **(issue 안 b-3) 앱에 재그림을 요청한다(SIGWINCH 등)** — ADR-0038 대로 codex 0.128+ 는 SIGWINCH
  마다 전체 스크롤백을 재출력하므로 gap 하나가 수 MB 재출력을 유발하고, 그 폭주가 다시 gap 을 만드는
  양성 피드백이 된다. 게다가 앱 협조를 요구하므로 재그림 트리거가 없는 프로그램에는 통하지 않는다. 기각.
- **gap 마다 데스크톱 checkpoint model 을 직렬화해 backend 로 왕복한다(ADR-0069 방식 재사용)** —
  결과는 옳지만 visible xterm 이 이미 정확한 상태를 들고 있는데도 화면을 직렬화·reset·replay 하는
  왕복 비용을 낸다. 필요한 것은 잃어버린 바이트 구간뿐이다. ring 이 그 구간을 보존하지 못하는
  경우에만 의미가 있으므로, 그 경우를 위한 후속 개선으로 남긴다. 지금은 기각.
- **`expectedSeq` 를 잃어버린 delta 의 `seqStart` 로 밀어 gap 을 무시한다** — 구멍이 있는 채로
  스트림을 계속 쓰는 것이므로 지금과 같은 영구 셀 손실을 조용히 만든다. 기각.
- **주기적 전체 재그림 강제** — 증상만 덮고 유실은 그대로다. issue #600 이 명시적으로 배제했다. 기각.

## Consequences

- delivery gap 이 화면 손실을 만들지 않는다. 원인이 emit 실패든 listener 예외든 checkpoint 실패든,
  ring 이 구간을 보존하는 동안은 정확히 같은 바이트가 한 번만 적용된다. "한 번 어긋나면 계속
  어긋난다"는 지속성이 사라진다.
- 재부착 빈도가 떨어지므로 ADR-0069 checkpoint model 의 `reconstructable` 이 유지되고, 데스크톱에서
  출력이 많던 터미널로 Remote 가 attach 하는 경로도 함께 개선된다.
- Tauri 명령이 하나 늘고(`resume_terminal_output`) coordinator 에 복구 상태가 하나 늘어난다.
  복구 중 도착한 delta 는 pending 에 쌓이므로, 복구 RPC 가 오래 걸리면 그만큼 메모리를 쓴다.
  왕복은 로컬 IPC 이고 복구가 끝나면 즉시 배출되므로 상한을 두지 않는다 — 대신 gap 이 반복되면
  카운터가 그것을 드러낸다.
- gap 이 resize 와 겹치면 여전히 전체 재부착으로 승격하고 그때는 화면이 손실될 수 있다. ring 에
  바이트별 geometry 를 붙이는 것은 이 결정의 범위 밖이다. 카운터에서 이 승격이 유의미하게
  관측되면 그때 재검토한다.
- ring 이 gap 구간을 이미 evict 한 경우(1 MiB 를 넘는 미전달 구간)는 여전히 `reset()` + replay 로
  떨어진다. 이 승격 카운터가 0 이 아니라면 ring 크기 또는 checkpoint 재사용(위 기각 대안)을 다시 본다.
- `emit` 실패를 더 이상 삼키지 않으므로, 종료 경합에서 나던 조용한 폐기가 로그에 보인다. 카운터가
  단조 증가 값이므로 로그 회전과 무관하게 실제 폐기 횟수를 셀 수 있다.
- 복구 경로는 [ADR-0008](0008-shell-cursor-shadow-cursor.md) 의 stream-derived cursor 상태를
  **재생성하지 않는다**. 재생성은 `terminal.reset()` 이 바이트를 버릴 때만 정당하다. 근거는
  "복구 바이트도 파서를 탄다" 보다 강하다 — 복구 바이트는 `applyOutputSegments` →
  `processLiveTerminalOutput` 으로 **일반 live delta 와 완전히 동일한 함수**를 통과한다(같은
  `source:"live"`, 같은 stabilizer, 같은 `attachEpoch`). 따라서 `isDec2026FrameOpen` 래치뿐
  아니라 `cursorAbsY`·`commandStartLine`·`frameSavedCursorAbsY`·alt buffer 플래그·
  `syncOutputActiveRef` 가 gap 이 없었을 때와 같은 순서로 구동된다. 여기서 재생성하면 프레임 안
  `?25h` 가 권위 park 로 승격되는 정반대 결함이 생긴다(issue #596 과 대칭).
- 복구 실패는 **원인별로 다른 카운터**에 들어간다. `ringEscalation` 은 오직 backend 가 `null` 을
  답한 경우만 세며, 아래 재검토 조건이 그 칸 하나에만 걸려 있기 때문에 다른 사건을 섞으면 결정을
  검증할 수단이 사라진다. 복구 구간 뒤에 또 구멍이 있으면 `nestedGap`, resize 를 가로지르면
  `geometryEscalation`, 서브 payload 검증 실패는 `malformedDelta`, 그 외 거절·예외는
  `repairFailure` 다. 분류는 오류 **메시지 매칭이 아니라** round-trip 의 실패 지점과
  `TerminalOutputRepairError.reason` 으로 결정한다 — 리터럴 하나가 바뀌어도 조용히 오분류되지
  않아야 한다.
- 테스트는 (1) ring 이 보존하는 gap 의 sequence-exact 복구, (2) ring 이 밀린 gap 의 `null` 승격,
  (3) generation 교체 시 `null`, (4) 복구 중 도착한 delta 의 중복·경계 교차 정리, (5) geometry
  revision 을 가로지르는 gap 의 재부착 승격, (6) gap 이 `terminal.reset()` 을 유발하지 않고 shadow
  cursor 상태도 보존한다는 회귀, (7) 다섯 실패 원인이 각각 자기 카운터에만 들어간다는 검증을
  담당한다. (5)(6)(7) 은 모두 "전체 재부착"이라는 같은 가시적 결과로 끝나므로 attach 호출 수만
  보는 단정으로는 오분류를 잡을 수 없다.
- **현 harness 로 검증할 수 없는 주장 두 개**는 후속 이슈 #605(실제 xterm 인스턴스를 쓰는 셀 격자
  harness)로 분리한다. 데스크톱 터미널 테스트가 xterm 을 mock 하므로 (a) "차분 렌더 프레임
  시퀀스가 복구 뒤 원래 화면과 셀 단위로 같아진다", (b) "복구 구간 안의 `?2026l` 이 파서를 타고
  래치를 닫는다" 둘 다 지금은 단정할 수 없다. mock 에서는 write 가 파서에 닿지 않아 CSI handler 를
  직접 호출해야 하고, 그러면 "핸들러를 부르면 래치가 닫힌다"는 동어반복만 검증된다. 현재 회귀
  테스트가 실제로 고정하는 것은 "복구가 래치를 미리 닫지도, 닫을 수 없게 만들지도 않는다" 이다.
- **실기 스트레스에서 복구 경로는 한 번도 발화하지 않았다.** dev 인스턴스(19281) 실측: base64
  폭주 약 30 MB(ring wrap), `yes` 2 pane 동시 25초 + 프론트 동기 버퍼 덤프 120회, 폭주 중 resize
  12회 + 워크스페이스 flip 3회 — 세 시나리오 모두 gap 0, `repair`/`ringEscalation`/
  `geometryEscalation`/`malformedDelta`/`attachFailure` 전부 0, backend `discarded_total`·
  `dropped_total` 로그 0줄. 프론트는 매번 끝까지 수신했다(`baseY=10000`). 계측 브리지는 양성
  대조로 검증했으므로 "이벤트 없음"이 맞고 "계측 고장"이 아니다. 위 Context 의 결론(무한 용량
  event-loop proxy 라 출력량만으로는 delta 를 잃지 않는다)과 일치한다. 따라서 이 결정의 값은
  "폭주 시 흔한 유실을 막는 것"이 아니라 **어떤 원인으로든 gap 이 생겼을 때 그것이 영구 셀 손실로
  번지지 않게 하는 것**이며, 카운터는 계속 실사용에서 관측해야 한다.
- 이 스트레스 측정에서 별개 결함을 찾았다: 폭주와 레이아웃 변경이 겹치면 프론트가 42~87초
  무응답이다(폭주 단독 0초, resize 단독 0초). 워크스페이스 flip 이 2배 나쁜 것은 재부착마다 1 MiB
  snapshot replay 를 새 xterm 에 다시 넣기 때문으로 보인다. issue #606 으로 분리했고 이 결정의
  범위 밖이지만, 재부착 비용을 줄이는 방향(복구 경로 확대·checkpoint 재사용)과 맞닿아 있다.
- 재검토 조건: 승격 카운터(ring 밀림 / geometry 교차)가 실사용에서 유의미하게 잡히거나, Tauri
  가 event 전달을 bounded 채널로 바꾸면 이 결정의 Context 전제가 무너진다.
