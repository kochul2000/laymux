# 0182. Remote 스크롤 최상단은 더 깊은 screen checkpoint를 요청해 이전 출력을 받아온다

- Status: Accepted
- Date: 2026-08-19
- Source: 사용자 보고("스크롤 상단에 도달할 때 이전 정보를 받아오지 못한다") · [ADR-0069](0069-remote-render-checkpoint-attach.md) · [ADR-0159](0159-android-e2e-websocket-output-transport.md) · [architecture/api-contracts.md §13](../architecture/api-contracts.md)
- Relation: ADR-0069의 attach 계약을 확장한다. checkpoint 예산을 attach마다 고정된 owner 설정값으로만 정하던 결정을, controller가 같은 범위 안에서 더 큰 예산을 요청할 수 있게 정정한다. ADR-0159의 Android E2E open record에 선택 필드를 추가한다.

## Context

Remote attach는 데스크톱의 rendererless xterm을 직렬화한 screen checkpoint에서 시작한다(ADR-0069). 그 checkpoint에 담기는 scrollback 양은 `remote.snapshotMaxKib`(기본 4 KiB, 1~1024 KiB clamp) 예산 안에서 최대한 많은 줄을 고르는 이진 탐색으로 정해진다. 기본값에서는 현재 화면과 약간의 scrollback만 담기므로, Remote에서 위로 스크롤하면 몇 줄 만에 버퍼 맨 위에 닿고 그 위는 존재하지 않는다. 데스크톱에는 남아 있는 출력인데도 Remote는 받아올 방법이 없다.

예산 기본값을 크게 올리면 모든 attach가 느려지고 pane 전환마다 큰 화면을 전송한다. attach는 워크스페이스 전환·재접속마다 일어나므로 이 비용은 상시 비용이다. 반대로 브라우저 xterm에 이전 줄을 "앞에 끼워 넣는" API는 없다. xterm buffer는 위쪽으로 확장할 수 없고, 이전 내용을 붙이려면 버퍼를 다시 만들어야 한다.

범위는 Direct·Cloud·Android E2E 세 transport의 Remote output attach와 Remote page의 스크롤 처리다. 데스크톱 xterm의 scrollback 보존량(checkpoint 모델의 10,000줄), PTY output ring, lease/권한 모델, desktop output v3 계약은 바꾸지 않는다.

## Decision

**Remote는 스크롤 최상단에서 더 큰 checkpoint 예산으로 같은 terminal에 재attach하고, 그 결과 화면을 live tail 기준 같은 오프셋에 복원한다.**

