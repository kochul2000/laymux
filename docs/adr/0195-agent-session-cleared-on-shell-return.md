# ADR-0195: agent 를 종료한 pane 은 shell 로 복원한다

- **Status**: Accepted
- **Date**: 2026-08-23
- **Source**: 사용자 버그 보고("shell 로 이미 종료했는데도 agent 로 세션복원이 일어난다"), [`docs/architecture/data-flow.md` §13.4·§13.5](../architecture/data-flow.md), 선행 ADR: [ADR-0120](0120-wsl-agent-session-attribution.md)(WSL agent 귀속), [ADR-0156](0156-grok-first-class-agent.md)(Grok 1급 agent)
- **관계**: ADR-0120 의 fail-closed 귀속 정책을 "agent 가 사라진 pane" 쪽으로 확장한다. ADR-0120 을 번복하지 않는다.

## Context

앱 종료 시 `collectSettingsSnapshot()` 이 pane 별 `lastClaudeSession`/`lastCodexSession`/`lastGrokSession` 을
`settings.json` 에 저장하고, 다음 기동에서 `TerminalView` 가 그 값으로 `claude --resume <id>` 등을 실행한다(§13.4·§13.5).

저장 규칙은 백엔드 귀속 맵(`get_claude_session_ids` 등)의 **키 존재 여부**로 갈렸다.

- 키가 있고 값이 `Some` → 그 id 를 저장하고 다른 provider 필드는 삭제
- 키가 있고 값이 `null`(증명 실패) 또는 두 provider 이상이 주장 → 세 필드 전부 삭제
- **키가 없음 → 어떤 분기도 걸리지 않아 이전 실행에서 저장된 값이 그대로 유지**

백엔드 맵의 키는 `known_claude_terminals` 등 detector 집합에서만 나오고, agent 가 정상 종료하면
`clear_known_interactive_app_state`(`src-tauri/src/activity.rs`)가 그 pane 을 집합에서 제거한다.
즉 **agent 를 깨끗이 종료해 shell 로 돌아온 pane 은 세 맵 모두에서 사라져 stale id 를 영구 보존**했고,
다음 기동에서 사용자가 이미 종료한 agent 가 resume 으로 되살아났다. 그 세션을 또 종료해도 같은 일이
반복되어, 한 번 agent 를 띄운 pane 은 사실상 shell 로 되돌아오지 못했다.

역설적으로 agent 가 **살아 있는데 PID 증명에 실패**한 경우(키 존재, `null`)는 이미 fail-closed 로 잘 지워졌다.
빠져 있던 것은 "살아 있는 pane 인데 어떤 provider 도 주장하지 않는다"는 상태의 해석이다.

범위는 저장 시점의 귀속 판정 한 곳(`ui/src/lib/settings-snapshot.ts`)이다. 비목표: detector 자체의 정확도 개선,
백엔드 귀속 프로토콜 변경, resume 실행 경로 변경.

## Decision

**"이번 실행에서 살아 있는 터미널인데 어떤 agent provider 도 주장하지 않으면, 그 pane 의 agent 세션 필드는 stale 로 보고 전부 삭제한다."**

- 판정 소유자는 `applyTerminalSessionFields` 하나다. 입력은 `TerminalRuntimeAttribution`(백엔드 cwd·3개 귀속 맵 +
  live 터미널 집합)으로 묶고, 세 provider 맵을 각각 부풀리지 않는다 — provider 맵에 "살아 있음"을 섞으면
  증명된 id 마저 conflict/unproven 규칙에 걸려 지워진다.
- live 집합의 SoT 는 프론트엔드 `terminal-store` 의 인스턴스다(id 는 `terminal-<paneId>`, `getInstanceId` 와 동일 규칙).
  `sessionReady === false` 인 인스턴스는 아직 PTY 가 없으므로 제외한다.
