# 0188. path-link 은 선택 외에도 포인터 지점·유휴 화면에서 발견한다

- Status: Proposed
- Date: 2026-08-21
- Source: 사용자 요구("파일경로 파싱이 불편하다 — 마우스를 올려 잠시 멈추거나, 클릭하거나, 리모트에서 탭·롱클릭하거나, 리모트는 화면 갱신이 멈추면 한 화면에 대해 파싱"), [ADR-0165](0165-desktop-path-link-validates-on-pointer-release.md), [ADR-0148](0148-bounded-multi-path-selection-links.md), [ADR-0045](0045-remote-path-link-reuses-desktop-parser.md), [architecture/data-flow.md §8.6](../architecture/data-flow.md)
- Extends: ADR-0165, ADR-0148, ADR-0045

## Context

현재 path-link 의 발견 입력은 **명시적 pointer 선택 하나**다. 데스크톱은 pointer release 로 확정된 최종 선택만 gesture 당 1회 검증하고(ADR-0165), Remote 는 선택 변경을 trailing debounce 한 뒤 host bridge 로 왕복한다(ADR-0045/0148). 즉 사용자는 경로를 **드래그해야** 밑줄과 클릭 대상을 얻는다.

실사용에서 이 계약은 비용이 크다. 터미널 출력의 경로는 대개 읽는 즉시 열고 싶은 대상인데, 매번 드래그해서 선택을 만들어야 하고, 선택을 만들면 clipboard(`copyOnSelect`)와 선택 하이라이트라는 부수효과가 함께 따라온다. 터치 surface 에서는 더 나쁘다 — Remote 에서 경로를 정확히 드래그하려면 롱프레스로 단어 선택을 만든 뒤 selection handle 을 조정해야 한다.

과거에 hover 기반 발견이 있었으나 제거됐다(ADR-0148 Context). 그 방식은 **hover 한 줄의 모든 토큰**을 후보로 만들어 후보마다 `stat_path` IPC 를 한 번씩 돌렸고, Windows 에서는 WSL·UNC 해석이 후보 수만큼 반복돼 실질적으로 동작하지 않았다. 즉 제거된 이유는 "hover 라는 트리거"가 아니라 **트리거당 조회량이 무제한**이었다는 점이다. 그 뒤 ADR-0148 이 bounded batch `stat_paths`(입력 상한, WSL distro batch 당 1회 해석, 결과 순서 보존)를 도입했으므로, 트리거당 조회량을 상수로 묶을 수 있으면 hover 계열 트리거를 되살릴 수 있다.

범위는 desktop 과 browser Remote 의 path-link **발견 트리거**와 그 비용 상한이다. 후보 추출 문법(maximal-munch, `:line:col` 정리, strong candidate 휴리스틱), 링크 표시 방식(xterm decoration), 클릭 라우팅(파일=viewer, 디렉터리=cwd 전파), 수정자 클릭의 호스트 OS 위임(ADR-0100), Remote 권한 경계는 비목표이며 그대로 유지한다. scrollback 상시 탐색, Remote 의 hover(마우스) 트리거, 키보드 선택 트리거도 비목표다.

## Decision

**path-link 발견은 "선택 범위" 트리거에 더해 "포인터 지점" 트리거와 "유휴 화면" 트리거를 갖는다. 포인터 지점 트리거는 포인터 아래 maximal token 하나만 후보로 만들어 조회를 트리거당 정확히 1건으로 묶고, 유휴 화면 트리거는 Remote 전용으로 출력이 멈춘 뒤 보이는 화면 1장에 대해 bounded batch 1회만 수행한다.**

### 트리거 3종과 각자의 비용 상한

| 트리거      | surface         | 범위                          | 후보 상한          | stat 배치     |
| ----------- | --------------- | ----------------------------- | ------------------ | ------------- |
| `selection` | desktop, Remote | 선택 문자열                   | 16 (ADR-0148 유지) | gesture 당 1  |
| `point`     | desktop, Remote | 포인터 아래 maximal token 1개 | 1                  | 트리거당 1    |
| `screen`    | Remote          | 보이는 화면(viewport)         | 64                 | 유휴 진입당 1 |

