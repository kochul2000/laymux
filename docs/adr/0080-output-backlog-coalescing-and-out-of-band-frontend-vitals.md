# 0080. 출력 백로그는 세그먼트가 아니라 바이트로 값을 치르고, 프론트 상태는 브리지 밖에서 읽는다

- Status: Accepted
- Date: 2026-07-28
- Source: 사용자 보고(출력 폭주 중 레이아웃 변경 시 프론트 42~87초 무응답) · issue #606 · [architecture/data-flow.md §8.4·§8.8](../architecture/data-flow.md) · [architecture/api-contracts.md §12](../architecture/api-contracts.md) · [ADR-0026](0026-conpty-width-resize-repaint-filter.md) · [ADR-0069](0069-remote-render-checkpoint-attach.md) · [ADR-0072](0072-terminal-output-gap-sequence-exact-repair.md)
- Relation: ADR-0026 의 공통 fit 스케줄러와 1 MiB 청크 write FIFO 를 유지하면서 그 앞단에 백로그 병합 단계를 추가하고, quiet window 의 기준 시각을 "write 시각"에서 "delta 도착 시각"으로 정정한다. ADR-0072 의 sequence 정확 복구 계약과 ADR-0069 의 checkpoint 경계(generation·geometry revision)는 병합 금지 경계로 그대로 보존한다. ADR-0002 의 Automation API 에 프론트를 경유하지 않는 진단 엔드포인트 하나를 추가한다.

## Context

출력이 폭주하는 pane 이 있는 상태에서 레이아웃을 바꾸면 프론트엔드가 42~87초 동안 무응답이 된다. 백엔드는 멀쩡하다 — `/api/v1/health` 는 즉시 답하는데 프론트를 경유하는 모든 endpoint(`/grid`, `/terminals`, `/terminals/{id}/buffer`)가 `Frontend response timeout` 을 낸다. 폭주 단독(0초)도 레이아웃 변경 단독(0초)도 정상이며, 둘이 겹칠 때만 터진다. 폭주가 끝난 뒤에도 무응답이 이어진다. ADR-0072 의 복구 카운터 10종과 backend `discarded_total`/`dropped_total` 은 같은 스트레스에서 전부 0이었으므로 **정확성 결함이 아니라 비용 결함**이다.

issue #606 은 원인을 "워크스페이스 전환이 `TerminalView` 를 unmount/remount 시키고 재부착마다 1 MiB ring snapshot 을 replay 한다(flip 3회 = 6회)"로 추정했다. **코드는 그렇지 않다.** `WorkspaceArea` 는 한 번 활성화된 워크스페이스를 계속 마운트해 둔 채 `display:none` 으로만 감추고, `PaneGrid` 도 pane 박스에 같은 처리를 한다. `TerminalView` 의 xterm/PTY 수명은 `[instanceId, profile, …]` 에 달려 있고 `resizePane` 은 pane id 를 보존한다. 따라서 워크스페이스 전환도 pane resize 도 remount 를 유발하지 않으며, `TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES` replay 는 두 경로 어디에도 없다. 남는 것은 hide→show 복귀의 atlas 재생성과 공통 fit 스케줄러를 통과하는 fit 하나다.

그래서 실제 비용은 **레이아웃 작업 자체의 절대량**이 아니라, 이미 포화 상태인 파이프라인에 그 작업이 끼어들 때 생기는 백로그다. 프론트가 delta 하나를 적용할 때마다 크기와 무관한 고정 비용을 낸다 — `terminal.write` 와 그 parse 콜백, ADR-0069 checkpoint xterm 의 별도 write, stabilizer push, `TextDecoder` 라운드, 그리고 activity/Codex/Claude 감지기의 1 KiB·16 KiB 롤링 윈도 전체 스캔. 폭주는 같은 바이트를 수천 개의 작은 delta 로 전달하므로 이 상수가 메인 스레드를 채운다. 메인 스레드가 채워지면 `automation-request` 이벤트는 같은 WebView 전달 큐에서 그 뒤에 줄을 서고, 5초 예산은 큐에서 소진된다.

무응답의 정체를 코드로 가릴 수 없었던 이유도 분명하다. `bridge_request` 는 emit 시각에 5초 타이머를 걸고, 프론트는 그 마감 시각을 **모른다**. 마감을 넘겨 도착한 응답은 `automation_response` 가 조용히 버린다 — 프론트는 이미 답을 만드는 데 메인 스레드를 다 쓴 뒤이고, 양쪽 어디에도 그 사실이 기록되지 않는다. 그래서 "핸들러가 느린 것"과 "요청이 큐에 밀린 것"을 구분할 관측 수단이 없었고, 폴링 재시도는 같은 큐 뒤에 죽은 일감을 더 쌓았다.

