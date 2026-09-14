# 0248. Codex 작업 상태는 현재 세션의 턴 기록으로 판정한다

- Status: Proposed
- Date: 2026-09-14
- Source: 사용자 Codex 영구 모래시계 제보 및 수정안 선택, Codex 0.154.0 소스·dev WSL 실측, architecture/data-flow.md §9·§13.5
- Amends: ADR-0147의 Codex 완료 추론, ADR-0238의 세션 식별 결과 활용 범위
- References: [Codex 0.154.0 저장 정책](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/rollout/src/policy.rs), [턴 종료 및 flush](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tasks/mod.rs), [Hooks 계약과 transcript 형식 한계](https://learn.chatgpt.com/docs/hooks), [App Server](https://learn.chatgpt.com/docs/app-server)

## Context

Astra 반짝이는 유휴 입력부도 반복해서 다시 그린다. 따라서 화면 프레임·출력량의 증가와 감소는 Codex 턴의 시작·완료를 증명하지 않는다. Working의 색상 애니메이션도 같은 경로로 감지되므로 색상 출력만 제외할 수 없다. 타이틀 구성은 사용자 설정이며, 한 번 스피너를 관측했다고 이후 타이틀이 반드시 상태를 나타내는 것도 아니다.

Codex 0.154.0은 rollout JSONL에 task_started, task_complete, turn_aborted를 저장한다. laymux는 이미 훅 설치 없이 프로세스별 TUI 대화 전환 기록으로 현재 세션을 식별한다. 이 연결을 재사용하되 내부 형식 의존과 조회 지연을 명시한다. Codex 실행 방식·설정·렌더링 변경은 범위 밖이다.

## Decision

현재 pane에 귀속된 Codex 세션의 턴 기록을 작업 상태의 주 신호로 사용하고, 출력 활동은 독립적으로 보존한다.

- Rust 조회는 기존 세션 식별 경로를 재사용한다. PTY generation·프로세스에 속한 대화 선택 로그 ID·session ID로 관측을 구분하며, 오래된 세션 파일이나 CWD로 추측하지 않는다. 복원용 fallback만으로 얻은 세션은 턴 상태의 증거가 아니다.
- 파일을 처음 읽을 때는 끝의 제한된 구간을 읽고, 이후 추가된 바이트만 읽는다. 불완전한 줄·읽기 상한·파일 교체/축소·파싱 실패를 완료로 합성하지 않는다. 현재 턴과 다른 지연 종료 이벤트는 새 턴을 종료하지 않는다.
- 프론트는 단일 진행 중 요청으로 주기 조회하며 원시 codexTurn과 outputActive를 분리한다. CodexActivityHandler가 running/completed/failed/interrupted/idle/unknown을 표시·절전 억제·clear 보호에 일관되게 적용한다. completed는 턴 종료이며 전체 goal 달성을 뜻하지 않는다.
- 첫 관측과 세션 전환은 상태만 복원하고 과거 완료 알림을 재생하지 않는다. 같은 관측 세션에서 새로 확인한 성공 종료만 알림을 만든다. 조용해진 화면·중단·오류·조회 실패는 성공 알림의 근거가 아니다. 조회 실패/미확인에서는 출력·타이틀을 보조로 쓰고 이전 셸 성공 코드를 Codex 성공으로 승격하지 않는다.
- Windows native 및 Linux는 std::fs, WSL의 일반 rollout 파일은 기존 guest 경로 변환을 사용한다. SQLite 조회는 기존 bundled WSL 도구를 유지한다. 캐시 mutex는 AppState 락을 잡지 않은 채 취하는 leaf이며, 파일 I/O 중 AppState에 재진입하지 않는다.

## Alternatives Considered

- 타이틀·Working 텍스트·SGR 패턴: 사용자 설정과 TUI 버전에 의존하며 장식과 작업을 일반적으로 구별하지 못한다.
- Stop 훅/notify: 설치·신뢰 절차가 필요하다. Stop은 continuation 전일 수 있고 notify는 시작·중단을 단독 추적하지 못한다.
- 공용 App Server: 공식 상태 이벤트가 가장 직접적이나 TUI를 같은 서버에 연결하도록 프로세스 실행·연결 소유권까지 바꿔야 한다.
- 매번 전체 transcript 읽기: 이미 긴 세션에서 불필요한 I/O와 JSON 파싱이 반복되므로 제한된 초기 읽기와 증분 읽기를 택한다.

## Consequences

반짝이를 유지하면서 완료를 표시하며 타이틀 비활성화·조용한 도구 실행에도 상태를 유지한다. 내부 JSONL와 진단 로그 형식은 공개 호환 계약이 아니므로 버전별 회귀 검증이 필요하다. 초기 제한 구간에 lifecycle이 없거나 파일을 읽지 못하면 unknown으로 남을 수 있다. 상태 반영에는 조회 주기와 기존 WSL probe 시간이 더해지며 즉시성은 보장하지 않는다. Windows·WSL dev에서 연속 턴·중단·세션 전환과 반짝이 재현을 검증하고, 파서·표시·알림의 실패 경계를 자동 테스트한다. Codex가 관측 가능한 공식 구독 경로를 제공하거나 내부 형식 유지 비용이 커지면 App Server 통합을 재검토한다.
