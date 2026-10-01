# 0288. path-link 는 `~` 를 pane 셸의 홈으로 풀고, 경로에 붙은 한글 조사를 뗀 후보를 함께 낸다

- Status: Proposed
- Date: 2026-10-01
- Source: 사용자 버그 신고("`~/data_projects/.../AHBPS-26-218_통계자문메모.docx다.` 나 `/tmp/abc` 처럼 root 로 시작하는 파일 경로가 제대로 파싱되지 않는다", "`~`(home)는 Windows·WSL 모두 지원"), [ADR-0148](0148-bounded-multi-path-selection-links.md), [ADR-0188](0188-path-link-ambient-detection-triggers.md), [ADR-0191](0191-path-link-space-extended-candidates.md), [ADR-0235](0235-wrapped-path-link-logical-lines.md)
- Extends: ADR-0148, ADR-0188, ADR-0191, ADR-0235

## Context

path-link 후보는 `joinCwdPath` 로 절대경로가 된 뒤 `stat_paths` 로 실존을 검증한다(ADR-0148). 이 조합 규칙에 두 가지 구멍이 있었다.

1. **`~` 를 몰랐다.** `~/notes/a.md` 는 절대경로가 아니므로 cwd 상대경로로 취급되어 `/home/me/proj/~/notes/a.md` 같은 존재하지 않는 경로가 되었다. 셸·에이전트 출력은 홈 아래 경로를 `~/...` 로 줄여 쓰는 것이 일상이므로 이 경로들은 어떤 트리거로도 링크가 되지 않았다.
2. **한글 문장에 붙은 경로의 끝을 몰랐다.** Claude Code·Codex 의 한국어 출력은 `.../메모.docx다.`, `/tmp/abc에 저장했다` 처럼 경로 뒤에 조사·어미를 띄어쓰기 없이 붙인다. 토큰 경계는 공백·따옴표·괄호뿐이라(ADR-0148) 후보가 `메모.docx다`, `/tmp/abc에` 가 되고 stat 에 실패한다. `/tmp/abc` 자체는 원래 링크가 되지만 이런 문장 안에서는 되지 않아 "root 로 시작하는 경로가 안 된다"는 증상으로 보였다.

`~` 의 뜻은 **pane 이 어떤 셸에서 도는지**에 달려 있다. WSL pane 의 `~` 는 그 배포판 사용자의 Linux `$HOME`(`/home/me`)이고, PowerShell·cmd·git-bash pane 의 `~` 는 Windows 사용자 홈(`C:\Users\me`)이며, Linux 호스트에서는 호스트 `$HOME` 이다. 그런데 프론트엔드가 받는 pane cwd 는 백엔드가 모든 셸에 대해 `/mnt/c/...` 같은 Linux 형태로 정규화해 보내므로(`normalize_wsl_path`) **cwd 모양으로는 WSL 과 PowerShell 을 구분할 수 없다.** 또 WSL 사용자의 홈 경로는 Windows 쪽에서 계산할 수 없고 배포판 안에서 물어야 한다.

범위는 후보 추출 문법과 조합 규칙, 그리고 pane 홈을 알려 주는 데스크톱 내부 IPC 하나다. `~user` 형태, WSL `-u` 로 다른 사용자로 띄운 pane 의 홈, 기본 배포판이 아닌 WSL pane 의 POSIX 절대경로 해석(기존 한계 — `stat_paths` 는 배포판을 받지 않는다)은 비목표다. Remote HTTP 계약 shape 은 바꾸지 않는다.

## Decision

**`~`·`~/...`·`~\...` 는 cwd 가 아니라 pane 셸의 홈에 붙인다. 홈은 pane 의 spawn 호스트(`InitialExecutionHost`)로 백엔드가 정한다. 경로 끝에 띄어쓰기 없이 붙은 한글 꼬리는 뗀 변형을 원문과 함께 후보로 내고, stat 과 longest-existing-wins 가 고른다.**