- output attach 요청은 선택적 history 예산을 담는다. Direct·Cloud는 output WebSocket 쿼리 `historyKib`, Android E2E는 암호화된 open record의 `historyKib` 필드다. 값이 없으면 기존과 동일하게 owner 설정 예산으로 attach한다.
- 서버는 요청 예산을 신뢰하지 않는다. 실제 예산은 `max(effective(remote.snapshotMaxKib), clamp(historyKib, MIN..=MAX))`이며, 요청은 owner 설정 예산을 **올릴 수만** 있고 내릴 수 없다. 상한은 기존 `MAX_REMOTE_SNAPSHOT_MAX_KIB`(1024 KiB)이고 checkpoint 절대 상한 1 MiB는 그대로 적용된다. 새 설정 키는 만들지 않는다. 파싱 불가능한 요청 값은 세 transport 모두 fail-open으로 owner 예산 attach가 되며, attach 자체를 거절하지 않는다.
- 예산이 커져도 attach 경로는 ADR-0069 그대로다. checkpoint는 같은 generation/geometry 검증과 raw suffix 원자 결합을 거치며, 별도의 "scrollback 조회" 엔드포인트나 두 번째 상태 소유자를 만들지 않는다.
- client는 owner 설정 예산을 알 수 없으므로, 다음 요청을 **지금 들고 있는 화면의 크기에서 유도**한다: `clamp(현재 snapshot bytes × 4, 64 KiB, 1024 KiB)`. N 바이트짜리 화면은 최소 N 바이트 예산에서 나왔으므로 그 배수 요청은 알 수 없는 owner 예산 위로 올라간다. 고정 사다리는 `snapshotMaxKib`가 그 첫 단계 이상인 모든 설정에서 아무 일도 하지 않고 소진으로 오판한다.
- 최상단 신호는 위쪽 터치 드래그, 위쪽 wheel, 그리고 xterm `onScroll`의 "viewportY가 0으로 *도달*" 세 곳이다. 앞의 둘은 그 자체가 사용자 제스처다. `onScroll` 도달은 최근 위쪽 스크롤 제스처(위쪽 wheel·위쪽 드래그·xterm이 직접 처리하는 Shift+PageUp)가 보증할 때만 인정한다 — 출력은 scrollback이 잘릴 때 멈춰 있던 viewport를 스스로 0까지 밀어 내리기 때문이다. 포인터 누름은 보증으로 치지 않는다. 선택 드래그도 자동 스크롤로 0에 닿는데, 드래그 중 화면을 갈아 끼우면 만들던 선택이 사라진다. replay 중(`terminalReplayDepth > 0`)과 viewport 복원 중의 이동도 사용자 신호가 아니며, 연결 중단 알림이 떠 있는 동안에는 요청하지 않는다.
- 요청 자격은 "제스처가 실제로 scrollback을 스크롤하는 상태"와 같다: normal buffer이면서 mouse tracking이 아닐 때만이다. alternate buffer에는 scrollback이 없고, mouse tracking 중에는 스크롤이 앱으로 전달된다.
- 확장 attach는 `reconnect` 경로와 같은 surface 규칙을 따른다. 새 snapshot을 완전히 검증한 뒤에 reset/replay하고, replay 직전에 캡처한 live tail 기준 행 오프셋을 복원한다. 따라서 사용자가 읽던 줄은 자리를 지키고 그 위로 이전 출력이 생긴다. 입력 surface는 focus하지 않는다.
- terminal이 확장에서 빠지는 경로는 셋이다. (1) 더 큰 예산으로 받은 snapshot이 직전보다 크지 않을 때(아래), (2) 이미 client 상한으로 요청했고 다음 요청도 상한을 넘어 계산되며 직전 checkpoint가 그 예산을 채웠을 때 — 데스크톱에는 더 있을 수 있으나 이 client가 더 큰 checkpoint를 요구할 수 없으므로 attach 없이 별도 문구로 알린다. 예산을 못 채운 checkpoint는 데스크톱이 먼저 바닥난 것이므로 (1)과 같은 문구를 쓴다, (3) 상대가 `snapshotKind` 없는 legacy 무순번 host일 때. 세 경로 모두 연결 중단 알림이 떠 있으면 문구를 덮어쓰지 않는다.
- "더 이상 없음" 판정은 전달된 snapshot의 **바이트 수**로 한다. 더 큰 예산으로 받은 snapshot이 직전보다 크지 않으면 그 예산에서 데스크톱이 줄 수 있는 이전 출력이 없다는 뜻이므로, 해당 terminal에서 더 요청하지 않고 사용자에게 알린다. 버퍼 행 수는 replay가 checkpoint geometry에서 일어나고 그 뒤 fit이 reflow하므로 두 attach 사이에 비교할 수 없다. snapshot에는 subscribe 경계에서 붙는 raw suffix가 포함되므로 live 출력이 이 비교에 잡음을 준다. 잡음은 대개 크기를 키우므로 "더 있다"는 재요청 1회로 끝난다. 반대 방향 오판(있는데 없다고 판정)은 pane 전환이나 연결 해제까지 유지된다 — 재접속은 소진 상태를 지우지 않는다.
- 확장 요청은 자기 attach의 snapshot만 정산한다. 요청 id를 attach에 실어 보내고 그 snapshot만 판정에 쓰며, 그 사이 끼어든 attach(재접속·pane 전환·조기 실패·소켓 종료·타임아웃)는 요청을 **취소**한다. 소진 판정은 낮은 예산에서 온 증거로 내려서는 안 된다. 취소는 예산도 요청 직전 값으로 되돌린다 — 올린 예산으로 화면이 온 적이 없으므로, 올린 채로 두면 다음 요청이 같은 값으로 계산돼 "더 없음"으로 오판한다.
- 예산과 소진 여부는 attach 대상 terminal에 귀속된다. pane을 바꾸거나, 세션을 끊거나, 사용자가 직접 다시 attach하면(같은 pane 재선택 포함) owner 기본 예산에서 다시 시작한다 — 그런 attach는 어차피 live tail에 착지한다. 확장 예산을 이어 쓰는 것은 자동 재접속뿐이며, 소켓이 연속으로 열리지 않으면 owner 예산으로 내려가면서 소진 상태도 함께 푼다. 링크가 불안정할 때 몇 초마다 1 MiB checkpoint 직렬화를 데스크톱에 다시 시키지 않기 위해서다.
- 구버전 Android 커넥터(`LaymuxNative.supportsOutputHistoryBudget()` 없음)에는 요청을 아예 보내지 않는다. 커넥터가 알 수 없는 open record 필드를 거부하기 때문이며, 그 환경에서는 기능만 비활성화되고 attach는 그대로 동작한다. 커넥터는 범위 밖 값을 stream 실패로 만들지 않고 "확장 없음"(0)으로 떨어뜨린다 — 최대치로 올리지 않는다.
- `snapshotKind`가 없는 legacy 무순번 host는 attach 전에 알 수 없다. 요청 1회를 쓴 뒤 그 응답에서 확인하고 해당 surface를 확장 대상에서 제외한다.