범위는 데스크톱 프론트엔드의 sequenced output 적용 경로, 공통 fit 스케줄러의 quiet window 기준, 그리고 Automation 브리지의 마감/관측이다. PTY ring, sequence 계약, 복구 정책, 커서 게이트는 바꾸지 않는다.

## Decision

**출력 백로그는 세그먼트 단위가 아니라 바이트 단위로 값을 치른다. 그리고 프론트엔드의 상태는 프론트엔드를 경유하지 않는 경로로 읽는다.**

- **backpressure 게이트 병합.** 이미 sequence 가 확정된 세그먼트는 `TerminalOutputApplyQueue` 를 지나 표면에 닿는다. 표면이 한가하면(`pendingTerminalWrites === 0` 이고 write FIFO 가 비었으면) 즉시 적용해 대화형 지연을 바꾸지 않고, 표면이 밀려 있으면 붙들었다가 **이미 진행 중인 write 가 끝나는 시점**에 병합해서 넣는다. 트리거는 타이머가 아니라 backpressure 다 — 지연 상한은 진행 중인 parse 이고, 배치 크기는 표면이 밀린 만큼만 자란다.
- **병합 금지 경계.** generation 변경, geometry revision 변경, sequence 불연속, 1 MiB(`TERMINAL_WRITE_CHUNK_SIZE`) 에서 병합을 거부한다. geometry 경계는 ADR-0069 checkpoint 모델이 그 사이에서 resize 해야 하는 지점이고 ADR-0072 가 복구를 거부하는 지점과 같다. sequence 구멍은 gap 논리에 계속 보여야 한다. 병합된 세그먼트의 `seqStart`/`seqEnd` 는 자기가 실은 바이트를 정확히 서술하므로 coordinator 와 checkpoint 모델의 단정에 그대로 통한다.
- **순서는 전순서 하나다.** 도착 순서 큐 하나만 두어, 복구 범위가 자신이 앞에 splice 하는 delta 보다 먼저 표면에 닿는다. 전체 재부착은 `reset()` + ring replay 로 화면을 새로 만들므로 큐를 비운다.
- **fit 이 출력보다 먼저다.** write 가 끝난 시점에는 보류된 fit 을 먼저 흘려보내고 그다음에 병합 배치를 넣는다. 그렇지 않으면 지속 폭주가 fit 을 무한히 굶길 수 있고, fit 을 먼저 처리하면 그 사이에 배치가 더 커져 병합 효율도 올라간다.
- **quiet window 는 도착 시각으로 잰다.** ADR-0026 의 Windows output quiet window 는 "최근에 PTY 출력이 도착하지 않았다"는 뜻이므로 delta 도착 시점에 기록한다. write 시점에 기록하면 큐에 붙들린 세그먼트가 침묵으로 읽혀, 아직 옛 격자를 향한 출력이 큐에 남은 상태에서 fit 이 풀린다.
- **query 는 마감을 넘기면 버리고 action 은 실행한다.** `automation-request` 에 `emittedAtMs`·`deadlineMs` 를 실어 보낸다. 마감을 넘긴 **query** 는 계산하지 않고 즉시 거절한다 — 답이 닿을 상대가 없으므로 계산은 밀린 프론트의 시간만 빼앗고, 클라이언트 재시도가 그 일감을 더 쌓는다. 마감을 넘긴 **action** 은 그대로 실행한다 — 부수효과는 여전히 호출자가 요청한 것이며, 조용히 버리면 "느린 resize" 가 "일어나지 않은 resize" 가 된다.
- **프론트 상태는 out-of-band 로 읽는다.** WebView 가 타이머로 자기 vitals(probe 지연·stall 수·브리지 카운터·terminal 별 파이프라인 카운터)를 Rust 상태로 밀어 넣고, `GET /api/v1/diagnostics/frontend` 가 브리지 왕복 없이 그것을 서빙한다. 1차 신호는 마지막 보고의 **나이**(`lastReportAgeMs`) 다 — 큰 값은 메인 스레드가 멈춘 것이고, 작은 값 옆에서 `bridge.requestTimeouts` 만 오르면 스레드는 살아 있고 이벤트가 큐에 밀린 것이다. 마감을 넘겨 도착한 응답은 조용히 버리지 않고 `responsesOrphaned` 로 세고 누적 총계와 함께 로그로 남긴다.
- **파이프라인 카운터는 진단 전용이다.** ADR-0072 의 복구 카운터와 같은 규율을 따른다 — 어떤 제어 경로도 읽지 않고, 수명은 백엔드 세션 하나이며 `close_terminal_session` 이 지운다.

