# Claude 공유 대화의 종료 체크포인트 재현

기준 `a73263ed`(v3.15.2), `fix/unvisited-workspace-session-checkpoint`의 working diff. ADR: [0383](adr/0383-claude-shared-conversation-process-attribution.md).

## 사용자 증거와 원인

보고된 `terminal-pane-336c24fa`의 로컬 DB 귀속은 `activeButUnidentified / claude`였다. 해당 marker를 가진 WSL Claude PID의 세션 파일에는 정확한 ID가 있었다. 다른 pane의 살아 있는 Claude PID 파일도 같은 ID를 명시했고, 실제 명령은 각각 `-c`와 `--resume <동일 ID>`였다. 사용자 프로세스·파일은 읽기만 수행했고 release API·입력·종료는 사용하지 않았다. 대화 본문은 읽지 않았다.

기존 native 중복 제거와 native/WSL 최종 중복 제거는 session ID가 같으면 정확한 PID 증거까지 버렸다. 이때 일반 저장은 복원 ID를 제거하고 critical 저장은 동일 오류로 중단한다. 수정은 대화 ID가 아니라 프로세스 키(native PID 또는 WSL distribution/PID)의 다중 소유를 거부한다. 서로 다른 Claude 프로세스의 동일 대화 ID와 각 terminal의 상태·config root는 보존한다.

미방문 여부 자체를 원인으로 확정하지 않는다. 이번 dev에서 PTY에 아직 재결합하지 않은 미방문 workspace는 저장이 성공했다. 두 live PTY가 관측되면 수정 전에는 렌더러·방문 여부와 무관하게 중복 검사에서 실패했다.

## 격리 dev 검증

포트 19281, health의 dev/worktree/commit 확인. APPDATA `.tmp/unvisited-checkpoint/appdata`, LOCALAPPDATA `.tmp/u/l`, 별도 WebView2 폴더와 CDP 9229, `VITE_LAYMUX_STRICT_MODE=0`, `cargo tauri dev --no-watch`를 사용했다. LOCALAPPDATA 경로가 길면 daemon AF_UNIX 경로 제한으로 local PTY fallback이 되므로 짧은 격리 경로를 사용하고 실제 daemon inventory를 확인했다.

`ui/scripts/fixtures/shared-claude.py`는 WSL에서 프로세스 이름을 Claude로 지정하고 격리 HOME의 PID 파일을 작성한다. 두 PID는 같은 대화 ID, 서로 다른 busy/idle 상태를 제공하며 생존 tick을 출력한다. provider 네트워크나 실제 대화를 제출하지 않는다. 실제 Claude CLI 재기동·대화 동시 편집의 동등성을 주장하는 fixture는 아니다. 실제 사용자 CLI에서 확인한 PID 파일 조합을 귀속 파이프라인에 재현한다.

| 조건 | 결과 |
|---|---|
| 수정 전, 두 workspace 미방문·frontend terminal instance 없음 | 3회 모두 양쪽 `activeButUnidentified`, critical 저장 거부, `saveBeforeClose` 동일 오류 |
| 수정 후 동일 조건 | 3회 `identified`, critical 저장·`saveBeforeClose` 성공, DB 재조회로 양쪽 ID 보존 |
| GUI만 종료 후 재기동, 두 workspace 미방문·PTY 미재결합 | coverage에 가짜 live terminal을 추가하지 않고 3회 저장 성공, 기존 ID 보존 |
| 동일 daemon PTY에 렌더러 없이 재결합 | 3회 저장·종료 준비 성공. child PID 5788/33652, daemon session ID 동일, attachEpoch 1→2 |
| 재기동 후 생존 증거 | 같은 guest PID 2299661의 실제 출력 tick 16→78. 재생 캐시만으로 판정하지 않음 |
| 한 workspace 방문, 다른 workspace 미방문 | 3회 저장 성공, 양쪽 ID 보존, running/idle 상태가 각 pane에 유지 |
| 한쪽 fixture PID 파일의 JSON 손상 | 3회 해당 pane만 `unknown`, 다른 pane은 `identified`, critical 저장 거부 |
| 손상 복구 후 실제 업데이트 준비 API | `POST /api/v1/dev/update-handoff {mode:prepare}` 성공, commit 44, 출력 캐시 완료 4/4. 설치기는 호출하지 않음 |
| 실제 창 닫기→종료 확인 버튼 | 정상 창 종료 관측, 종료 후 SQLite의 양쪽 귀속과 `lastClaudeSession` 보존 확인 |

dev screenshot으로 방문 pane의 live tick과 오류 없는 확인 화면을 확인했다. 테스트 끝에 공식 `kill-dev.sh --with-daemon`으로 격리 dev 자원을 정리했다. 원시 JSON·PNG·로그는 `.tmp/unvisited-checkpoint/`에 보관한다.

## 재실행

Windows `ui/`에서 `LAYMUX_REPRO_ISOLATED=1`을 지정하고 `node scripts/repro-shared-claude.mjs setup`을 실행한다(수정 전 실패 판정 기대). 수정 후에는 `LAYMUX_EXPECT_FIXED=1`을 추가한다. 같은 APPDATA/LOCALAPPDATA로 공식 kill-dev 스크립트의 기본 모드로 GUI만 종료·재시작한 뒤 `startup`, `reattach` 모드를 순서대로 실행한다. 다시 GUI만 재시작한 뒤 `visit` 모드를 실행하면 방문 상태를 확인할 수 있다. `setup`은 daemon까지 정리한 격리 프로필에서만 실행한다. `startup`·`visit`는 실제 종료를 별도로 검사할 수 있게 종료 fence를 남기지 않는다.

## 회귀 검사와 범위

- 공유 대화 회귀를 수정 전에 실행하여 실패(기존 결과 0, 기대 2)를 확인했다.
- Claude 관련 Rust 25개, 전체 Rust command 계층 664개 통과(기존 ignored 11개).
- UI 저장·snapshot·종료 확인 3파일 160개 통과.
- `cargo clippy --workspace --all-targets -- -D warnings`, Rust fmt, 재현 스크립트 ESLint/Prettier 통과.
- native/WSL PID namespace 분리, 같은 프로세스 다중 소유 거부, PID 파일 불일치의 실패 범위, 기존 손상·누락·최상위 선택 검사를 유지했다.
- dev 실기는 Windows 호스트의 WSL fixture다. native 실제 Claude CLI, 실제 설치기·다른 provider의 공유 대화 허용은 검증·변경 범위 밖이다.