- **`point` 후보 추출은 offset 하나를 덮는 maximal token 만** 만든다. 그 줄의 다른 토큰, 토큰 내부 substring, basename fallback 은 만들지 않는다. 단일 토큰을 명시적으로 지목한 입력이므로 ADR-0148 의 "단일 token 선택" 계약과 같게 슬래시·확장자 없는 맨이름(`laymux`)도 후보로 받으며, 존재 검증이 유일한 게이트다.
- **`screen` 후보 추출은 strong candidate 만** 받는다(절대경로·경로 구분자·확장자 중 하나). 사용자가 지목하지 않은 화면 전체가 범위이므로 일반 단어를 stat 하지 않는다.
- **`screen` 은 상한 초과 시 잘라서 부분 결과를 낸다.** `selection` 의 all-or-nothing(ADR-0148)과 의도적으로 다르다 — 사용자가 범위를 고르지 않은 ambient 표시이므로, 앞쪽 64개만 표시하는 것이 화면 전체를 포기하는 것보다 낫다. 줄 수·문자 수 상한(64줄, 8,192자)을 넘는 화면은 넘긴 뒤쪽을 버린다.
- 세 트리거 모두 기존 `terminal.pathLinkEnabled` 로 게이트되고 `terminal.pathLinkMaxLength` 를 후보별 길이 상한으로 적용한다. 트리거별 개별 설정은 만들지 않는다.

### 데스크톱 트리거 조건

- **hover dwell** — 포인터가 터미널 안에서 300ms 동안 click slop 을 넘지 않고 멈추면 그 지점을 `point` 로 평가한다. 버튼이 눌린 동안(선택 drag 진행 중)과 이미 검증된 밑줄 위에서는 평가하지 않는다. 포인터가 움직이면 타이머를 다시 잡는다.
- **click** — 이동 없이 끝난 primary pointer gesture(드래그 아님)는 release 지점을 `point` 로 평가한다. ADR-0165 의 "gesture 당 최대 1회"는 유지된다 — 드래그면 `selection`, 클릭이면 `point` 중 **하나만** 실행한다.
- **클릭은 발견이지 실행이 아니다.** 아직 검증되지 않은 문구의 클릭은 밑줄만 켠다. 실제 열기(viewer/cwd 전파/OS 위임)는 **이미 검증된 밑줄** 위의 클릭에서만 일어난다. 그래서 셸 프롬프트나 로그의 파일명을 커서 이동·포커스 목적으로 클릭했다가 viewer 가 열리는 일이 없다.
- 같은 (버퍼 라인, 토큰, cwd) 조합은 **조회가 끝난 뒤에도, 조회가 도는 중에도** 재평가하지 않는다. 끝난 지점만 기억하면 느린 stat 이 도는 동안 dwell 이 같은 토큰에 대해 300ms 마다 새 배치를 만든다. 포인터가 한 토큰 안에서 click slop 안으로 떠는 것은 타이머를 다시 잡지도 않는다.
- 출력이 도착하면 음성 결과 기억("여기는 파일이 아니다")만 잊고 **진행 중 조회는 살린다**. 출력마다 진행 중 조회를 무효화하면 출력이 잦은 pane 에서 hover 가 밑줄을 영원히 켜지 못한다.

### Remote 트리거 조건

- **단일 탭** — URL 링크 활성화(§8.6)가 먼저이며, 링크가 아니고 기존 밑줄 위도 아니면 그 지점을 `point` 로 평가한다. 선택이 살아 있으면 평가하지 않는다 — 더블클릭의 두 번째 release 는 단어 선택이 생긴 뒤에 도착하므로, 이 게이트가 없으면 같은 셀에 `point`·`selection` 밑줄이 겹친다. 밑줄 위 탭은 기존대로 viewer 를 연다(탭 1회 = 발견, 탭 2회 = 열기).
- **롱프레스·더블탭** — 기존 단어 선택 경로를 유지한다. 선택이 생기므로 기존 `selection` 트리거가 그대로 발견을 담당한다.
- **유휴 화면** — 터미널 write 가 도착하면 `screen` 결과를 즉시 폐기하고 유휴 타이머를 다시 잡는다. 500ms 동안 write 가 없으면 보이는 화면 1장을 `screen` 으로 평가한다. 직전 스캔과 화면 텍스트가 동일하면 요청하지 않지만, 이 생략은 **그 스캔의 밑줄이 아직 화면에 남아 있을 때만** 성립한다 — 예약이 밑줄을 먼저 거두므로 무조건 생략하면 커서만 움직이는 write 하나로 표시가 영구히 사라진다. 선택이 살아 있는 동안, alternate buffer 전환·resize·terminal/lease 전환 중에는 스캔하지 않는다.
- Remote 는 여전히 경로도 cwd 도 제안하지 않는다(ADR-0045). 클라이언트가 보내는 것은 자신이 이미 렌더한 텍스트와 좌표뿐이다.

### 계약 변경