## Alternatives Considered

- **워크스페이스 전환에서 재부착을 없앤다 / replay 예산 상한을 둔다**: issue #606 이 지목한 후보지만 **그 경로에 재부착이 없다.** 전환은 `display:none` 토글이고 xterm·PTY 는 계속 산다. `attachReplayBytes`·`attaches` 카운터를 남겨 이 판정을 실기에서도 확인할 수 있게 했다.
- **delta 를 시간 창(microtask/rAF/타이머)으로 묶는다**: Tauri 는 이벤트마다 별도 스크립트를 실행하므로 microtask 창으로는 아무것도 묶이지 않고, 타이머 창은 한가할 때도 대화형 출력에 지연을 더한다. backpressure 는 비용이 실제로 발생한 순간에만 병합한다.
- **PTY 출력을 백엔드에서 더 큰 청크로 합쳐 emit 한다**: 전달 비용은 줄지만 폭주 단독이 이미 0초이므로 관측된 결함의 원인이 아니고, ADR-0072 의 sequence·gap 계약과 backend ring 타이밍을 함께 건드린다. 프론트 상수를 먼저 줄이고, 파이프라인 카운터가 전달 병목을 지목하면 그때 별도 결정으로 다룬다.
- **브리지 타임아웃을 늘린다**: 5초는 이미 `LONGEST_HANDLER_WAIT`(3.5초) 위에 잡힌 값이다. 42~87초를 덮으려면 예산이 무의미해지고, 스톨을 감추기만 한다.
- **`automation-request` 를 전용 채널로 옮긴다**: 전달 큐의 head-of-line 은 줄겠지만 핸들러가 도는 스레드가 같으므로 스톨 자체는 남고, IPC 계약이 하나 늘어난다. 먼저 스레드를 비우는 쪽을 택했다.
- **마감을 넘긴 요청을 종류 구분 없이 모두 버린다**: 구현은 더 단순하지만 늦게라도 반영되던 action 이 사라져 자동화의 의미가 바뀐다.

## Consequences

- 폭주 중 도착한 delta 수천 개가 한 번의 `terminal.write`·한 번의 checkpoint write·한 번의 감지기 스캔으로 정리되므로, 레이아웃 변경이 만든 블로킹이 회복 불가능한 백로그로 증폭되지 않는다. 한가한 표면의 지연은 변하지 않는다(첫 delta 는 즉시 통과).
- 복구 단정은 **write 횟수**가 아니라 **바이트 스트림**의 계약이 된다. 복구 범위와 그 뒤 delta 가 한 write 로 합쳐지므로, 기존 테스트의 write 단위 단정을 스트림 단위로 옮겼다. 이후 배치 정책이 바뀌어도 같은 단정이 유지된다.
- geometry revision 경계가 병합 경계이므로 resize 가 잦으면 병합 효율이 떨어진다. 이는 의도된 안전 쪽 절충이다 — checkpoint 모델이 그 경계에서 resize 해야 한다.
- `/api/v1/diagnostics/frontend` 는 노출 표면을 하나 늘린다. 응답은 카운터와 지연 수치뿐이고 터미널 바이트·경로·설정을 담지 않으며, 기존 IP allowlist 아래 있다.
- probe 는 250 ms 주기로 돌고 보고는 1초에 한 번(또는 500 ms 이상 지연된 tick 직후)이므로 IPC 부하가 상시로 조금 늘어난다. 대신 스톨을 **일어나는 중에** 읽을 수 있다.
- 마감을 넘긴 query 는 이제 `Frontend request expired` 로 거절되지만, 그 HTTP 호출자는 이미 `504` 를 받은 뒤다 — 외부 계약은 바뀌지 않는다.
- 테스트는 (1) 병합 산술과 금지 경계, (2) 실제 xterm 에서 병합 전후 셀 격자 동일성(escape 분할·wrap/scrollback·전각·alternate buffer 포함, [ADR-0074](0074-xterm-cell-grid-screen-test-tier.md) 계층), (3) 표면이 밀린 동안 도착한 delta 가 한 write 로 합쳐진다는 컴포넌트 계약, (4) 재부착 시 큐 폐기, (5) 마감 넘긴 query 거절 / action 실행, (6) 진단 스냅샷의 브리지 카운터와 보고 나이를 고정한다.
- 재검토 조건: `segmentsIn / segmentsOut` 비가 1 에 가까운데도 스톨이 남으면 병합이 잘못된 층에 있다는 뜻이고, `lastReportAgeMs` 는 작은데 `requestTimeouts` 만 오르면 전달 큐 분리(위 기각안)로 넘어가야 한다.
