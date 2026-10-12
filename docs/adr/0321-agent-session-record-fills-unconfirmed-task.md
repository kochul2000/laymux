# 0321. title이 확정하지 않은 Claude·Grok 작업 상태는 에이전트의 세션 기록으로 채운다

- Status: Accepted
- Date: 2026-10-12
- Source: 사용자 요청("최소한 해당 pane, workspace에 진입했을 때는 갱신되어야 하는 거 아냐?", "클로드, 코덱스, 그록 3개 다 봐라."), [ADR-0319](0319-update-handoff-carries-terminal-title.md), [ADR-0248](0248-codex-turn-lifecycle-activity.md), [ADR-0250](0250-terminal-task-state-and-notification-transitions.md)
- 보완: ADR-0319가 다루지 못한 재부착(이전 버전에서의 업데이트, 크래시 뒤 재부착), ADR-0156의 Grok 작업 상태

## Context

Claude와 Grok의 휴리스틱 작업 상태는 title로만 관찰한다(ADR-0250).

- 대기 중인 Claude는 `✳` title을 다시 내지 않는다. 재부착한 GUI가 그 title을 못 받으면 다음 턴까지 상태가 "모름"이다. ADR-0319는 이 버전 이후의 업데이트만 고친다.
- 실험해 보니 focus 보고(`CSI I`/`CSI O`), resize, laymux focus 중 어느 것도 Claude·Codex가 title을 다시 내게 하지 못했다. pane에 들어갈 때 에이전트에게 상태를 다시 물을 방법이 없다.
- Grok title은 작업 중(스피너)만 알린다. 턴이 끝나면 title이 스피너 없는 이름으로 바뀔 뿐 대기라는 표시가 없으므로 상태가 stale로 남는다. 그래서 휴리스틱 모드에서 대기 중인 Grok은 clear되지 않고 완료 알림도 없다.
- 훅 관찰은 60초 뒤 만료되므로 오래 대기한 pane도 휴리스틱에 기댄다.

Codex는 rollout의 턴 기록을 프로세스 귀속으로 읽으므로(ADR-0248) 재부착과 무관하게 상태가 돌아온다. Claude와 Grok도 각자 파일에 상태를 남긴다.

- **Claude**(2.1.183 이상에서 확인): `~/.claude/sessions/<pid>.json`의 `status`. laymux가 이미 세션 귀속에 읽는 파일이다. 값은 `busy`(응답·위임 작업 중), `idle`, `waiting`(권한 요청·질문·대화상자, `waitingFor`가 같이 기록됨)이다. 대화 기록 저장 설정과 무관하게 쓴다.
- **Grok**(1.0.50에서 확인): 세션 디렉터리의 `updates.jsonl`. 사용자 메시지는 `sessionUpdate: user_message_chunk`, 턴 끝은 `turn_completed`와 `stop_reason`(`end_turn`, Ctrl+C 중단은 `cancelled`)으로 남는다. 훅 설치와 무관하다. `/clear`는 새 세션 ID와 새 디렉터리로 바뀌고, laymux의 귀속(`active_sessions.json`)도 새 세션을 가리킨다.

## Decision

**title이 상태를 확정하지 않은 Claude·Grok pane은 에이전트가 자기 세션 파일에 남긴 상태로 작업 상태를 채운다. 그 상태는 title이나 입력이 다시 관찰할 때까지 세션 기록이 맡는다.**

- **백엔드 `get_agent_session_states(claudeTerminalIds, grokTerminalIds)`.**
  - 기존 세션 귀속(PTY 자식 pid → 세션 파일)을 그대로 쓴다. 귀속 실패·중복 귀속·조회 실패 터미널은 결과에서 뺀다. CWD나 최근 파일로 추측하지 않는다.
  - Claude는 귀속된 세션 파일의 `status`를 `running`/`idle`/`waiting`으로 돌려준다. `status`가 없거나 모르는 값이면 뺀다.
  - Grok은 `updates.jsonl` 끝 1 MiB에서 마지막 턴 경계를 찾는다. 사용자 메시지가 마지막이면 `running`, `turn_completed`가 마지막이면 `ended`(`end_turn`은 success, `cancelled`는 interrupted, 그 밖은 결과 없음)이다. 파일 전체에 경계가 없으면 `idle`이다. 잘린 끝에 경계가 없거나 읽을 수 없는 줄이 경계보다 뒤에 있으면 뺀다. 쓰는 중인 마지막 줄(개행 없음)은 읽지 않는다.
  - 조회 전후 PTY generation을 비교해 그사이 바뀐 터미널은 뺀다.
