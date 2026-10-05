# 0291. PC 뷰어 열림은 heartbeat 의 경로 없는 신호로 알리고 Files 버튼 한 번으로 진입한다

- Status: Proposed
- Date: 2026-10-05
- Source: 사용자 요구("laymux pc 가 뷰어로 파일을 띄운 상태라면 알아 차릴 수 있는 ui 와 바로 진입하는 흐름이 필요해", "배너는 빼고 파일 뷰어 아이콘의 unread dot 이 깜빡거리게"), [ADR-0044](0044-remote-file-viewer-explicit-host-path.md), [ADR-0042](0042-remote-file-viewer-secret-capability.md), [ADR-0198](0198-remote-file-explorer-overlay.md), [ADR-0259](0259-remote-file-viewer-system-back-to-explorer.md), [api-contracts.md §13.3.1](../architecture/api-contracts.md)
- Supersedes: ADR-0044 의 `From host` 입력 가져오기(결정 요약 문장, Decision 3·7). 연결·heartbeat 가 status 를 조회하지 않는다는 Decision 2 와 입력칸 자동 반영 금지는 유지한다.
- Amends: ADR-0198 의 Explorer path 행 구성(`From host` 제거)

## Context

Remote(브라우저·설치형 PWA·Android 래퍼가 같은 `remote-app.js` 를 쓴다)로 PC 를 쓰는 동안 에이전트가 MCP `open_file_viewer`/`show_image` 로, 혹은 PC 앞에서 경로 링크·탐색기로 데스크톱 FileViewer 를 열어도 Remote 에는 아무 변화가 없다. 사용자는 PC 가 무엇을 띄웠는지 알 수 없고, 보려면 Files 를 열고 `From host` 로 경로를 가져온 뒤 `Open` 을 눌러야 한다.

현재 구조가 이 공백을 만든다.

- 데스크톱 뷰어 상태의 진실원은 프론트 `useFileViewerStore` 의 `{open, path}` 뿐이다. Rust 는 뷰어 상태를 모르고, 같은 파일을 다시 연 것과 처음 연 것을 구분할 열림 순번도 없다.
- Remote 에는 서버가 먼저 보내는 앱 이벤트 채널이 없다. 터미널 출력 WebSocket 을 빼면 전부 폴링이고, navigation 폴링은 드로어가 열려 있을 때만 돈다. lease 보유 중 항상 도는 것은 1~5초 주기 heartbeat 하나이며, 그 응답에 `deviceSettingsCommand` 를 덧붙인 선례가 있다.
- ADR-0044 는 heartbeat 마다 status 를 조회해 입력칸을 바꾸는 방식이 사용자 입력과 경쟁한다는 이유로 자동 동기화를 금지했다. 같은 ADR 은 "입력과 host 후보를 별도 UI 상태로 표시하거나 versioned push 계약을 설계한 뒤 새 ADR 로 재검토"하라고 남겼다.
- 경로와 파일 내용은 claim 성공자 전용 `fileViewerToken` 뒤에만 있다(ADR-0042). 공개 식별자인 `leaseId` 만 아는 관찰자에게 경로가 새어서는 안 된다.

범위는 Remote 가 포그라운드에 있는 동안의 인지 표시와 진입 흐름이다. 앱이 백그라운드일 때의 OS 알림(푸시 인프라 필요), Remote 가 데스크톱 뷰어를 조작하는 것, 데스크톱 알림 목록에 항목을 추가하는 것, 화면을 덮는 배너·토스트는 비목표다.

## Decision

**데스크톱 store 가 뷰어 열림 순번을 갖고, Rust 가 그 경로 없는 신호를 미러해 heartbeat 응답으로 내려보내며, Remote 는 아직 보지 않은 열림이 있을 때 Files 헤더 버튼에 unread dot 을 켜고 그 버튼 한 번으로 해당 파일을 연다.**

