# 0118. Codex 세션 복원은 PTY 자식 PID로 정확히 귀속한다

- Status: Accepted
- Date: 2026-08-02
- Source: 사용자 요구와 리뷰 코멘트, [architecture/data-flow.md §13](../architecture/data-flow.md#13-session-persistence--cache), [ADR-0117](0117-codex-session-restore.md) 대체, Codex CLI 0.146 로컬 `logs_*.sqlite`/`state_*.sqlite` 관측
- Supersedes: [ADR-0117](0117-codex-session-restore.md)

## Context

ADR-0117은 Codex rollout에 PTY PID나 laymux pane ID가 없다는 제약 때문에 terminal CWD와 최신 수정 시각으로 세션을 추정했다. 같은 CWD의 pane이 둘 이상이면 모두 같은 최신 세션을 선택해 서로 다른 pane이 한 대화를 중복 resume할 수 있다. 날짜 디렉터리 이름은 생성일인데 수정 시각 cutoff의 UTC 날짜로 디렉터리를 미리 제외한 최적화도 자정을 넘긴 활성 세션을 누락시킨다.

종료 흐름은 기본 설정에서 terminal을 먼저 interrupt하고 세션 ID를 나중에 수집한다. Codex가 Ctrl+C로 종료되어 `known_codex_terminals`에서 제거되면 최초 저장 기회를 잃는다. 복원 토글에 따른 수집 정책도 Claude와 Codex가 달라 같은 설정 개념이 provider별로 다른 영속 결과를 만든다.

Codex의 rollout header 자체에는 pane attribution이 없지만, Codex의 bounded SQLite 진단 저장소는 로그 행마다 OS PID를 포함한 `process_uuid`와 현재 `thread_id`를 함께 기록하고, state 저장소는 thread ID와 rollout 경로를 연결한다. laymux는 이미 PTY child의 프로세스 트리를 provider 판정의 ground truth로 사용한다. 이 두 정보를 결합하면 CWD 추정 없이 pane과 Codex thread를 연결할 수 있다.

범위는 native Windows/Linux Codex CLI의 정확한 세션 귀속, 종료 전 스냅샷, 관련 설정 영속 불변식이다. WSL 내부 상태 저장소 자동 탐색과 Codex SQLite 스키마 변경을 추측 복구하는 호환 계층은 비목표다.

## Decision

Codex 세션 ID의 SoT는 **PTY descendant의 실제 Codex PID와 Codex 진단 DB가 함께 증명한 top-level thread ID**이며, 증명할 수 없으면 복원하지 않는다.

- process tree에서 각 terminal의 가장 얕은 interactive Codex 프로세스 PID를 얻는다. 같은 CWD 여부는 attribution에 사용하지 않는다.
- 최신 `logs_*.sqlite`에서 현재 PID의 가장 최신 `process_uuid`를 선택하고, 그 process UUID에 기록된 thread ID를 최신 로그 순으로 조회한다. `state_*.sqlite`의 rollout 경로와 header를 대조해 top-level interactive session임을 검증한다.
- Claude도 PTY descendant PID와 `~/.claude/sessions/<pid>.json`이 직접 일치할 때만 귀속한다. 기존 CWD 최신 fallback은 제거하고, provider와 무관하게 중복 session ID는 충돌한 모든 pane에서 제외한다.
- 서로 다른 terminal에 같은 session ID가 귀속되면 어느 쪽도 저장하지 않는다. 중복을 차순위 CWD 후보로 보정하지 않는다.
- DB 파일·테이블·행·rollout 검증 중 하나라도 없거나 불일치하면 해당 pane은 fail-closed 한다. CWD 최신 fallback은 두지 않는다.
- rollout age는 파일 수정 시각만 정확한 게이트로 사용한다. 생성일 디렉터리 pruning은 제거한다. DB가 제공한 경로를 우선하고, 정확한 ID의 파일명 검색만 보수적 fallback으로 허용한다.
- window close는 settings/session snapshot을 terminal interrupt 전에 완료해 attribution 대상 PID와 provider 집합을 보존한다. scrollback 직렬화는 기존처럼 interrupt 뒤에 수행한다.
- `restoreSession`은 다음 terminal 시작에서 resume 명령을 실행할지만 제어한다. Claude와 Codex 모두 설정이 꺼져도 현재 정확한 ID를 수집·보존하며, 다시 켜도 한 번의 복원 기회를 잃지 않는다.
- 저장된 Claude/Codex ID가 동시에 존재하면 읽기 경로는 provider를 추측하지 않고 새 세션으로 시작한다. 저장 경로는 하나를 기록할 때 반대 provider 키를 실제로 삭제한다.

## Alternatives Considered

- 같은 CWD 후보를 최신순으로 서로 다르게 greedy 배정: 중복은 막지만 어느 pane이 어느 대화인지 증명하지 못해 A/B를 뒤바꿀 수 있다.
- 중복된 두 번째 pane만 복원하지 않기: 손상 위험은 줄지만 사용자가 요구한 pane별 정확한 복원을 제공하지 못한다.
- rollout 생성 시각과 process 시작 시각의 근접도 매칭: 동시 실행과 resume에서 생성 시각이 process 시작 시각과 일치하지 않아 추정이 남는다.
- Codex `SessionStart` hook 또는 `notify`를 강제 주입: 정확한 ID를 받을 수 있지만 사용자 hook trust/config를 변경하거나 기존 notify를 덮어쓰는 외부 설정 소유권이 생긴다.
- pane별 `CODEX_HOME` 격리: sessions 외에도 auth/config/plugins/state 전체를 갈라 인증과 설정 일관성을 깨뜨린다.
- app-server 기반 자체 Codex client로 전환: thread ID 계약은 안정적이지만 terminal TUI 실행 모델 전체를 바꾸는 별도 제품 결정이다.

## Consequences

같은 디렉터리의 여러 Claude/Codex pane도 각 PTY 아래 실제 agent 프로세스가 증명한 서로 다른 session으로 복원된다. 잘못된 세션을 여는 것보다 복원을 생략하는 정책이 우선하며, 날짜 경계와 interrupt 순서로 인한 조용한 누락도 제거된다.

비용은 Codex 내부 SQLite 스키마와 `process_uuid` 형식에 대한 읽기 전용 어댑터 및 SQLite 의존성이다. 버전 접미사는 탐색하지만 스키마를 추측 마이그레이션하지 않는다. Codex가 진단 DB 형식을 바꾸면 해당 pane은 안전하게 새 세션으로 시작하고 debug 진단을 남긴다. 공식적으로 안정된 PID/thread attribution API가 제공되면 DB 어댑터를 대체한다.

native host의 `CODEX_HOME`과 `CODEX_SQLITE_HOME`은 지원한다. Windows host에서 WSL 내부 경로나 shell profile 안에서만 설정된 상태 루트, Codex config/명령행에서만 재정의한 `sqlite_home`은 자동 탐색하지 않으며, 이 경우에도 CWD fallback으로 낮추지 않는다.