- **프론트 `subscribeAgentSessionStates`.**
  - 대상은 휴리스틱 작업이 확정되지 않은 Claude·Grok pane이다. 확정되지 않음은 관찰 없음, unknown, stale, 만료(`expiresAfter`)를 뜻한다. 세션 기록이 마지막으로 쓴 작업(같은 sequence)도 대상이다.
  - 대상이 있을 때만 1초마다 한 번에 조회하고, 한 번에 한 요청만 보낸다.
  - 응답은 요청 시점과 generation, task epoch, 마지막 입력 시각, 앱, 휴리스틱 작업의 source·sequence가 모두 같을 때만 반영한다. 그사이 title·입력이 관찰했으면 그 관찰이 이긴다.
  - `running`은 running이다. 직전 작업이 running이 아니면 새 작업으로 시작한다(`observeTaskTitle`과 같다). `ended`는 기록의 결과로 끝낸다. `idle`은 직전 작업이 running·ended면 ended, 아니면 idle이다(Claude `✳`과 같다).
  - `waiting`은 쓰지 않는다. 대기는 그 대화상자의 검출기가 소유하고(ADR-0250), 세션 기록이 쓴 대기는 나중에 해소할 관찰이 없다. 상태는 확정되지 않은 채 남으므로 clear는 계속 보호된다.
  - 같은 상태·결과를 다시 읽으면 관찰을 새로 쓰지 않는다.
  - 공통 전이 규칙(ADR-0250)을 그대로 쓴다. 이전 관찰이 없던 첫 반영은 알림을 만들지 않는다. stale running이 기록의 ended로 바뀌는 것은 실제 턴 끝이므로 완료 알림을 만든다.
- 훅 모드에서도 이 관찰은 휴리스틱 경로에 들어간다. 훅 관찰이 유효하면 표시는 훅이 정하고, 만료되면 이 관찰이 쓰인다.
- Codex는 바꾸지 않는다.

## Alternatives Considered

- **pane·workspace 진입 시 에이전트에 title 재전송 유도:** focus 보고, resize, focus API 모두 실측에서 title을 다시 받지 못했다.
- **Claude 대화 기록(`projects/<cwd>/<session>.jsonl`)의 `turn_duration`:** 턴 끝은 알 수 있지만 대화 기록 저장을 끈 환경에서 없고, 도구 실행 중과 권한 대기를 구분하지 못한다. `sessions/<pid>.json`의 `status`가 더 직접적이고 이미 읽는 파일이다.
- **Grok 훅 이벤트(`hook_execution`의 `stop`):** 사용자 훅이 있을 때만 기록되고, 세션 종료 때도 나온다. `turn_completed`는 훅과 무관하다.
- **세션 기록을 Claude·Grok의 주 신호로:** title은 즉시 오는 push이고 기록은 1초 polling이다. title이 확정한 상태는 title이 더 새롭다. 확정되지 않은 동안만 기록을 쓰면 기존 title 동작과 알림 시점을 바꾸지 않는다.
- **진입할 때만 조회:** Remote clear처럼 진입 없이 상태를 묻는 경로가 있고, Grok 턴 끝은 진입과 무관하다. 확정되지 않은 동안 조회하는 편이 진입 시점도 덮는다.

## Consequences

- 업데이트(이전 버전 포함)·크래시 뒤 재부착한 대기 Claude·Grok pane은 첫 조회에서 대기로 확정되고 clear가 된다. 훅이 만료된 pane도 같다.
- 휴리스틱 모드의 Grok도 턴 끝을 ended로 확정하고 완료 알림을 낸다. 중단은 interrupted다.
- title을 끈 Claude도 세션 기록이 상태를 맡는다. 다만 1초 조회 지연이 있다.
- 세션 기록이 맡은 pane(대기 중인 Grok, 재부착 뒤 title이 다시 오기 전인 Claude 등)은 계속 1초마다 조회한다. 조회는 프로세스 snapshot과 WSL probe를 포함한다. Codex 조회와 같은 비용이다.
- 두 파일 형식은 공개 계약이 아니다. 형식이 바뀌면 결과에서 빠져 이 결정 전과 같이 "모름"으로 남는다. 버전이 바뀌면 다시 실측한다.
- Claude 2.1.183 미만은 `status`가 없어 이 결정의 효과가 없다.
- 검증
  - Rust 단위 테스트: Claude `status` 파싱, Grok 턴 경계(사용자 메시지·`turn_completed`·중단·쓰는 중인 줄·읽을 수 없는 줄·잘린 끝·1 MiB 상한).
  - 프론트 단위 테스트: 모름→기록의 대기 확정과 clear 허용, title 확정 시 미조회, Grok stale→기록의 완료와 알림, 기록 소유와 title 인계, Claude 기록 대기의 직전 작업 종료, 기록의 waiting 미사용, 읽는 중 입력·다른 generation 폐기, Codex·셸 제외.
  - dev 실기
    - WSL Grok: 새로 띄운 pane이 기록으로 idle 확정, 턴 끝에 ended·success 확정과 완료 알림, pane이 다시 떠 `--resume`된 뒤 기록으로 ended 확정, clear 성공.
    - Windows Claude(title 끔): title 없이 기록으로 idle 확정, 턴 동안 running, 끝에 ended와 완료 알림, clear 성공.