1. **열림 순번의 진실원은 데스크톱 `useFileViewerStore` 다.** store 는 생성 시 한 번 정한 `openEpoch` 문자열과, 경로가 있는 `openFileViewer` 가 성공할 때마다 1 증가하는 `openRevision` 을 갖는다. 같은 경로를 다시 열어도 증가한다(에이전트가 갱신한 파일을 다시 띄우는 경우). 빈 뷰어(`openEmptyFileViewer`)와 닫기는 증가시키지 않는다. 웹뷰가 다시 로드되거나 앱이 재시작하면 epoch 가 바뀌므로 `(epoch, revision)` 쌍은 한 데스크톱 표시 수명 안에서 유일하다. 열림 경로(MCP·REST·경로 링크·탐색기·오버레이 주소창)는 구분하지 않는다 — 모두 PC 가 띄운 파일이다.
2. **Rust 는 신호를 미러만 한다.** 프론트는 `{open, epoch, revision}`(`open` 은 경로가 있는 열림 상태) 이 바뀔 때마다 Tauri 커맨드 `report_file_viewer_signal` 로 보고하고, Rust 는 `AppState` 의 leaf 락 필드에 마지막 값을 덮어쓴다. 경로는 Rust 에 저장하지 않는다. heartbeat 가 프론트 bridge 왕복에 의존하지 않도록 heartbeat 핸들러는 이 미러만 읽는다.
3. **heartbeat 응답은 경로 없는 신호를 싣는다.** lease 갱신에 성공한 `POST /remote/v1/session/heartbeat` 응답은 항상 `fileViewer: {open, epoch, revision}` 을 포함한다. 경로·파일 이름·크기는 싣지 않는다. 실패(409) 응답에는 싣지 않는다.
4. **경로는 여전히 capability 게이트 뒤에만 있다.** `/remote/v1/file-viewer/status` 응답은 `{open, path, epoch, revision, parent}` 로 확장한다. `parent` 는 데스크톱이 `path` 의 부모 디렉터리를 계산한 값이다(Remote 는 호스트 경로 문법을 갖지 않는다, ADR-0198). Remote 는 연결·heartbeat 에서 status 를 조회하지 않으며(ADR-0044 Decision 2 유지), Files 버튼을 눌렀을 때만 조회한다.
5. **unread dot.** Remote 문서는 마지막으로 소비한 열림 키 `epoch:revision` 을 문서 메모리에 보관한다. heartbeat 신호가 `open=true` 이고 그 키와 다르면 Files 헤더 버튼(`#fileExplorerHeader`)에 unread dot 을 켠다. 새 키를 처음 관측한 순간부터 약 8초 동안 dot 이 깜빡이고 그 뒤에는 켜진 채로 남는다. `prefers-reduced-motion` 에서는 깜빡이지 않는다. 접속 시점에 이미 열려 있는 미확인 파일도 같은 규칙으로 깜빡인다. 신호가 `open=false` 가 되면 dot 을 끈다. dot 은 레이아웃을 바꾸지 않는 장식이라 터미널 크기와 PTY 크기에 영향이 없다. 화면을 덮는 배너·토스트는 두지 않는다.
6. **한 번에 진입.** dot 이 켜진 상태에서 Files 버튼을 누르면 status 를 조회해 그 시점 PC 뷰어의 `path` 를 같은 오버레이의 파일 모드로 연다(`render source:"path"`). 돌아가기 경로는 `parent` 이므로 헤더 Back 과 Android system back 은 그 파일이 있는 폴더의 Files 목록으로 간다(ADR-0259). status 응답의 키를 소비 키로 기록해 dot 을 끈다. status 가 열린 파일이 없다고 답하면 dot 을 끄고 기존처럼 활성 터미널 cwd 의 Files 목록을 연다. dot 이 없으면 Files 버튼은 지금과 같다.
7. **입력칸은 자동으로 바뀌지 않는다.** 신호와 진입은 Explorer 의 host path 입력칸을 읽거나 쓰지 않는다. ADR-0044 의 입력 출처 보호는 그대로이며, 입력칸으로 PC 경로를 가져오던 `From host` action 은 6번 흐름이 대체하므로 제거한다.
8. Files 버튼이 보이는 조건(lease + FileViewer capability + 헤더 아이콘 설정)은 바꾸지 않는다. 버튼이 숨겨져 있으면 dot 도 없다.

## Alternatives Considered

