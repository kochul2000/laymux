# 0340. Claude 턴의 종료 결과는 귀속된 대화 기록의 턴 경계로 판정한다

- Status: Proposed
- Date: 2026-10-17
- Source: 사용자 요구("클로드 코덱스 다르단 점은", 대화 기록 판정안 선택), [ADR-0250](0250-terminal-task-state-and-notification-transitions.md), [ADR-0321](0321-agent-session-record-fills-unconfirmed-task.md), [ADR-0248](0248-codex-turn-lifecycle-activity.md), [ADR-0283](0283-opt-in-hook-task-state.md), [ADR-0118](0118-codex-session-pid-attribution.md), [ADR-0120](0120-wsl-agent-session-attribution.md), [hook 검증](../agent-hooks-validation.md)
- 보완: ADR-0250 Decision "앱별 신호의 인정 범위"의 Claude 행(`✳`만으로 성공·중단을 구분하지 않음)에 결과 관측 경로를 추가한다. ADR-0250:60이 별도 설계를 요구한 "세션에 귀속된 structured lifecycle 관측"을 Claude에 한해 정한다. ADR-0321의 작업 상태 판정과 기각 사유(상태 신호로서의 대화 기록)는 유지한다.

## Context

ADR-0250은 종료를 성공·실패·중단·결과 미관측으로 구별하라고 정했다. 그런데 앱마다 결과를 얻는 경로가 다르다.

| 앱      | 결과 출처                                            | 성공     | 실패             | 중단                              |
| ------- | ---------------------------------------------------- | -------- | ---------------- | --------------------------------- |
| 통합 셸 | OSC 133 D의 종료 코드                                | 관측     | 관측             | 결과 미관측(PowerShell `Stopped`) |
| Codex   | rollout 턴 기록(ADR-0248)                            | 관측     | 관측             | 관측                              |
| Grok    | `updates.jsonl` `turn_completed`(ADR-0321)           | 관측     | —                | 관측                              |
| Claude  | `✳` title, `sessions/<pid>.json` `status`, 선택적 훅 | **없음** | StopFailure 훅만 | **없음**                          |

Claude 턴은 정상 종료든 Esc 중단이든 거의 언제나 "결과 미관측"이 된다. `✳`과 `status: idle`은 입력 가능 상태로 돌아왔다는 관측일 뿐이다. 훅의 Stop은 ADR-0283에 따라 "응답 종료 관찰"이다. 다른 사용자 Stop 훅이 작업을 계속시킬 수 있기 때문이다. Claude에는 Esc 중단 전용 훅도 없다. 그래서 같은 상황에서 Codex는 `✓`이고 Claude는 결과 미관측이 된다. 사용자에게는 앱마다 의미가 다른 표시로 보인다.

Claude Code는 대화를 `<설정 루트>/projects/<프로젝트 디렉터리>/<sessionId>.jsonl`에 줄 단위로 기록한다. 이 파일은 `sessions/<pid>.json`(ADR-0118·0120의 귀속 파일)과 같은 설정 루트에 있다. 2.1.300·2.1.301 Windows 실측에서 턴 끝은 다음과 같이 남는다.

- **정상 종료:** main chain(`isSidechain: false`)에 `type: system, subtype: stop_hook_summary`가 기록되고, 이어서 `type: system, subtype: turn_duration`이 기록된다. `stop_hook_summary`에는 Stop 훅이 계속 진행을 막았는지(`preventedContinuation`)도 남는다. 실측한 246턴 모두 이 두 기록이 짝을 이뤘다.
- **API 오류:** 마지막 assistant 기록이 `isApiErrorMessage: true`(`model: "<synthetic>"`, `error` 필드)인 상태로 `turn_duration`이 이어진다.
- **Esc 중단:** `type: user` 기록의 본문이 `[Request interrupted by user]`(도구 실행 중에는 `… for tool use]`)이고, `interruptedMessageId`가 붙는다. 이 경우 `turn_duration`은 기록되지 않는다.

ADR-0321은 이 파일의 `turn_duration`을 **작업 상태** 신호로 검토했다가 기각했다. 대화 기록 저장을 끈 환경에서는 파일이 없고, 도구 실행과 권한 대기를 구분하지 못한다는 이유였다. 이 결정은 그 기각을 뒤집지 않는다. 상태는 계속 title과 `status`가 정하고, 대화 기록은 이미 끝난 턴의 **결과**만 채운다. 결과에는 그 두 약점이 해당하지 않는다. 파일이 없으면 지금처럼 결과 미관측으로 남고, 결과는 턴이 끝난 뒤에만 묻기 때문이다.

범위 밖:

- 셸 Ctrl+C를 중단으로 관측하는 것. OSC 133 D 확장이 필요하므로 별도 결정으로 다룬다.
- 결과별 아이콘·색상. ADR-0250이 후속 구현에 위임한 표시 결정이다.
- Claude 작업 상태(running·idle·waiting)의 판정 경로 변경.
- Grok·Codex의 결과 경로.

