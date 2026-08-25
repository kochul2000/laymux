# 0204. 제어 근거로 거절된 Remote 요청은 lease 를 재검증하고, 돌아온 탭은 쥔 lease 를 즉시 프로브한다

- Status: Proposed
- Date: 2026-08-25
- Source: 사용자 신고("리모트 우상단 폴더 아이콘 누르면 remote file viewer capability is required or invalid, 켜자마자 다시 눌러도 똑같이 실패"), [ADR-0042](0042-remote-file-viewer-secret-capability.md), [ADR-0027](0027-remote-connection-graceful-recovery.md), [ADR-0037](0037-remote-lease-takeover-and-pagehide-release.md), [ADR-0198](0198-remote-file-explorer-overlay.md), [architecture/api-contracts.md §Remote FileViewer](../architecture/api-contracts.md)
- Extends: ADR-0042, ADR-0037

## Context

FileViewer capability 는 lease 당 하나 발급되고, 서버는 **모든 owner transition 에서 이를 폐기**한다(ADR-0042 — 자발적 release handoff 에서도 보존하지 않는다). 즉 lease 가 죽으면 capability 도 같이 죽는다. 그런데 클라이언트는 두 값을 각각 메모리에 들고 있고, 폴더 버튼의 노출 조건은 `leaseId && fileViewerToken` 둘 다 존재하는지뿐이다.

문제는 클라이언트가 lease 의 죽음을 **heartbeat 실패로만** 알게 된다는 점이다. `handleHeartbeatError` 가 `loseRemoteControl` 을 부르고 거기서 상태를 정리한다. 그래서 heartbeat 이 돌지 못한 구간에서는 페이지가 죽은 lease 를 쥐고도 살아 있는 것처럼 보인다. 모바일 브라우저가 백그라운드 탭을 얼리면 5초 heartbeat 타이머 자체가 멈추므로 이 구간이 실제로 자주 만들어진다. heartbeat timeout 하한은 30초(`MIN_REMOTE_HEARTBEAT_TIMEOUT_SECONDS`)이므로 다른 앱을 30초 보는 것으로 충분하다. 클라우드 터널은 `cloudEnabled`·`cloudAutoReconnect`·`cloudAccessMode` 가 모두 settings.json 에 영속이라 그동안 알아서 붙어 있어, 사용자에게는 "연결은 되어 있는데 파일만 안 되는" 상태로 보인다.

이 상태에서 사용자가 폴더 버튼을 누르면 두 가지가 겹쳐서 나빠진다.

1. 서버는 `403 remote file viewer capability is required or invalid` 로 fail closed 한다. 클라이언트는 그 문구를 **파일 수준 에러처럼** 오버레이에 그대로 띄운다. 사용자가 받는 설명이 "capability 가 없거나 잘못됨"인데, 실제 사실은 "제어권이 만료됐다"다. 다시 눌러도 같은 문구가 반복되고 페이지는 계속 연결된 척한다.
2. 탭이 다시 보이게 될 때 `visibilitychange` 는 `maybeAutoConnect()` 만 부른다. 이 함수는 **없는 lease 를 claim** 하는 경로여서 `leaseId` 가 남아 있으면 즉시 반환한다. 그래서 복귀 직후에는 아무 검증도 일어나지 않고, heartbeat 인터벌이 다음에 우연히 도는 순간까지 죽은 lease 가 그대로 유지된다. Android 네이티브 transport 의 resume 경로는 이미 `if (leaseId) heartbeat()` 로 이 프로브를 하고 있어, 브라우저 경로만 빠져 있었다.

dev 인스턴스에서 재현·확인했다. claim 직후 `/file-viewer/list` 는 200 이고, heartbeat 를 35초 끊으면 `/session/status` 가 `active:false` 가 되며 같은 lease+capability 로 보낸 `list` 가 정확히 그 403 문구로 실패한다. 즉 서버 계약은 의도대로 동작하고, 결함은 **클라이언트의 lease 수명 인식**에 있다.

범위는 Remote 페이지가 제어권 상실을 알아내는 시점과 그때 사용자에게 주는 설명이다. 서버의 capability 계약(발급·폐기·이중 검증), 소유권 정책(ADR-0027 의 "상실 후 자동 재탈취 금지"), heartbeat 하한, 오버레이 UI 구조는 비목표이며 그대로 둔다.

## Decision

**제어 근거로 거절된 FileViewer 요청은 파일 에러가 아니라 lease 에 대한 답으로 취급한다. 그리고 탭이 다시 보이게 되면 쥐고 있던 lease 를 즉시 프로브한다.**

### 제어 근거 실패는 소유권을 되묻는다