- **화면 상단 배너로 알림**: 파일 이름과 `Open` 을 바로 보여 줄 수 있다. 기각. 사용자가 명시적으로 뺐다. 터미널을 덮어 입력 흐름을 끊고, 자동으로 사라지는 시간과 겹침 규칙이 새로 필요하다. 이미 있는 진입 아이콘에 상태를 얹는 쪽이 같은 인지 효과를 더 적은 표면으로 낸다.
- **heartbeat 응답에 경로까지 포함**: status 왕복 하나를 줄인다. 기각. heartbeat 는 공개 `leaseId` 로 호출되므로 경로가 capability 경계(ADR-0042) 밖으로 나간다.
- **heartbeat 핸들러가 매번 프론트 bridge 로 status 를 질의**: Rust 미러가 필요 없다. 기각. lease 생존을 결정하는 heartbeat 지연이 프론트 웹뷰 응답성에 묶이고, 1~5초마다 클라이언트 수만큼 bridge 왕복이 생긴다.
- **Rust 가 열림 순번을 직접 증가**: bridge `openFileViewer` 에서 세면 프론트 보고가 필요 없다. 기각. 데스크톱 UI(경로 링크·탐색기)로 연 경우를 놓치고, store 와 Rust 에 두 개의 진실원이 생긴다. 웹뷰 재로드 시 프론트 순번이 0 으로 돌아가는 문제는 epoch 로 해결한다.
- **기존 데스크톱 알림(`notifications.add`)으로 전달**: 기존 알림 UI 를 재사용한다. 기각. navigation 폴링은 드로어가 열릴 때만 돌고, 알림 항목에는 "뷰어 열기" 같은 동작 종류가 없으며, 데스크톱 알림 목록을 PC 자신이 한 동작으로 오염시킨다.
- **신호가 오면 오버레이를 자동으로 연다**: 진입이 0탭이 된다. 기각(이번 범위). 사용자가 입력 중인 터미널을 가리고 키 입력 소유권을 빼앗는다. 필요하면 기기별 설정으로 별도 결정한다.
- **dot 이 켜져 있으면 Files 목록 맨 위에 "PC viewer" 후보 카드를 보여 주고 카드를 눌러 진입**: Files 버튼의 의미가 바뀌지 않는다. 기각. 진입이 2탭이 되고, dot 이 이미 "새 PC 파일이 있다"를 뜻하므로 그 버튼이 그 파일로 가는 것이 기대와 맞는다. 목록은 Back 한 번으로 닿는다.
- **`From host` 유지**: 기존 사용자의 손에 익은 경로를 남긴다. 기각. 6번 흐름이 같은 목적을 한 단계로 달성하고, 내부 개발 단계라 하위호환보다 표면 정리가 우선이다.

## Consequences

- PC 가 뷰어를 열면 다음 heartbeat(1~5초) 안에 Files 버튼의 dot 이 깜빡이고, 버튼 한 번으로 그 파일이 열린다. 놓쳐도 dot 이 켜진 채 남는다.
- heartbeat 응답에 `fileViewer` 필드가, status 응답에 `epoch`·`revision`·`parent` 가 추가된다. Remote 페이지와 서버는 같은 배포 산출물이라 호환 분기를 두지 않는다. 새 route 가 없으므로 Android E2E RPC allowlist 와 Cloud relay 정책은 바뀌지 않는다.
- 공개 `leaseId` 로 heartbeat 를 보낼 수 있는 쪽은 "PC 뷰어에 무언가가 열렸고 몇 번째 열림인지"를 알 수 있다. 경로·이름·내용은 알 수 없다. 이 수준의 활동 메타데이터 노출은 수용한다.
- 소비 키는 문서 메모리에만 있으므로 Remote 페이지를 다시 로드하면 아직 열린 파일에 대해 dot 이 다시 켜진다. 기기 저장소에 남길 만큼 중요한 상태가 아니다.
- 데스크톱 웹뷰 재로드나 앱 재시작 직후에는 store 가 비어 있어 `open=false` 를 보고한다. 이전 epoch 의 신호는 그대로 소멸한다.
- 앱이 백그라운드일 때는 heartbeat 가 멈추므로 알림도 없다. 포그라운드 복귀 후 첫 heartbeat 에서 dot 이 갱신된다. 백그라운드 OS 알림은 Cloud relay 푸시와 네이티브 알림 채널이 필요해 별도 ADR 로 다룬다.
- `From host` 버튼과 그 경쟁 조건 처리(입력 revision 비교)가 사라진다. living doc(api-contracts §13.3.1, data-flow, overview)과 Playwright 시나리오를 같은 변경에서 갱신한다.
- 테스트: 프론트 unit(열림 순번 증가 규칙, 신호 보고, status 응답 확장), Rust unit(미러 저장, heartbeat 성공 응답의 신호와 경로 비포함), Playwright(dot 표시·깜빡임 종료·reduced-motion, 버튼 한 번 진입과 Back 의 부모 폴더 복귀, 열린 파일이 사라진 경우의 폴백, Android 래퍼 경로).