- Remote `POST /remote/v1/file-viewer/path-link` 요청은 `{terminalId, selection}` 에서 **`{terminalId, mode, lines, caret?}`** 로 바뀐다. `mode` 는 `"selection" | "point" | "screen"`, `lines` 는 그 mode 의 텍스트 범위, `caret` 은 `point` 모드에서 `{lineIndex, index}`(UTF-16 offset)다. 서버는 mode 별 상한(줄 수·총 문자 수·terminalId 길이)을 검사하고 텍스트는 trim 하지 않는다 — 토큰 정리는 desktop parser 가 소유한다. 응답 shape(`{valid, matches:[{token, path, lineIndex, startIndex, endIndex}]}`)은 유지한다. page 는 desktop 바이너리에 내장되어 함께 배포되므로 migration 은 없다.
- **`stat_paths` 는 main 스레드에서 돌지 않는다.** `#[tauri::command]` 의 기본값은 `tauri-macros` 의 `ExecutionContext::Blocking` 이라 sync 커맨드 본문이 IPC 를 처리하는 앱 main/event-loop 스레드에서 인라인 실행된다. 이 커맨드는 최대 64회 `fs::metadata` 와 (POSIX 후보가 있으면) 기본 WSL distro 해석을 하므로, 응답이 느린 UNC·네트워크 경로나 차가운 `wsl.exe` 프로브가 그대로 창을 멈춘다. 트리거가 잦아진 만큼 이 차이는 사용자에게 보이므로 `#[tauri::command(async)]`(sync 함수 → `sync_threadpool`)로 async runtime 에 넘긴다. 프런트엔드 계약(`invoke` 반환 Promise)은 그대로다.
- **기본 WSL distro 해석은 캐시를 쓴다.** `wsl.exe --list`(3초 타임아웃) 프로세스 스폰을 트리거마다 지불하지 않도록 `path_utils::get_default_wsl_distro` 자체가 `wsl_probe::default_distro_cached`(TTL 60초, 안전한 distro 이름만)로 위임한다. 캐시를 `stat_paths` 호출부에만 두면 부족하다 — 배치가 distro 를 `None` 으로 넘기면 `resolve_address_path` 가 **경로마다** 캐시 없는 프로브를 돌려, POSIX 후보 64개짜리 화면 하나가 스폰 64회가 된다.
- `stat_paths` 의 배치 상한은 16 에서 **64** 로 올린다. `screen` 트리거의 화면 1장이 16개를 넘는 경로를 담을 수 있고, 이 상한은 "한 번의 배치가 만들 수 있는 최대 fs 조회 수"라는 의미를 그대로 유지한다. `selection` 의 후보 상한 16 은 바뀌지 않는다.
- 검증된 링크는 **트리거 scope 별로 소유**된다. `selection`·`point`·`screen` 은 서로 다른 decoration 집합이며, 자기 scope 만 교체·해제한다. hit-test 는 모든 scope 를 함께 본다. 선택이 새로 생기면 `point` scope 를 비운다 — 같은 지점에 두 밑줄이 겹치지 않게 한다.
- 검증된 링크는 원문이 그 자리에 남아 있는 동안만 유효하다. 화면 재출력으로 밑줄 아래 텍스트가 바뀌면 해당 항목을 폐기한다. **두 surface 모두** write 시점에 남아 있는 scope 를 재검사한다 — desktop 은 `onWriteParsed`, Remote 는 write 완료 콜백이며, 어느 쪽도 표시 중인 링크가 없으면 버퍼를 읽지 않는다. 그래서 검증된 링크는 재검사용 원문 토큰을 함께 들고 있어야 한다(마커가 살아 있으면 마커의 현재 라인을 신뢰한다 — scrollback trim 이 저장된 라인 번호를 밀기 때문이다).

## Alternatives Considered