- **activity 가 `interactiveApp`/`Claude`·`Codex`·`Grok` 인 pane 은 live 집합에서 제외**한다. 귀속 맵에 키가 없는데
  activity 는 agent 라고 말하는 상태는 detector 경쟁(agent 가 방금 시작)이므로, 쓸 수 있는 resume id 를 버리지 않는다.
- **살아 있는 터미널이 없는 pane(다른 워크스페이스, 이번 실행에서 미기동)은 기존 값을 보존**한다. 증명 기회를 받지
  못한 pane 을 지우는 것은 정보 손실이다.
- `includeRuntimeStructuralState: false`(설정 비교 경로)에서는 live 집합을 비운다. 이 경로는 런타임 상태를 읽지 않는다는
  기존 계약을 유지한다.
- 저장 시점 규칙만 바꾼다. 종료 시퀀스 순서(스냅샷 → Ctrl+C)는 그대로다 — Ctrl+C 는 스냅샷 이후이므로 귀속에 영향이 없다.

## Alternatives Considered

- **백엔드에서 live PTY 를 가진 모든 터미널을 각 provider 맵에 `None` 으로 채운다.** 프론트엔드 변경이 거의 없지만,
  세 맵이 같은 터미널을 동시에 `None` 으로 들고 있게 되어 `activeCount > 1`/`unproven` 규칙이 오작동한다.
  증명된 id 도 지워지므로 기각.
- **새 백엔드 커맨드(`get_agent_session_attributions`)로 pane 당 단일 tri-state 를 반환한다.** 설계상 가장 깔끔하지만
  IPC 계약 추가 + 3개 커맨드 마이그레이션이 필요하다. 지금 필요한 정보(살아 있는 터미널 목록)는 프론트엔드가 이미
  권위 있게 갖고 있어 비용 대비 이득이 없다. 추후 귀속 로직을 백엔드로 모을 때 재검토.
- **agent 종료를 감지한 순간 `setPaneView` 로 세션 필드를 즉시 지운다.** 저장 규칙이 두 곳(런타임 이벤트 + 종료 스냅샷)으로
  갈라지고, detector 의 오탐 한 번이 곧바로 resume id 를 파괴한다. 판정 시점을 저장 한 곳으로 유지하는 편이 안전해 기각.
- **`getTerminalCwds()` 의 키를 live 판정에 재사용한다.** cwd 를 아직 보고하지 않은 세션이 빠지고, cwd 맵의 의미를
  "살아 있음"으로 이중 사용하게 되어 기각.

## Consequences

- agent 를 종료하고 앱을 닫으면 다음 기동은 shell 로 시작한다. pane 은 이제 agent → shell 로 되돌아올 수 있다.
- 대가: agent 를 띄운 직후(detector 가 activity 를 채우기 전) 앱을 닫으면 그 pane 의 resume id 를 한 번 잃고 shell 로
  시작한다. activity 예외 규칙이 이 창을 대부분 덮지만 완전히 없애지는 못한다. detector 가 activity 를 채우기 전에
  종료하는 경로가 실제로 문제가 되면 백엔드 tri-state 대안을 다시 꺼낸다.
- 대가: 프론트엔드 `terminal-store` 가 세션 영속 판정의 입력이 되었다. 인스턴스 등록/해제 규칙을 바꾸는 변경은
  이 판정에 영향을 준다는 점을 함께 검토해야 한다.
- 검증: `ui/src/lib/persist-session.test.ts` 에 (1) live shell pane → 삭제, (2) live 터미널 없는 pane → 보존,
  (3) activity 가 agent → 보존, (4) `sessionReady: false` → 보존, (5) dock live shell pane → 삭제 케이스를 추가했다.
- 문서: `docs/architecture/data-flow.md` §13.4 의 종료 시퀀스에 이 규칙을 반영했다.
- 재검토 조건: 귀속 로직을 백엔드 단일 커맨드로 통합할 때, 또는 detector 가 agent 종료를 놓치는 사례가 늘어
  "키 없음"이 더 이상 "agent 없음"을 뜻하지 못할 때.
