# 0198. Remote FileViewer 오버레이는 인-오버레이 file explorer 로 디렉터리를 탐색한다

- Status: Proposed
- Date: 2026-08-24
- Source: 사용자 요구("안드로이드도 viewer 기능을 넣자 — 우상단 버튼으로 전체 화면 viewer 진입, 디렉터리 탐색과 파일 열기, 파일 경로 클릭도 이 viewer 사용"), [ADR-0184](0184-remote-file-viewer-in-page-overlay.md), [ADR-0044](0044-remote-file-viewer-explicit-host-path.md), [ADR-0042](0042-remote-file-viewer-secret-capability.md), [ADR-0188](0188-path-link-ambient-detection-triggers.md), [api-contracts.md §13.3.1](../architecture/api-contracts.md)
- Extends: ADR-0184(인페이지 오버레이), ADR-0044(명시적 host path), ADR-0042(capability 게이트)
- Amends: ADR-0188 · [ADR-0045](0045-remote-path-link-reuses-desktop-parser.md) 계열의 "디렉터리는 Remote 링크로 활성화하지 않는다" 결정

## Context

Remote FileViewer 는 ADR-0184 로 셸 문서 안 오버레이가 되었지만 **파일 하나를 보여주는 표면**에 머문다. 진입 경로는 path-link 클릭과 드로어의 경로 직접 타이핑뿐이고, 디렉터리 리스팅 API 가 Remote 계약에 없어 폴더를 둘러보며 파일을 여는 UX 가 불가능하다. 디렉터리 path-link 후보도 의도적으로 비활성이다 — 데스크톱에서 디렉터리 클릭은 cwd 전파(`changeDir`)인데 Remote 에는 그 행동을 받을 표면이 없었기 때문이다.

데스크톱은 FileViewerOverlay 가 FileExplorerView(디렉터리 트리)와 FileViewer(본문)를 한 오버레이에 담아 탐색과 열람이 하나의 UX 다. 안드로이드 앱은 얇은 E2E wrapper(ADR-0149)라 UI 는 데스크톱이 서빙하는 `/remote/` 문서이므로, Remote 문서에 explorer 를 넣으면 브라우저·PWA·안드로이드가 같은 코드로 같은 탐색을 얻는다.

범위는 Remote 오버레이의 디렉터리 탐색과 그 데이터 계약, 헤더 진입점, 디렉터리 path-link 활성화다. render/download/path-link 의 기존 계약, lease+capability 게이트, 8 MiB 상한, typed preview 비목표(ADR-0109), 외부 viewer 미실행 원칙은 유지하며 변경 대상이 아니다. 데스크톱 explorer 의 다중 선택·컨텍스트 메뉴·주소창 편집, Remote 에서의 파일 조작(생성·삭제·이동)은 비목표다.

## Decision

**Remote 는 `POST /remote/v1/file-viewer/list` 로 호스트 디렉터리 하나를 bounded 목록으로 받고, 기존 `#fileViewerOverlay` 가 디렉터리 모드와 파일 모드를 오가는 단일 패널 explorer 가 된다. 헤더의 폴더 버튼이 활성 터미널 cwd 에서 explorer 를 열고, 디렉터리 path-link 후보가 활성화되어 클릭 시 explorer 로 연다.**

1. **새 엔드포인트, render 확장 아님.** `render` 는 파일 바이트 상한(8 MiB) 계약이고 `list` 는 엔트리 수 상한 계약이다 — 의미가 다른 상한을 한 계약에 섞지 않는다. `render` 가 디렉터리에 실패하는 현재 동작은 그대로 둔다.
2. **게이트는 기존 FileViewer 계약과 동일하다.** active lease(`X-Laymux-Remote-Lease`) + FileViewer capability(`X-Laymux-Remote-File-Viewer`), bridge 호출 전/후 이중 검증, `Cache-Control: no-store`. 안드로이드 E2E rpc allowlist 에 이 라우트를 추가한다. 디렉터리 목록은 파일 내용과 같은 민감도의 호스트 정보이므로 낮은 게이트를 새로 만들지 않는다.
3. **요청은 두 형태다.** `{ "path": "/abs/dir" }` 는 명시 경로를, `{ "source": "terminalCwd", "terminalId": "…" }` 는 해당 터미널의 현재 cwd 를 연다(헤더 폴더 버튼 진입). Rust 라우트는 형식 검증만 하고(빈 path, 256자 초과 terminalId, 알 수 없는 source → 400) 데스크톱 frontend bridge(`fileViewer.list`)에 위임한다 — 파일시스템과 스토어 접근은 전부 frontend bridge 라는 기존 소유권을 유지한다.
4. **응답 경로는 bridge 가 완성한다.** `{ path, parent, entries: [{name, path, isDirectory, isSymlink, size}], truncated }`. Rust `DirEntry` 에는 절대경로가 없으므로 bridge 가 데스크톱 explorer 와 같은 순수 함수(`joinPath`/`parentPath`)로 절대경로를 만들어 내린다 — Remote 클라이언트는 경로 문법을 소유하지 않는다. `terminalCwd` 에서 터미널이 없거나 cwd 미보고면 홈 디렉터리로 fallback 한다.
5. **목록은 bounded 다.** Rust 라우트가 `maxEntries`(1,000)를 params 로 고정 주입하고 bridge 는 fail-closed 로 재검증한다. 정렬은 디렉터리 우선 + 이름순이며, 상한 초과분은 잘라 `truncated:true` 로 알린다 — 화면 전체를 포기하는 것보다 앞쪽 표시가 낫다는 ADR-0188 `screen` 트리거와 같은 판단이다.
6. **오버레이는 단일 패널 모드 전환이다.** 데스크톱식 사이드바+본문 이중 패널은 채택하지 않는다 — 모바일 폭에선 어차피 단일 패널로 접어야 하고, 프레임워크 없는 IIFE 에서 반응형 이중 레이아웃의 유지비용이 이득을 넘는다. 디렉터리 모드는 zoom/download 를 숨기고 목록(부모 `..` 행 포함)을 그리며, 파일을 열면 기존 render 경로로 파일 모드가 된다. explorer 를 경유해 연 파일에만 back 버튼이 보이고, back 은 마지막 디렉터리를 **다시 list 요청**한다(목록 캐시 없음 — 항상 fresh). Escape·닫기·backdrop 은 오버레이 전체를 닫는다.
7. **탐색 상태는 표시 상태다.** 현재 경로·진입 출처는 페이지 지역 변수로만 유지하고 어디에도 저장하지 않는다(ADR-0184 의 줌과 같은 판단). 늦게 도착한 list 응답은 기존 revision + lease/capability 스냅샷 규칙으로 버린다.
8. **헤더 폴더 버튼.** 메인 헤더의 spatial-exclusion 버튼 옆에 폴더 버튼을 두고, lease+FileViewer capability 를 보유했을 때만 노출한다(capability 없는 상태의 비활성 노출 대신 숨김 — 연결 전에는 의미가 없는 진입점이다). 클릭은 `terminalCwd` source 로 explorer 를 연다.
9. **디렉터리 path-link 활성화.** path-link 검증은 `changeDir` 후보도 match 로 돌려주며 각 match 에 `kind: "file" | "directory"` 를 붙인다. Remote 클라이언트는 directory match 클릭을 explorer 열기로, file match 클릭을 기존 render 로 라우팅한다. 데스크톱의 `changeDir`(cwd 전파) 의미는 바꾸지 않는다 — Remote 에는 전파할 로컬 explorer pane 이 없고, 탐색으로 여는 것이 터치 표면의 의도에 맞다.