- **hover 에서 그 줄 전체를 후보로 만든다.** 한 번 멈추면 그 줄의 모든 경로에 밑줄이 켜져 편하지만, 트리거당 후보 수가 줄 내용에 따라 변하고 과거에 제거된 방식과 같은 실패 모드(느린 hover)를 다시 만든다. bounded batch 로 IPC 횟수는 1회로 줄지만 파싱·조회량 상한이 입력 의존이라는 성질이 남는다.
- **hover/클릭에서도 화면 전체를 스캔한다.** 표시는 가장 풍부하지만 hover 마다 화면 스캔이 돌아 비용이 최대가 되고, 캐시를 도입하면 파일 생성·삭제에 대해 stale 표시가 생긴다.
- **클릭 한 번으로 검증 후 즉시 연다.** 조작 수가 최소지만, 커서 이동·포커스·선택 시작 같은 평범한 클릭이 파일 viewer 를 열거나 cwd 를 전파하는 오동작을 만든다. 발견과 실행을 분리하면 오동작 가능성이 사라지고 실행 경로는 기존 계약(밑줄 위 클릭)과 동일하게 유지된다.
- **데스크톱에도 유휴 화면 스캔을 넣는다.** 밑줄이 미리 떠 있어 발견성이 가장 좋지만, hover dwell 이 이미 같은 문제를 트리거당 1건으로 해결하고, 상시 스캔은 조용한 pane 에서도 주기적 fs 조회를 만든다. 데스크톱은 포인터가 항상 있으므로 ambient 스캔의 이득이 작다.
- **stat 결과를 TTL 캐시한다.** 재스캔 비용을 줄이지만 파일 생성·삭제 직후 오답이 캐시 수명만큼 남는다. Remote 는 화면 텍스트 동일성 비교로, 데스크톱은 (라인, 토큰, cwd) 동일성 비교로 재조회를 막아 캐시 없이 같은 효과를 낸다.
- **트리거마다 설정 토글을 만든다.** 취향 차이를 흡수하지만 설정 표면이 4개로 늘고 각 조합의 테스트 부담이 생긴다. 모든 트리거의 비용이 상수로 묶여 있으므로 기존 `pathLinkEnabled` 하나로 둔다.

## Consequences

- 사용자는 드래그 없이 경로를 발견할 수 있다. 데스크톱은 멈추거나 클릭하면 밑줄이 켜지고, Remote 는 출력이 멈춘 뒤 화면의 경로가 미리 밑줄로 떠 있으며 탭 한 번으로 개별 경로를 켤 수 있다. `copyOnSelect` 를 켠 사용자가 경로를 열기 위해 clipboard 를 덮어쓰는 일도 없어진다.
- filesystem 조회는 UI 스레드를 잡지 않는다. WebView 쪽은 `invoke` Promise 뿐이고, Rust 쪽은 `sync_threadpool` 에서 돈다. WebView 스레드에서 동기로 남는 일은 트리거당 셀 읽기 — 데스크톱은 표시 중인 링크 수만큼의 한 줄 재검사(링크가 없으면 즉시 반환), Remote 는 유휴 진입당 화면 1장(≤64줄) 읽기다.
- 조회량은 트리거당 상수다. hover·클릭·탭은 batch 1건, Remote 유휴 스캔은 화면 1장당 batch 1건(고유 경로 최대 64). 드래그 중에는 여전히 조회가 없다(ADR-0165 유지).
- `screen` 트리거는 부분 결과를 낸다. 경로가 64개를 넘는 화면에서는 뒤쪽 경로에 밑줄이 없으며, 이는 `selection` 의 all-or-nothing 과 다른 의도된 비대칭이다.
- Remote 요청 shape 이 바뀌므로 구형 page 와 신형 bridge 의 혼용은 fail-closed(밑줄 없음)다. `stat_paths` 상한 상향은 desktop 커맨드 계약을 완화하는 변경이므로 기존 호출자는 영향받지 않는다.
- 유휴 스캔은 출력이 잦은 pane 에서 밑줄이 나타났다 사라진다. write 마다 폐기하고 유휴 500ms 뒤 다시 그리는 것이 stale 밑줄보다 안전하다는 판단이다. 화면이 계속 갱신되는 pane 에서는 밑줄이 거의 뜨지 않으므로, 그 상태에서 경로를 열려면 탭(`point`)이나 선택을 쓴다.
- 회귀 테스트는 ① `point` 추출이 offset 을 덮는 토큰 하나만 내는지(내부 substring·이웃 토큰 없음), ② `screen` 추출이 strong candidate 만 받고 상한에서 잘리는지, ③ hover dwell 이 드래그 중·밑줄 위·동일 토큰 재방문에서 조회를 만들지 않는지, ④ 이동 없는 클릭이 `point` 1건만, 드래그가 `selection` 1건만 만드는지, ⑤ 미검증 문구 클릭이 열기를 유발하지 않는지, ⑥ Remote mode 별 상한·caret 검증과 유휴 스캔의 write 폐기·동일 화면 skip, ⑦ 화면 재출력이 밑줄을 폐기하는지, ⑧ `stat_paths` 새 상한을 고정한다.
- 트리거를 더 넓히거나(scrollback, Remote hover) 상한을 바꾸면 조회량의 의미가 달라지므로 이 ADR 의 표와 living doc 을 함께 갱신한다.