- **홈의 SoT 는 백엔드 세션이다.** 데스크톱 내부 커맨드 `get_terminal_home_directory(terminalId) -> string | null` 이 세션의 spawn 시점 호스트 분류로 정한다.
  - `Wsl` → 그 pane 의 배포판(`wsl_distro` 보고값 → 프로필의 `-d`/`--distribution` → 기본 배포판 순, `terminal_distro_target` 과 같은 규칙)에서 `wsl.exe -d <distro> --exec sh -c 'printf %s "$HOME"'` 로 얻은 Linux 경로. 결과는 배포판별로 `WSL_DEFAULT_DISTRO_CACHE_TTL`(60s) 동안 캐시하고 실패도 캐시한다 — hover·Remote 유휴 스캔이 매번 `wsl.exe` 를 띄우지 않게 한다. 출력은 `/` 로 시작하는 한 줄 경로일 때만 받는다. 안전하지 않은 배포판 이름은 조회하지 않는다(fail closed).
  - `NativeWindows`·`NonWindows` → 호스트 홈(`home_directory()`, Windows 는 `USERPROFILE`).
  - `DirectSsh`(홈이 다른 기계에 있다)·`Unknown`(아직 spawn 분류 전)·없는 terminal → `null`.
  - cwd 는 판별 근거로 쓰지 않는다. `/mnt/c/...` 에 있는 WSL pane 의 `~` 도 Linux 홈이다.