## Alternatives Considered

- **`render` 에 `kind:"directory"` 응답 추가**: 라우트 하나로 끝난다. 기각. 바이트 상한 계약에 엔트리 수 상한 의미가 섞이고, 디렉터리에 실패하던 기존 render 클라이언트 동작이 조용히 바뀐다.
- **데스크톱식 사이드바+본문 이중 패널**: 데스크톱과 UX 대칭. 기각. 주 표면이 모바일 폭이라 어차피 단일 패널로 접는 분기가 필요하고, IIFE 에서 두 레이아웃을 유지하는 비용이 크다. 탐색→열람→back 흐름이 터치 UX 로는 더 자연스럽다.
- **디렉터리 리스팅을 별도 저권한 게이트로 노출**: 목록은 내용보다 덜 민감해 보인다. 기각. 디렉터리 구조 자체가 호스트 정보이고, 게이트 종류가 늘수록 검증 누락 표면이 는다. 기존 capability 하나로 통일한다.
- **디렉터리 path-link 를 이번에도 제외**: 범위가 준다. 기각. explorer 가 생기면 `changeDir` 후보를 살리는 비용이 필터 한 줄 + 라우팅 분기 수준이고, "터미널의 경로를 탭하면 열린다" 는 기대가 파일/디렉터리로 갈라져 있을 이유가 사라진다.
- **목록 결과 캐시로 back 즉시 복귀**: 왕복이 준다. 기각. stale 목록은 잘못된 파일 열기로 이어지고, invalidation 규칙이 revision 체계를 복잡하게 한다. 디렉터리 목록 한 번은 싸다.
- **마지막 방문 디렉터리 영속화**: 재진입이 편하다. 기각. 표시 상태이지 설정이 아니며(ADR-0184 줌과 동일), lease 가 바뀌면 의미도 사라진다.

## Consequences

- 브라우저·설치형 PWA·안드로이드가 같은 코드로 디렉터리 탐색을 얻는다. 안드로이드는 e2e rpc allowlist 한 줄로 같은 계약을 쓴다.
- Remote 가 읽을 수 있는 호스트 정보에 디렉터리 구조가 추가된다. 게이트는 파일 내용과 동일한 lease+capability 이므로 권한 표면은 넓어지지 않고 노출 종류만 는다 — capability 회전·revoke 규칙(ADR-0042)이 그대로 이 계약을 덮는다.
- api-contracts §13.3.1 의 "디렉터리는 Remote 링크로 활성화하지 않는다" 는 이 ADR 로 개정된다. path-link 응답에 `kind` 필드가 추가되지만 remote-app.js 는 호스트가 서빙하는 자산이라 버전 스큐가 없다.
- 오버레이가 모드(디렉터리/파일)를 갖게 되어 닫기·back·revision 규칙이 모드를 인지해야 한다. "explorer 경유 진입에만 back" 규칙이 흐려지면 UX 가 무너지므로 Playwright 로 고정한다.
- 테스트: Rust 단위(list params 검증, capability revocation fail-closed, 안드로이드 e2e allowlist), bridge vitest(절단·terminalCwd fallback·에러·경로 완성), Playwright(헤더 버튼 게이팅, 탐색→파일→back, empty·truncated·실패 표시, 모바일 폭 터치 타깃, 디렉터리 링크 클릭). 안드로이드 래퍼는 모든 HTTP 가 같은 `remoteFetch` 터널을 지나므로 allowlist 검증이 계약을 고정한다.
- 재검토 조건: Remote 에 파일 조작(쓰기 계열)을 넣자는 요구가 생기면 이 read-only 계약과 별도 ADR 로 다룬다. Remote 클라이언트 통합(React 이식)이 결정되면 단일 패널 결정도 함께 재검토한다.