## Decision

**Claude 작업이 결과 없이 종료로 관측되면, 현재 pane에 귀속된 세션의 대화 기록에서 마지막 main chain 턴 경계를 읽어 성공·실패·중단을 채운다. 경계를 확정하지 못하면 결과를 비워 둔다.**

### 대화 기록 찾기

- 기존 Claude 세션 귀속(PTY 자식 pid → `sessions/<pid>.json` → `sessionId`, ADR-0118·0120)을 그대로 쓴다. 귀속 실패·중복 귀속·조회 실패에서는 결과를 내지 않는다.
- 파일은 같은 설정 루트의 `projects/*/<sessionId>.jsonl` 중 이름이 정확히 일치하는 하나다. 일치하는 파일이 없거나 둘 이상이면 결과를 내지 않는다. CWD를 디렉터리 이름으로 바꾸는 Claude 내부 규칙을 재구현하지 않고, 최근 수정 시각이나 CWD로 다른 세션 파일을 추측하지도 않는다. 찾은 경로는 세션 ID 단위로 캐시하되, 파일이 사라지거나 교체되면 다시 찾는다.
- WSL은 ADR-0120의 guest 경로 변환과 같은 HOME을 쓴다.

### 턴 경계와 결과

- 파일 끝에서 앞으로 유계 구간(상한 1 MiB)을 읽고, main chain 기록만 본다. subagent 기록(`isSidechain: true`)과 별도 파일은 무시한다. 쓰는 중인 마지막 줄(개행 없음)은 읽지 않는다. 읽을 수 없는 줄이 경계보다 뒤에 있으면 결과를 내지 않는다.
- 끝에서부터 처음 만나는 다음 기록이 마지막 턴 경계다.
  - **턴 시작:** `isMeta`가 아니고, 도구 결과·중단 표지가 아닌 user 기록. 이 기록이 가장 마지막이면 턴이 아직 진행 중이므로 결과를 내지 않는다.
  - **정상 종료(`turn_duration`):** 그 턴의 마지막 assistant 기록이 `isApiErrorMessage: true`면 `failure`, 아니면 `success`다.
  - **중단:** `interruptedMessageId`가 있는 중단 표지 user 기록이면 `interrupted`다. 본문 문자열만 같고 `interruptedMessageId`가 없으면 사용자가 그 문자를 입력했을 수 있으므로 표지로 보지 않는다.
- 상한 안에서 경계를 찾지 못하면 결과를 내지 않는다.
- `success`는 ADR-0250·0248과 같이 **턴이 오류·중단 없이 정상으로 끝났다**는 뜻이다. 사용자의 목표를 달성했다는 뜻은 아니다.
- 중단 표지는 Esc 중단의 관측이다. ADR-0250이 금지한 "중단 키를 보냈다는 사실만으로 중단을 확정"과는 다르다. 에이전트가 직접 남긴 기록이기 때문이다.

### 턴과 관측 작업의 대응

- 결과는 현재 laymux 작업이 `ended`이고 결과가 비어 있을 때만 채운다. 상태를 바꾸지 않고, 새 작업을 만들지 않고, 종료를 되돌리지 않는다.
- ADR-0321의 응답 검증(요청 시점과 generation·task epoch·마지막 입력 시각·앱·작업 source·sequence의 일치)을 그대로 적용한다. 그사이 새 입력이나 새 작업이 관측되면 응답을 버린다.
- 종료 관측이 기록 flush보다 먼저 올 수 있다. 마지막 경계가 턴 시작이면 아직 이번 턴의 경계가 기록되지 않은 것이므로, 같은 작업이 유지되는 동안 다시 묻는다. 결과를 채우거나, 다음 작업이 시작되거나, 대상이 바뀌면 묻기를 멈춘다. 늦게 확인한 결과는 표시만 갱신하고, 종료 알림을 다시 만들지 않는다(ADR-0250).
- 훅 모드에서도 같다. Stop 훅이 만든 결과 없는 종료에 이 결과를 채운다. StopFailure 훅이 이미 `failure`를 정했으면 덮지 않는다.

### 소유와 비용

- 파일 I/O는 Rust가 소유한다. ADR-0321의 `get_agent_session_states` Claude 항목에 마지막 턴 결과를 붙이는 방식으로 확장한다. 프론트는 결과 원시값만 받아 공통 전이(ADR-0250)에 넣고, 대화 기록 형식을 해석하지 않는다.
- 결과 조회는 결과 없는 종료가 있는 Claude pane에만 한다. 같은 파일을 다시 읽을 때는 크기·수정 시각이 바뀐 경우에만 끝 구간을 다시 읽는다. 대화 내용(프롬프트·응답·도구 입출력)은 결과 판정 외의 목적으로 보관하거나 내보내지 않는다.
- 캐시 mutex는 AppState 락을 잡지 않은 채 취하는 leaf이고, 파일 I/O 중 AppState에 다시 들어가지 않는다(ADR-0248과 같다).