## Alternatives Considered

- **`remote.snapshotMaxKib` 기본값을 크게 올린다**: 모든 attach·pane 전환이 상시로 느려지고 전송량이 커진다. 사용자가 실제로 위로 스크롤할 때만 필요한 비용이다.
- **scrollback 범위 전용 엔드포인트를 만들고 브라우저에서 앞에 붙인다**: xterm에는 buffer 앞에 줄을 끼우는 API가 없어 결국 reset/replay가 필요하다. 그러면 checkpoint와 별개인 두 번째 화면 상태 소유자와 live delta 정합 문제가 생긴다.
- **client가 받은 모든 bytes를 보관했다가 history + 재생으로 재구성한다**: 메모리 사용이 세션 출력량에 비례해 무한히 늘고, 모바일에서 특히 위험하다.
- **checkpoint 응답에 `scrollbackTruncated` 플래그를 추가한다**: 판정은 더 정확하지만 checkpoint 타입·attach state·wire header·세 transport·Android 커넥터까지 계약을 넓혀야 한다. 바이트 비교로 같은 사용자 경험을 얻을 수 있어 계약을 넓히지 않았다.
- **고정 사다리(64 → 256 → 1024 KiB)로 올린다**: 구현은 가장 단순하지만 owner가 `snapshotMaxKib`를 첫 단계 이상으로 올려 둔 순간 첫 요청이 owner 예산과 같아진다. 같은 화면이 돌아오고 소진으로 오판해 기능이 죽는다. 화면 크기에서 유도하면 owner 예산을 몰라도 항상 그 위를 요청한다.
- **데스크톱이 사용한 예산을 snapshot attach state에 실어 client에 알려준다**: 사다리 시작점을 정확히 정할 수 있지만 세 transport와 Android 커넥터를 지나는 wire 계약을 넓혀야 한다. 화면 크기 유도로 같은 결과를 얻어 계약을 넓히지 않았다.
- **위로 스크롤할 때마다 자동으로 예산을 계속 키운다**: 상한 없이 키우면 한 번의 제스처가 1 MiB 직렬화를 반복 유발할 수 있다. 단계 상한과 소진 판정으로 재요청을 끝낸다.

## Consequences

- 기본 4 KiB 예산에서도 사용자가 위로 스크롤하면 이전 출력을 볼 수 있고, 최대 1 MiB 직렬화 분량(데스크톱 checkpoint 모델의 10,000줄 보존 범위 내)까지 거슬러 올라간다. 그보다 오래된 출력은 여전히 볼 수 없다.
- 확장 1회는 output WebSocket 재연결 1회와, 데스크톱 WebView 메인 스레드에서 도는 checkpoint 직렬화 1회분을 유발한다. 그 1회분은 예산에 맞는 최대 scrollback을 찾는 이진 탐색이라 최대 1 MiB 화면을 십수 번 직렬화하며, attach race가 나면 최대 3회 재시도된다. 그래서 확장은 사용자가 최상단에서 명시적으로 더 볼 때만 일어나고, 자동 재접속은 몇 회 뒤 owner 예산으로 내려간다.
- 재attach 중에는 live delta가 새 subscriber 경계에서 다시 시작한다. 기존 재접속 경로와 같은 계약이므로 추가 정합 규칙은 없다.
- 예산을 client가 올릴 수 있으므로 `remote.snapshotMaxKib`는 "기본 예산"이자 하한이 되고, 노출 상한은 기존 clamp 상한이 맡는다. lease를 가진 controller는 이미 terminal에 입력할 수 있어 scrollback 노출 경계가 새로 낮아지지는 않는다.
- 테스트는 (1) 예산 요청이 owner 설정을 올리기만 하고 범위를 벗어난 값은 clamp하는지, (2) output 쿼리·Android open record의 선택적 `historyKib` 파싱과 fail-open, (3) 최상단 도달 시 더 깊은 checkpoint로 재attach하고 viewport 오프셋이 유지되는지, (4) 더 이상 이전 출력이 없을 때 재요청이 멈추는지, (5) owner 예산이 client 최소 요청 단계 이상일 때도 확장이 되는지, (6) alternate buffer에서는 요청하지 않는지, (7) 재접속이 확장 예산을 유지하고 pane 전환은 owner 예산으로 되돌리는지를 검증한다.
