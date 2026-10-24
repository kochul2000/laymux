# 0356. Grok 훅을 독립 provider로 검증하고 초안을 비운 뒤 clear한다

- Status: Accepted
- Date: 2026-10-24
- Source: 사용자 요구(Grok까지 상태·Alt+L 대응), [#1252](https://github.com/kochul2000/laymux/issues/1252), Windows Grok Build 1.0.50(c58f321264ba) 및 WSL 1.0.62·1.0.70 실측, [공식 훅 문서](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md), ADR-0009, ADR-0156, ADR-0282, ADR-0283, ADR-0321, ADR-0355
- 관계: ADR-0156의 출력 기반 작업 미확인 표시와 ADR-0355의 Grok 제외 범위를 확장한다. 세션 귀속과 훅 선택 설치·기본 휴리스틱 정책은 유지한다.

## Context

Grok Build는 세션·프롬프트·도구·완료·실패·중단·알림 훅을 제공하지만 laymux는 Claude·Codex만 훅 provider로 인정한다. Grok은 Claude 호환 훅도 자동으로 읽으므로 같은 helper가 Grok 이벤트를 Claude로 전송해서는 안 된다. 기존 Grok 화면 갱신 fallback은 타이핑을 작업 중으로 표시할 수 있고, Alt+L은 기존 초안 뒤에 `/clear`를 붙인다.

훅 pane ID와 상속 환경은 현재 대화 소유권을 증명하지 않는다. 기존 Grok 프로세스 PID와 active_sessions.json 기반 정확한 세션 귀속을 유지하고, Stop 훅 실행만으로 성공을 합성하지 않아야 한다. Windows·Linux·WSL의 선택 설치와 사용자 훅 보존도 필요하다.

실제 WSL 시작 화면의 `Coming from Claude Code?` 안내가 Claude 배너로 오인되어, 실행 중인 Grok도 셸로 분류됐다. 앱 생존의 권위는 ADR-0009를 그대로 적용하며 이 안내 문구보다 확인된 프로세스를 우선한다. 새 세션의 `SessionStart.source=new`도 실제 입력 대기 상태로 반영해야 한다.

## Decision

**Grok을 독립적인 선택 설치 훅 provider로 추가하고, 검증된 현재 대화·턴 관찰로 작업 상태를 선택하며, 현재 입력창과 입력 revision을 확인한 뒤 clear한다.**

- Grok 설치 루트는 `GROK_HOME` 또는 사용자 홈의 `.grok`이다. 전용 `hooks/laymux.json`의 소유 handler와 `laymux-hooks` helper만 관리하며 기존 사용자·Claude·Cursor 호환 훅은 보존한다. Claude helper가 받은 Grok 호환 payload는 관찰로 전송하지 않는다.
- 관리 훅만 허용하는 정책은 Grok TOML과 Grok이 읽는 Linux·macOS의 Claude `managed-settings.json`을 함께 검사한다. 어느 파일의 pin도 사용자 `false`로 해제하지 않으며 비boolean 값도 제한으로 취급한다. 정책 파일은 변경하지 않는다.
- Grok 고유 camelCase payload의 세션·프롬프트·도구·알림 식별자를 기존 공통 훅 모델로 변환한다. 프롬프트 본문·도구 인자·응답 내용은 전송하지 않는다. 실패·중단은 명시적인 이벤트로만 표시하고, 성공은 동일 턴의 확정된 세션 기록으로 보완한다.
- Grok `Stop`은 같은 턴을 계속 진행시킬 수 있어 훅 phase를 종료로 바꾸지 않는다. 훅 모드의 Grok은 제목 확정 여부와 무관하게 1초마다 현재 세션 기록을 확인하고 `grokTurn` 원시값을 저장한다. `turn_completed`의 session ID와 `prompt_id`가 현재 generation·훅 session ID·`promptId`와 모두 같을 때만 표시 계산 함수에서 종료·결과·완료 알림을 도출한다. 실패·중단 훅은 성공 기록으로 덮지 않고, 식별자 없는 늦은 종료·idle 알림은 현재 턴을 끝내지 않는다.
- 훅 표시는 provider·현재 PTY generation·프로세스·정확한 session ID·실행 환경·설치 상태를 재검증한다. `promptId`로 늦은 이전 턴 이벤트를 거부하고 subagent 관찰은 부모 pane을 바꾸지 않는다. 유휴·종료 phase와 검증 lease는 ADR-0355를 적용한다.
- `promptId` 없는 세션 압축 훅은 이전 턴의 완료 결합을 해제한다. 이후 식별자가 있는 턴 이벤트로 다시 결합하며, 이전 턴의 성공을 압축 작업의 완료로 사용하지 않는다.
- `grok.stateDetection`은 `heuristic | hooks`이며 기본값은 heuristic이다. 훅이 유효하면 화면 갱신으로 작업을 추정하지 않는다. 출력량·프레임만으로 Grok의 작업 미확인을 진행 중으로 승격하지 않는다. 원시 출력 활동은 진단에 보존한다.
- Grok Alt+L도 지원하는 실제 텍스트 입력창을 확인하고 제한된 양방향 삭제와 빈 입력창 안정화를 수행한다. 각 삭제·제출은 ADR-0355의 PTY generation·입력 revision·Remote lease·deadline 검사를 공유한다. 미확인 상태·모달·미지원 모드는 실패로 반환한다.

## Alternatives Considered

- Claude 호환 설치를 Grok 훅으로 간주: provider·설치 루트·대화 귀속이 섞이고 Grok 고유 중단 이벤트를 놓친다.
- 제목과 출력량만 유지: 사용자 타이핑·리페인트를 작업으로 오인하며 명시적인 실패·중단을 관찰할 수 없다.
- Stop을 성공으로 간주: 다른 Stop hook이 계속 작업하게 하거나 실행 도중 중단될 수 있어 실제 완료 결과와 다르다.
- 초안 뒤에 slash 명령을 제출: 의도하지 않은 질문으로 실행될 수 있다.

## Consequences

세 provider가 같은 선택 설치·상태 선택·안전한 clear 흐름을 제공한다. Grok 설정 필드와 훅 관리 계약 추가이므로 minor 변경이다. CLI payload·입력창 형식에 의존하는 비용이 생기며, 확인할 수 없는 화면은 clear가 실패한다. helper·설치 보존·턴 및 세대 경합·Desktop/Remote·실제 xterm·dev CLI 검증과 living doc 갱신이 필요하다. Grok이 구조화된 새 대화 API를 제공하거나 현재 payload·세션 기록 계약을 바꾸면 재검토한다.

WSL Grok 1.0.70은 `/clear` 후 같은 PID에 이전 대화와 새 대화를 모두 등록한다. 이 경우 ADR-0156의 유일한 PID/session 귀속을 충족하지 못하므로 훅 상태·완료 기록을 선택하지 않고 기존 감지로 복귀한다. 가장 최근 ID나 수신 pane ID로 임의 선택하지 않는다. 현재 foreground 대화를 검증하는 별도 계약은 후속 설계 대상이다. 또한 모델 응답 시작 전 취소가 종료 훅·`turn_completed` 없이 초안만 복구하는 CLI 경로에서는 중단 결과를 만들지 않는다. 실제 실행 후 `StopCancelled` 또는 같은 턴의 `cancelled` 기록이 도착한 경우만 중단을 확정한다. 이 두 제한은 #1252에서 계속 추적한다.
