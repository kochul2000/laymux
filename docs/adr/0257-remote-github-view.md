# 0257. Remote GitHub View는 데스크톱 스냅샷을 재사용한다

- Status: Accepted
- Date: 2026-09-18
- Source: 사용자 요구("pc 전용으로 지원되는 깃헙뷰 기능을 모바일에 그대로 활성", 헤더 버튼과 우측 스와이프 대상 선택) · [ADR-0106](0106-github-list-view-repo-registry.md) · [ADR-0110](0110-github-snapshot-stale-while-revalidate.md) · [ADR-0111](0111-github-view-display-settings.md) · [ADR-0115](0115-github-view-tab-per-pane-state.md) · [ADR-0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md) · [architecture/api-contracts.md §GitHub 이슈/PR 목록](../architecture/api-contracts.md)
- Extends: ADR-0106의 프로세스 전역 GitHub 스냅샷 소비자를 Remote로 확장하고, ADR-0149의 PC 소유 Remote UI에 GitHub 표면을 추가한다.

## Context

데스크톱 `GitHubView`는 pane이 받은 CWD를 기준으로 열린 issue와 PR을 조회하고, 링크·브랜치 복사와 close/merge 계열 작업을 제공한다. 조회 결과는 `owner/repo`별 프로세스 전역 레지스트리에 저장되어 여러 pane이 같은 `gh` 호출을 중복 실행하지 않는다. Remote는 현재 terminal CWD의 GitHub base URL만 조회해 터미널의 `#123` 링크에 사용하고, 목록과 작업 표면은 제공하지 않는다.

Remote의 우측 가장자리 스와이프는 File Explorer로 고정되어 있다. GitHub 목록을 별도 진입점으로 추가하면 좁은 모바일 헤더와 제스처의 대상 선택, Android E2E transport의 route allowlist, GitHub 상태 변경 권한을 함께 결정해야 한다.

범위는 PC가 제공하는 Direct/Android Remote 문서의 GitHub 목록·작업 UI, Remote HTTP 계약, 헤더 진입점과 기기별 우측 스와이프 설정이다. 데스크톱 `GitHubView`의 설정을 Remote 기기에 동기화하거나 GitHub API를 직접 호출하는 것은 비목표다.

## Decision

**Remote GitHub View는 활성 terminal의 CWD를 입력으로 데스크톱과 같은 GitHub 스냅샷 레지스트리와 `gh` 작업 구현을 사용하며, 우측 가장자리 스와이프 대상은 기기 로컬 설정으로 File Explorer 또는 GitHub View 중 선택한다.**

- 읽기 endpoint `GET /remote/v1/terminals/{id}/github?force=<bool>`는 terminal lock에서 CWD를 복사한 뒤 lock을 놓고 공용 `get_github_repo_snapshot`을 호출한다. 응답은 조회에 사용한 `cwd`와 데스크톱과 동일한 `status`, `repo`, `repoUrl`, `issues`, `pulls`, `fetchedAtMs`를 반환한다. 따라서 stale-while-revalidate, per-repo single-flight, timeout과 오류 분류는 ADR-0106·0110의 단일 구현을 유지한다.
- 변경 endpoint `POST /remote/v1/terminals/{id}/github/actions`는 `{leaseId, action, number}`를 받고 active Remote lease를 검증한 뒤 terminal CWD와 공용 `run_github_item_action`을 사용한다. action allowlist와 cache 무효화도 데스크톱 구현이 소유한다. Remote UI는 데스크톱처럼 메뉴 선택 뒤 별도 Confirm을 요구한다.
- 두 endpoint는 기존 bearer/IP/Origin gate를 통과해야 한다. Android E2E의 내부 HTTP allowlist에도 정확한 terminal 경로만 추가한다. 읽기는 bearer만으로 가능하지만 헤더 버튼은 연결된 surface에서만 표시하고, 변경은 반드시 active lease를 요구한다.
- Remote 문서는 헤더의 File Explorer 버튼 바로 다음에 GitHub 버튼을 둔다. overlay는 Issues/PRs 탭, 저장소명, 수동 새로고침, 링크·브랜치 복사, draft·label·작성자·갱신 시각, issue close와 PR merge/squash/rebase/close를 제공한다. 선택 탭은 문서 수명 동안 유지하고 새 terminal을 붙이면 그 terminal CWD로 다시 조회한다.
- `laymux.remote.rightSwipeView`는 `"files" | "github"`인 기기 로컬 설정이며 기본값은 `files`다. Remote Settings의 Display 섹션과 Remote settings MCP 스키마가 같은 값을 편집한다. 우측 가장자리 제스처는 연결 상태와 선택 대상의 가용성을 확인한 뒤 선택된 overlay를 연다. 좌측 스와이프는 계속 workspace menu를 연다.
- GitHub overlay가 열려 있는 동안 terminal touch·Composer focus는 활성화하지 않는다. Android system back, Escape, backdrop과 닫기 버튼은 같은 dismiss stack에서 overlay를 닫는다. 화면 안쪽 방향 스와이프 닫기도 File Explorer와 동일한 기기 로컬 `swipeCloseDrawers` gate를 따른다.

## Alternatives Considered

- **Remote가 GitHub REST/GraphQL API를 직접 호출한다.** 모바일에 별도 credential 저장과 rate-limit/error/cache 구현이 생기고 `issueReporter.shell`을 통해 WSL의 `gh`를 사용하는 기존 계약과 달라져 기각했다.
- **기존 `/github-repo` 응답에 목록을 합친다.** terminal link provider의 가벼운 repo-base 조회까지 두 번의 `gh list` 실행과 오류 상태에 결합되어 기각했다. 링크 해석과 목록 조회는 비용과 목적이 다르다.
- **우측 스와이프를 GitHub로 고정 교체한다.** 기존 File Explorer 제스처를 잃고 사용자의 작업 흐름을 강제로 바꾸므로 기각했다. 기기별 선택을 두고 기존 동작을 기본값으로 보존한다.
- **데스크톱 React `GitHubView`를 Remote에 직접 임베드한다.** Remote는 PC가 제공하는 독립 vanilla bundle이며 Tauri IPC·Zustand·desktop settings에 접근하지 않는다. 의존 경계를 합치는 비용보다 동일 wire model을 작은 Remote renderer로 그리는 편이 안전하다.

## Consequences

- Desktop과 Remote가 같은 repository cache와 action allowlist를 공유해 목록·변경 결과가 일관되고, Remote pane 수가 늘어도 `gh` 호출 수는 repo 단위로 제한된다.
- Remote 외부 계약과 Android E2E allowlist가 늘어난다. route spelling, lease gate, CWD lock 해제, camelCase 응답을 Rust 테스트로 고정해야 한다.
- Remote renderer는 desktop React 컴포넌트와 별도이므로 시각 구현은 중복된다. 데이터·상태·action 계약은 공용 Rust 구현을 SoT로 유지하고, Remote E2E가 탭·복사·확인·스와이프를 검증한다.
- `rightSwipeView`는 host settings가 아니라 기기 로컬 설정이므로 PC/다른 전화와 동기화되지 않는다. Remote settings MCP로 명시적으로 해당 기기만 바꿀 수 있다.
- GitHub 변경 작업은 원격에서 repository 상태를 바꿀 수 있다. bearer만 탈취한 읽기 client가 실행할 수 없도록 active lease와 두 단계 UI 확인을 계속 요구한다.