## Alternatives Considered

- **Stop 훅을 성공으로 해석:** ADR-0283대로 Stop은 응답 종료 관찰이다. 다른 사용자 Stop 훅이 계속시킬 수 있다. 훅은 선택 설치이고 60초 뒤 만료되며, Esc 중단 훅도 없다. 훅을 설치한 사용자도 중단은 여전히 알 수 없다.
- **신호 부재로 추론(Stop 뒤 재개가 없으면 성공, Stop 없이 `✳`면 중단):** 훅 전달 지연, 훅 미설치, title 비활성화에서 오판한다. ADR-0250은 무신호·무출력을 종료나 결과의 증거로 쓰지 않는다.
- **`sessions/<pid>.json`에 결과가 생길 때까지 대기:** 2.1.301의 `status`는 `busy|idle|waiting`뿐이고 결과 필드가 없다. Claude가 추가하면 이 결정을 재검토한다.
- **대화 기록을 작업 상태의 주 신호로 승격:** ADR-0321의 기각 사유가 그대로 남는다. 상태는 기존 경로를 유지하고 결과만 채우면 기존 알림 시점과 title 동작을 바꾸지 않는다.
- **CWD로 프로젝트 디렉터리 이름을 계산:** Claude 내부 규칙에 의존하고, 실행 중 `cd`나 worktree 이동에서 어긋난다. 세션 ID 파일명 일치가 귀속과 같은 강도를 가진다.
- **결과 표시를 셸·Codex도 "종료"로 낮춰 통일:** 이미 정확히 관측하는 결과를 버린다. 앱 간 차이는 줄어들지만 사용자가 얻는 정보가 줄어든다.

## Consequences

- Claude·Codex·Grok·통합 셸이 같은 결과 의미를 쓴다. Claude 결과 미관측은 대화 기록 저장을 껐거나, 귀속이나 형식 해석이 실패한 경우로 줄어든다. 셸 Ctrl+C만 별도 결정 전까지 결과 미관측으로 남는다.
- Claude의 정상 종료가 성공으로 알려지므로 완료 알림과 표시가 Codex와 같아진다. 결과는 1초 조회 주기만큼 늦게 채워질 수 있다.
- 대화 기록 형식은 공개 계약이 아니다. 필드(`subtype`, `isSidechain`, `isMeta`, `isApiErrorMessage`, `interruptedMessageId`)가 바뀌면 결과를 내지 않고 이전처럼 결과 미관측으로 남는다. 결과를 잘못 채우지는 않아야 한다. Claude 버전이 바뀌면 다시 실측한다.
- 대화 기록 파일은 수십 MB가 될 수 있다. 유계 끝 구간과 변경 시에만 다시 읽기로 비용을 묶는다. 1 MiB보다 긴 단일 턴의 꼬리(대형 도구 출력)는 경계를 못 찾아 결과 미관측이 될 수 있다.
- laymux가 대화 파일을 읽게 된다. 판정에 필요한 필드만 쓰고 내용은 보관·전송하지 않는다는 점을 living doc에 남긴다.
- 후속 작업
  - 구현 PR: Rust 경계 파서와 `get_agent_session_states` 확장, 프론트 결과 채우기, `docs/architecture/data-flow.md` 작업 상태 절 갱신.
  - 결과별 표시 분리(성공·실패·중단·결과 미관측·작업 없음·미확인), ADR-0250 위임 사항.
  - 셸 Ctrl+C 중단 관측(OSC 133 D 확장).
- 검증
  - Rust 단위 테스트: 정상 종료, API 오류 종료, Esc 중단(일반·도구 실행 중), `interruptedMessageId` 없는 동일 문자열, 진행 중(마지막 경계가 턴 시작), sidechain 무시, `isMeta` 무시, 쓰는 중인 줄, 읽을 수 없는 줄, 1 MiB 상한, 파일 없음·중복 일치.
  - 프론트 단위 테스트: 결과 없는 종료에만 채움, 늦은 결과의 알림 미재발행, 새 입력 뒤 응답 폐기, StopFailure 결과 보존, 대화 기록 없음의 결과 미관측 유지.
  - dev 실기(Windows·WSL Claude): 정상 턴의 성공, Esc 중단의 중단, 도구 실행 중 Esc, 대화 기록 저장을 끈 실행의 결과 미관측, 훅 모드의 Stop 뒤 성공, 사용자 Stop 훅이 계속 진행시킨 턴에서 중간 성공이 생기지 않는지.
- 재검토 조건: Claude가 세션 파일이나 훅으로 턴 결과를 직접 제공하거나, 대화 기록의 턴 경계 형식이 바뀔 때.
