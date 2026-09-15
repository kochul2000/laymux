# Codex 공용 로그 정리 뒤 업데이트 귀속 실패

2026-09-15, base `f56f88f1`, Laymux dev 19281, 실제 Windows·WSL Codex 0.154.0.

## 원본 pane에서 확인한 증거

`terminal-pane-401f5b39`는 `ai2-chore` workspace의 WSL pane이다. 조사 시 원래 프로세스는 이미 종료돼 있었다. 해당 pane의 출력 캐시에 남은 resume ID `01a09f19-3ae6-7013-a8b5-0cbad814c07d`로 WSL 진단 DB를 읽기 전용 조회했다.

같은 process UUID `pid:3155218:d0ebc38b-9d2f-47e7-a04a-bb715ca5b073`에 다음 기록이 남아 있었다.

| 증거 | 로그 ID |
| --- | --- |
| 최초 대화의 TUI thread/start | 140847011 |
| 이후 새 대화 `01a09f3e-5980-7b50-a253-8cf725d36861`의 TUI thread/start | 140855032 |
| 남아 있는 첫 threadless 로그 | 140871502 |

새 대화의 시작 기록은 정확한 ID를 포함하며 rollout과 session-loop 기록은 없었다. 기존 조회는 **첫 threadless 로그를 프로세스 시작점으로 간주**하고 `id >= 140871502`만 읽어 두 시작 기록을 모두 제외했다. 따라서 lifecycle 선택 결과가 없어지고 실행 중 Codex가 `ActiveButUnidentified`로 분류됐다. 공용 로그가 전부 사라지면 process UUID 선택 자체도 같은 부분 인덱스에서 누락될 수 있었다.

이 문제는 시간 경과나 미방문 pane 예외로 해결되지 않는다. 필요한 대화 증거가 남아 있어도 잘못된 SQL 범위가 그것을 숨기는 문제다. 원본의 오류 발생 순간을 직접 관측한 것은 아니며, 아래 dev 실험에서 동일한 DB 조건과 업데이트 실패의 인과관계를 확인했다.

## 실제 dev 재현과 수정 후 비교

APPDATA·WebView 저장소를 `.tmp/update-attribution-20260915`로 격리했다. dev PID 51768의 health에서 worktree와 base commit을 대조했다. 기존 `ui/scripts/repro-agent-session-checkpoint.mjs`로 테스트 workspace를 만들었다.

1. 테스트 WSL pane에서 `CODEX_HOME`과 `CODEX_SQLITE_HOME`을 `/tmp/laymux-codex-retention-home`으로 지정해 실제 Codex를 실행했다. 인증 파일은 기존 파일을 가리키는 링크를 사용했고, 테스트 DB와 대화 저장소는 분리했다.
2. trust와 초기화 완료 후 `Fresh` 및 실제 `flushSessionCheckpoint({reason:"update",requireConclusive:true})` 성공을 확인했다.
3. 테스트 DB에 후속 threadless 행을 남기고 **그 프로세스의 앞선 threadless 행만** 정리했다. 대화 시작 행 79는 보존했고 첫 threadless 행은 125가 됐다.
4. 같은 CLI PID 2026525에서 `ActiveButUnidentified`와 `Session attribution is not conclusive for terminal-pane-empty-repro-codex: activeButUnidentified`를 재현했다.
5. CLI·DB·dev를 재시작하지 않고 수정한 WSL 조회 도구만 교체했다. 동일한 대화 `01a0a520-138b-7881-bc64-c631ffd2d258`가 `Fresh`로 복구되고 critical checkpoint가 통과했다. settings.json에 `lastAgentFresh=codex` 저장도 확인했다.
6. 해당 프로세스의 threadless 로그를 **모두** 제거한 뒤에도 동일 ID와 critical checkpoint 성공을 확인했다.

설치 프로그램 실행까지 검사한 것은 아니다. 검사 대상은 업데이트가 실제 사용하는 귀속 조회·이중 안정 관측·설정 저장 경로다. 새 전체 dev 빌드를 PID 49420으로 기동한 뒤 Windows native Codex에서도 신규 대화 `Fresh`와 critical checkpoint 성공을 확인했다.

이번 실행의 로컬 산출물은 `.tmp/update-attribution-20260915/`의 `before-fix-checkpoint.json`, `after-fix-checkpoint.json`, `after-all-threadless-pruned.json`, `native-dev-checkpoint.json`이다. 테스트 DB 정리 절차는 같은 디렉터리의 `prune-test-logs.py`에 있으며 정확한 테스트 pane marker와 전용 DB 경로를 검증한다.

## 수정과 검증

native `find_process_uuid_checked`와 동봉 WSL 도구 모두 최신 process UUID와 첫 로그를 threadless 부분 인덱스 대신 남아 있는 전체 행에서 구한다. 이후의 lifecycle·레거시 후보 조회는 계속 정확한 process UUID에 제한한다. 오래된 incarnation 배제, 잘못된 pane 거부, 충돌·손상·미확정 상태의 보호 검사는 유지한다.

- TDD: native 회귀 테스트와 WSL WAL 테스트에서 먼저 실패를 확인한 뒤 수정했다. 앞선 공용 로그만 정리된 경우와 현재 프로세스의 공용 로그가 모두 사라진 경우를 검사한다. native 테스트는 rollout 생성 후 정확한 resumable ID도 확인한다.
- `cargo test -p laymux --lib commands::codex_session`: 28개 통과.
- `cargo test -p laymux-wsl-codex-probe`: 1개 통과.
- Windows `ui/`에서 `npm test -- src/lib/persist-session.test.ts`: 92개 통과.
- `cargo clippy --workspace --all-targets -- -D warnings`, dev 전체 빌드, 정적 Linux 도구 빌드 통과.
- 원본 WSL DB의 크기는 약 860 MB였으며, 남은 행의 process UUID 전체 조회는 warm 상태에서 약 15 ms였다. 전체 행 읽기의 비용을 무시하거나 부분 인덱스를 다시 시작 경계로 사용하는 최적화는 피한다.

PR 준비 시 최신 main `5a266eac`에 이번 수정만 적용한 별도 워크트리에서 다시 검증했다. Codex 관련 Rust 테스트 36개(추가된 턴 상태 조회 포함), WSL 도구 테스트 1개 및 strict workspace/all-targets clippy가 통과했다. 위 dev 실측은 최초 base `f56f88f1`에서 수행한 기록이다.

ADR: [0238](adr/0238-codex-lifecycle-storage-checkpoint.md), [0118](adr/0118-codex-session-pid-attribution.md)의 직접 적용. 프로세스별 정확 귀속이라는 기존 결정을 잘못 구현한 조회를 수정하며 새 API·상태·소유권 결정은 추가하지 않는다.
