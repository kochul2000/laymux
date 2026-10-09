# 0306. 분리된 PTY 데몬 세션을 보고 끝내는 사용자 경로

- Status: Proposed
- Date: 2026-10-09
- Source: [ADR-0301](0301-pty-daemon-default-adoption.md) Consequences "남은 세션", [PTY 데몬 후속 계획](../pty-daemon/followup-plan.md) §3.4 단계 D

## Context

GUI가 crash하면 그 GUI의 터미널 세션은 PTY 데몬에 남는다. 다음 GUI는 레이아웃에 있는 pane에 그 세션을 재결합한다(ADR-0301). 그러나 pane 배치가 저장되기 전에 crash했거나 사용자가 그 pane을 다시 열지 않으면, 세션은 **어느 pane에도 속하지 않은 채** 자식이 스스로 끝날 때까지 실행된다. 이를 보여 주거나 끝낼 경로가 없었다. 그런 세션이 남아 있으면 데몬은 idle 종료도 하지 않는다.

레퍼런스는 다음과 같다.

- Orca: Settings › Manage Sessions(목록·Kill all·Restart daemon)를 둔다. 탭에 없는 PTY를 다시 붙이는 `terminal.adoptOrphans`도 있다.
- Superset v2: 5분 주기 reaper가 DB에 없는 세션을 2-pass로 확인한 뒤 끝낸다. 설정 화면에서 세션 수를 보여 주고 Update/Restart를 제공한다.
- tmux: `ls`, `kill-session`.
- zellij: `ls`, `kill-session`, `delete-session`.

Orca 사고에서 얻은 규칙이 둘 있다. 목록 조회 실패를 "세션 없음"으로 바꾸지 않는다. close·kill에는 의도와 출처를 싣는다.

범위와 비목표:

- 범위: 목록과 종료.
- 비목표: 분리된 세션을 새 pane에 붙이는 adopt. pane 생성 경로가 세션을 지정받아야 하므로 별도로 다룬다(후속 이슈).
- 비목표: 자동 정리.

## Decision

**GUI는 PTY 데몬 세션 목록을 사용자에게 보여 준다. 어느 pane도 잡고 있지 않고 저장된 레이아웃도 다시 붙이지 않을 세션만 사용자가 끝낼 수 있다. 종료 요청에는 목록에서 본 attach epoch를 싣는다.**

- **분류.** 세션은 다음 다섯 가지 중 하나로 보여 준다. "이 GUI가 아는 터미널"은 지금 살아 있는 pane과, **저장된 레이아웃(로컬 상태 DB의 세션 스냅샷)이 복원할 모든 TerminalView**를 합한 것이다. 레이아웃에는 아직 열지 않은 워크스페이스의 pane, 스택의 모든 layer, dock pane이 포함된다.
  - `pane`: attach됐고 이 GUI의 터미널이 잡고 있음
  - `awaitingPane`: attach된 client는 없지만 이 GUI가 아는 터미널. 워크스페이스는 처음 열 때 마운트되므로(lazy mount), crash 뒤 열지 않은 워크스페이스의 세션은 그 pane이 마운트될 때 재결합된다.
  - `detached`: attach된 client가 없고 이 GUI가 아는 어느 터미널도 아님
  - `otherClient`: 이 GUI가 아닌 client가 attach함
  - `ending`: 자식이 종료됐거나 종료 요청을 받음
- **종료 범위.** 이 경로로는 `detached`만 끝낼 수 있다. backend가 종료 직전에 다시 분류해서 이를 강제한다. 다른 상태면 `notDetached`로 답하고 아무것도 하지 않는다. REST로 현재 epoch를 알아도 pane 세션이나 `awaitingPane` 세션은 끝낼 수 없다. pane이 잡은 세션은 그 pane을 닫아 끝낸다(ADR-0300의 수명 규칙).
- **epoch.** 종료 요청은 목록에서 본 attach epoch를 싣는다(ADR-0301의 by-id 종료 규칙). 목록을 본 뒤 그 세션이 다시 attach됐으면 데몬은 `superseded`로 답하고 세션을 남긴다. 결과는 `terminated | superseded | notDetached | gone`으로 보고한다.
- **실패 처리.** 목록 조회 실패, lock은 쥐었지만 응답하지 않는 데몬, 읽을 수 없는 저장 레이아웃은 모두 오류로 보여 준다. 빈 목록으로 바꾸지 않는다. 데몬이 실행 중이 아닐 때만 빈 목록이다. 목록·종료는 데몬을 띄우지 않는 읽기 경로라서 `LAYMUX_PTY_DAEMON=0`인 GUI에서도 남은 세션을 보여 준다. 일괄 종료는 세션별 실패를 모아 `{ended, failed}`로 보고한다.
- **자동 정리는 하지 않는다.** 정리는 사용자가 실행한다. 레이아웃에 없다는 사실만으로 세션을 끝내지 않는다.
- **경로.** 설정 › 터미널 › PTY 세션 패널을 둔다. 행에는 터미널, 프로필, PID, 상태를 표시한다. 종료 버튼은 두 번 눌러야 실행된다(`TwoClickConfirmButton`). 같은 동작을 Tauri 명령(`list_pty_sessions`, `terminate_pty_session`, `terminate_detached_pty_sessions`)과 Automation REST(`GET /api/v1/pty-sessions`, `POST /api/v1/pty-sessions/terminate`, `POST /api/v1/pty-sessions/terminate-detached`)로도 제공해 자율 검증 루프에서 확인할 수 있게 한다.

## Alternatives Considered

- **레이아웃에 없는 세션 자동 정리(Superset reaper):** 사용자가 crash 뒤에도 살리고 싶던 작업을 의도와 상관없이 끝낸다. 레이아웃 저장이 늦거나 실패한 경우를 "세션이 필요 없다"는 증거로 쓸 수 없다(Orca 사고).
- **데몬 재시작 버튼(Orca Restart daemon):** pane이 쓰는 세션까지 모두 끝낸다. 지금 필요한 것은 남은 세션 정리이며, 업데이트 시 데몬 교체는 단계 E에서 정한다.
- **pane 세션도 이 패널에서 종료:** pane과 PTY의 수명이 어긋난다. pane을 닫는 기존 경로가 정본이다.

## Consequences

- crash로 남은 작업을 사용자가 확인하고 끝낼 수 있다. 남은 세션이 모두 끝나면 데몬은 다시 idle 종료할 수 있다.
- 패널은 3초마다 목록을 다시 읽는다. 목록 조회는 짧은 로컬 IPC 한 번이다.
- 남은 세션을 새 pane으로 가져오는 adopt는 아직 없다.
- 검증:
  - 분류 단위 테스트.
  - 실제 데몬 테스트: 목록 epoch로는 끝나고, 다른 epoch로는 `superseded`, 이미 끝난 세션은 `gone`.
  - UI 테스트: pane 세션에는 종료 버튼이 없다. 목록 epoch로 요청한다. 데몬 무응답은 오류로 표시한다. 일괄 종료.
  - REST 경로 문서 완전성 테스트.
  - dev 실기: crash로 남긴 세션을 REST로 확인하고 끝내기.