- **조합은 프론트엔드 `joinCwdPath(cwd, path, home)` 가 한다.** 홈 상대경로는 홈의 모양(Windows 면 백슬래시, 아니면 슬래시)으로 붙이고, 홈이 `null` 이면 그 후보는 조합하지 않고 버린다 — cwd 아래 `~` 디렉토리로 오인하지 않는다. 조합된 절대경로가 그대로 `stat_paths`·viewer·cwd 전파·OS 열기로 흐르므로 하류는 바뀌지 않는다.
- **홈은 필요할 때만 묻는다.** 세 트리거(desktop selection·point, Remote 3 mode)는 후보 중 홈 상대경로가 있을 때만 홈을 조회한다. 조회 실패는 `~` 후보만 잃고 나머지 후보 검증은 그대로 진행한다. 조회를 기다리는 사이 새 선택·무효화가 끼면 그 평가는 버린다.
- **`~/` 로 시작하는 토큰은 공백 확장 앵커다**(ADR-0191 확장). 홈 상대경로도 cwd 와 무관하게 위치가 정해지므로 절대경로와 같은 자격이다. 같은 이유로 hard wrap 결합([ADR-0235](0235-wrapped-path-link-logical-lines.md))에서 `~/` 로 시작하는 다음 줄은 새 경로로 보고 앞줄에 잇지 않는다.
- **한글 꼬리 변형.** 후보 텍스트가 한글 음절(가–힣)로 끝나고 그 한글 연속 바로 앞 글자가 한글·공백·`/`·`\` 가 아니면, 그 한글 연속을 떼고 꼬리 정리(ADR-0191 의 `trimPathTail`)를 다시 적용한 변형을 만든다. 시작 offset 과 원문(포인터 덮기) 범위는 원 후보와 같다.
  - 원문을 **대체하지 않고 함께** 낸다. `v2최종` 처럼 실제 이름이 그렇게 끝나면 원문이 존재하고 더 길어 이긴다(longest-existing-wins). `보고서에` 처럼 한글 이름에 이어진 한글, `dir/한글` 처럼 구분자 뒤 한글은 이름일 수 있어 떼지 않는다.
  - 비용: 기본 토큰과 공백 확장 cut 마다 변형은 최대 1개다. `selection` 에서는 ADR-0191 확장과 같은 best-effort 추가 후보(기본 후보 all-or-nothing 상한 밖, 배치 총량 64 안)이며 넓은 선택에서는 변형이 strong 일 때만 받는다. `point` 는 토큰 1 + 변형 1 + 지점을 덮는 확장 cut 과 그 변형으로 여전히 상수다. `screen` 은 변형도 strong 조건과 64 상한 안에서 함께 센다.

## Alternatives Considered

- **`~` 를 백엔드 `resolve_address_path` 에서 풀기.** stat·viewer·OS 열기가 모두 같은 함수를 지나므로 한 곳에서 풀 수 있어 보이지만, 그 함수는 pane 을 모른다 — 같은 `~/a` 가 WSL pane 에서는 Linux 홈, PowerShell pane 에서는 Windows 홈이다. pane id 를 모든 파일 커맨드 계약에 추가하는 비용이 크고, cwd 전파(`do_sync_cwd`)처럼 경로 문자열만 받는 하류도 있다. 조합 시점에 구체 경로로 바꿔 두는 편이 하류를 건드리지 않는다.
- **cwd 모양으로 WSL/Windows 를 추정.** 백엔드가 PowerShell cwd 도 `/mnt/c/...` 로 정규화해 보내므로 구분할 수 없다. spawn 호스트 분류는 이미 렌더러 정책이 쓰는 세션 사실이다.
- **pane 생성 시 홈을 미리 계산해 세션 응답에 실어 보내기.** 쓰지 않는 pane 마다 WSL 조회 비용을 낸다. 지연 조회 + 배포판별 캐시로 같은 결과를 필요할 때만 얻는다.
- **WSL 홈을 `\\wsl.localhost\<distro>\home\<user>` UNC 로 돌려주기.** 기본이 아닌 배포판에서도 stat 이 맞지만, 같은 pane 의 `/tmp/abc` 같은 POSIX 절대경로는 Linux 형태로 흐르므로 `~` 만 다른 형태가 되어 cwd 전파·Remote 표시가 갈라진다. 배포판 일관성은 POSIX 경로 전체의 문제로 따로 다룬다.
- **한글 꼬리를 꼬리 정리 규칙에 넣어 항상 제거.** 후보 수는 늘지 않지만 `project한글` 같은 실제 이름을 영영 링크하지 못한다. 실존 검증이 게이트라는 원칙(ADR-0148)에 맞게 변형을 추가 후보로 낸다.
- **조사 사전(`에`, `다`, `에서`, `입니다` …) 매칭.** 어미·조사 조합이 열려 있어 사전이 늘 모자라고, 스크립트 전환(ASCII 등 → 한글) 경계 규칙이 같은 사례를 더 단순하게 덮는다.

## Consequences

- WSL·Windows·Linux pane 모두 `~/...` 경로가 hover·클릭·선택·Remote 에서 링크가 되고, `...docx다.`, `/tmp/abc에` 같은 한국어 문장 속 경로도 찾는다.
- 새 내부 IPC `get_terminal_home_directory` 가 생긴다(Automation/MCP/Remote 미노출). 파일시스템·프로세스를 건드리므로 `#[tauri::command(async)]` 계약 표(ADR-0202)에 등록한다.
- WSL 홈 조회는 배포판당 60초에 최대 1회 `wsl.exe` spawn 이다. WSL 이 콜드 스타트로 3초 안에 답하지 못하면 그 60초 동안 `~` 링크가 켜지지 않는다.
- 한계: `~user`, `wsl.exe -u <user>` 로 띄운 pane(기본 사용자 홈을 돌려준다), 기본이 아닌 배포판 pane 의 홈 아래 경로 stat(기존 POSIX 절대경로와 같은 한계). 이 중 하나가 실사용에서 문제가 되면 `stat_paths` 에 pane 배포판을 싣는 결정을 따로 한다.
- 한글 꼬리 변형은 조사 뒤에 다른 스크립트가 다시 오는 경우(`a.md를x`)나 한글 아닌 언어의 조사는 다루지 않는다.
- 테스트: `path-link-detect`·`path-link-point`·`remote-file-viewer`·`TerminalView` 단위 테스트, Rust `terminal_home_directory`·`parse_probe_home` 테스트. living doc 은 [data-flow.md](../architecture/data-flow.md) 의 path-link 절을 갱신한다.
