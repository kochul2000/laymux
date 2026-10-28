# 0363. 분할·스택의 워크트리 CWD는 기본적으로 원본의 같은 하위 경로를 선택한다

- Status: Accepted
- Date: 2026-10-28
- Source: 사용자 요구(워크트리에서 원본/워크트리 PWD 선택, 원본 기본값, 동일 하위 경로 유지 및 없으면 원본 루트), [ADR-0140](0140-split-pane-inherits-source-cwd.md), [ADR-0361](0361-split-stack-inherit-terminal-profile.md)
- 관계: ADR-0140의 분할 CWD 시드 정책을 확장하며 Codex resume 및 일반 재시작 정책은 변경하지 않는다.

## Context

에이전트가 linked worktree 안에서 작업 중일 때 새 셸은 기본적으로 그 임시 checkout으로 진입한다. 사용자는 원본 저장소에서 새 작업을 시작할지 현재 checkout을 계속 쓸지 선택하고 싶다. 프로필 상속은 실행 환경을 선택하는 별도 설정이므로 CWD 선택과 결합하지 않는다. 원본이 하위 폴더에 있을 때는 동일한 상대 경로를 보존해야 한다.

## Decision

**`terminal.useMainWorktreeCwdOnSplit`을 기본 true로 저장하며 분할·stack의 상속 CWD에만 적용한다.**

- 설정 SoT는 호스트 settings.json이며 설정 화면의 터미널 > 일반에서 편집한다. 필드 누락 시 Rust와 UI 모두 true를 사용한다. 끄면 상속받은 현재 워크트리 CWD를 그대로 사용한다.
- 가로·세로 split과 stack의 일회성 요청은 캡처한 CWD와 그 CWD를 해석할 원본 프로필을 보유한다. 첫 터미널 생성 IPC에 원본 프로필을 전달하며 요청 소비·제거 수명은 기존 재시작 버스가 소유한다. 일반 재시작·복원에는 이 표식을 넣지 않는다. Automation의 명시 CWD는 표식을 제거하므로 항상 우선한다. Remote stack은 비활성 레이어라도 선택한 레이어의 CWD·프로필을 사용한다.
- Rust는 첫 PTY 생성 전에 설정과 원본 프로필의 native/WSL 실행 환경을 해석하고, 해당 Git의 worktree 목록으로 원본(main worktree)을 판정한다. 브랜치 이름이나 폴더 이름을 추측하지 않는다. Windows WSL 경로는 배포판을 결합한다. SSH 원격 파일시스템은 로컬 Git으로 조회하지 않는다.
- linked worktree의 `ui`에서 시작하면 원본의 `ui`를 선택하며, 그 디렉터리가 없으면 원본 루트를 선택한다. 원본 checkout·비저장소·bare 저장소 또는 조회 실패는 기존 CWD를 유지한다. 프로세스 실행은 기존 hidden Git/WSL 경로를 재사용하고 짧은 조회 제한을 적용한다. 조회는 blocking worker에서 수행하며 AppState 락을 잡은 채 실행하지 않는다.
- 경로 변경은 시작 요청이며 실제 CWD의 SoT는 기존 PTY의 스폰 결과·OSC 관측이다. 새 셸 시작 뒤 `cd`를 주입하지 않는다.
- 취소된 초기 effect는 첫 생성 표식을 소비하지 않는다. StrictMode의 초기 effect 재실행도 같은 상속 CWD를 보유하며, 살아 있는 생성 시도가 완료된 뒤에만 요청을 소비한다. 새 pane은 CWD 요청을 준비한 뒤 UI 상태에 공개한다.

## Alternatives Considered

- 모든 터미널 시작 CWD를 바꾼다: 명시한 워크트리 열기, 에이전트 복원, 사용자 재시작까지 뜻이 달라진다.
- UI에서 파일시스템을 읽거나 `.git` 경로를 추측한다: native/WSL 경계와 별도 git-dir·이동된 checkout을 제대로 해석하지 못한다.
- 분할 이벤트에서 비동기 조회 후 store를 갱신한다: React 렌더와 PTY 생성이 앞서갈 수 있어 잘못된 디렉터리로 잠깐 시작하는 경쟁이 생긴다.
- 항상 원본 루트만 선택한다: 같은 하위 경로를 유지한다는 사용자 결정을 충족하지 못한다.

## Consequences

- 기본 동작은 linked worktree에서 원본의 같은 하위 폴더로 바뀌며, 설정으로 기존 CWD 상속을 선택할 수 있다. 기능 추가이므로 버전 영향은 minor다.
- 새 터미널 시작에 제한된 Git 조회 비용이 추가된다. 실패하면 기존 경로를 보존하므로 셸 시작이 Git 가용성에 종속되지는 않는다.
- 프로필 상속을 끄고 다른 환경을 선택하면 기존 PTY 경로 변환·유효성 검사가 최종 적용 여부를 결정한다.
- 설정 UI/영속·IPC 표식·명시 CWD 우선·native/WSL Git·상대 경로 유지/루트 fallback·Remote 생성의 테스트와 실기를 수행한다. 마이그레이션은 추가하지 않는다.