- FileViewer/Explorer 요청이 `401`·`403`·`409`(`isFatalRemoteControlError`)로 실패하면 `/remote/v1/session/status` 로 **소유권을 한 번 되묻는다**. 응답의 `leaseId` 가 이 탭의 lease 와 다르면 lease 는 죽은 것이고, 같으면 lease 는 살아 있으므로 원래 에러를 그대로 보여준다.
- 프로브는 heartbeat 가 아니라 `/session/status` 다. `heartbeat()` 는 이미 하나가 진행 중이면 **아무것도 묻지 않고 resolve** 하므로, 그 결과를 "lease 정상"으로 읽으면 오답이 된다.
- 프로브 자체가 실패하면 판단하지 않고 원래 에러를 보여준다. 프로브는 조언이지 게이트가 아니다.
- lease 가 죽었다고 판정되면 heartbeat `409` 와 **같은 등급으로** 처리한다: `hostTookOver: false` 로 `loseRemoteControl` 을 부른다. lease 가 사라졌다는 사실과 "지금 누가 쥐고 있나"는 다른 질문이고, 후자는 다음 claim 이 답한다(ADR-0027·ADR-0037). 즉 재연결 의사는 유지된다.
- 상실이 확정되면 그 요청은 **화면에 아무것도 쓰지 않는다.** `loseRemoteControl` → `disconnect` 가 오버레이를 닫고 자기 notice 를 그리므로, 파일 수준 메시지를 덧쓰면 이미 철거된 표면에 쓰는 셈이다.
- ambient path-link 트리거는 이 경로에 넣지 않는다. 사용자가 지목하지 않은 유휴 화면 스캔이 실패할 때마다 소유권을 되묻게 되면 프로브가 폴링이 된다.

### 돌아온 탭은 쥔 lease 를 프로브한다

- `visibilitychange`(visible)·`pageshow`·`online` 은 `resumeControlOnReturn()` 을 부른다. `leaseId` 가 없으면 기존대로 `maybeAutoConnect()`, 있으면 **즉시 heartbeat** 를 보내고 실패는 `handleHeartbeatError` 로 넘긴다.
- 이는 Android transport resume 이 이미 하던 것과 같은 동작이며, "백그라운드에서는 claim 하지 않는다"는 규칙은 그대로다 — 프로브는 자기 lease 의 생존 확인일 뿐 새 claim 이 아니다.

## Alternatives Considered

- **403 을 받으면 곧바로 재claim 한다.** 한 번에 복구되지만 ADR-0027 의 "상실 후 자동 재탈취 금지"를 깬다. 그 사이 호스트나 다른 기기가 정당하게 제어권을 쥐었을 수 있고, 파일 하나 열려던 탭이 그것을 빼앗게 된다.
- **403 을 `loseRemoteControl(hostTookOver: true)` 로 처리한다.** 코드가 가장 짧지만 의미가 틀리다. `401/403` 을 "definitive answer"로 보는 기존 분류는 *heartbeat* 의 401/403(토큰 불량, 원격 접근 off)에 대한 것이고, FileViewer 의 403 은 만료된 lease 에도 붙는다. 재연결 의사를 꺼버려 사용자가 수동으로 다시 붙어야 한다.
- **capability 를 lease 와 함께 sessionStorage 에 보관해 복귀 시 재사용한다.** 프로브가 필요 없어지지만 ADR-0042 의 전제(capability 는 메모리 밖으로 나가지 않는다)를 깨고, 서버가 이미 폐기한 값을 되살릴 수도 없다.
- **heartbeat 간격을 줄이거나 timeout 하한을 올린다.** 창을 좁힐 뿐 없애지 못한다. 얼린 탭에서는 어떤 간격도 돌지 않고, 하한을 올리면 죽은 소유자가 제어권을 더 오래 붙잡는다.
- **오버레이에 "재연결 중" 문구를 남긴다.** 친절해 보이지만 상실 경로가 오버레이를 닫으므로 보이지 않는 문구가 된다. 상태 표시는 상실 경로 한 곳이 소유해야 한다.

## Consequences

- 얼린 탭에서 돌아와 폴더 버튼을 눌러도 capability 문구를 보지 않는다. 죽은 lease 는 복귀 즉시(또는 첫 파일 요청에서) 감지돼 평소의 재연결로 이어지고, 새 claim 이 새 capability 를 발급하므로 파일 표면이 다시 살아난다.
- 실패당 요청이 하나 늘어난다(`/session/status` 1회). 제어 근거 실패에서만 발생하고 성공 경로에는 없다.
- 복귀 시 heartbeat 1회가 추가된다. 이미 진행 중이면 `heartbeat()` 가 자체적으로 합치므로 중복되지 않는다.
- lease 가 살아 있는데 capability 만 어긋난 경우(서버 회전 직후의 짧은 창)에는 여전히 원래 403 문구가 보인다. 그 상태는 다음 claim 만이 고칠 수 있고, 프로브가 거짓으로 재연결을 시작하는 것보다 정확한 실패가 낫다.
- path-link 의 ambient 트리거는 죽은 lease 에서 조용히 계속 실패한다. 사용자 눈에는 밑줄이 안 켜지는 것으로만 보이며, 다음 명시적 액션이나 heartbeat 가 상실을 확정한다.
- 회귀 테스트는 ① capability 403 이 소유권 프로브와 재claim 으로 이어지고 그 문구가 사용자 설명이 되지 않는지, ② 복귀한 탭이 heartbeat 인터벌을 기다리지 않고 쥔 lease 를 프로브하는지를 고정한다(후자는 fake clock 으로 인터벌을 세워 검증한다).
- 이 결정은 클라이언트 쪽 수명 인식만 바꾼다. 서버의 발급·폐기·이중 검증과 소유권 정책을 바꾸려면 새 ADR 을 쓴다.
