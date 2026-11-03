# 0373. 완성된 셸 제출 명령과 명시적 clear 경계로 마지막 입력을 표시한다

- Status: Accepted
- Date: 2026-11-03
- Source: 사용자 요구(Tab 완성 문자열 누락·clear 후 이전 입력 잔상); [data-flow.md §9](../architecture/data-flow.md); [ADR-0194](0194-workspace-pane-last-input-second-line.md); [ADR-0262](0262-powershell-command-lifecycle.md); [ADR-0371](0371-durable-workspace-display-history.md)
- 관계: ADR-0262의 PowerShell 명령 본문 미관측 범위와 ADR-0194·0371의 입력 표시/보존 범위를 확장한다.

## Context

Direct 입력은 사람이 보낸 키만 조립한다. Tab 자동완성과 이력 탐색은 셸이 편집 버퍼를 바꾸므로 키만으로 실제 제출 문자열을 복원할 수 없다. Bash 통합은 명령 본문 E를 이미 보내지만 PowerShell 통합은 작업 경계 C/D만 보낸다. 입력 쓰기 완료와 OSC 수신 순서가 바뀌면 정확한 명령 뒤에 늦은 키 조립 결과가 기록될 수도 있다.

명시적으로 화면/대화를 지워도 마지막 입력은 남는다. 필드를 단순히 비우면 데몬·디스크의 이전 이력이나 늦은 입력 완료가 그 문자열을 되살릴 수 있다. 활동 감지로 clear를 허용할지 판단하는 문제와, 이미 전달한 clear에 맞춰 표시 문맥을 지우는 문제는 다르다. 셸과 에이전트 모두 대상이다. 에이전트의 Tab 완성은 이미 귀속된 공식 세션 기록의 실제 사용자 제출 본문으로 보정한다. 임의 TUI 화면의 역파싱과 모든 앱의 대화 초기화 확인은 범위 밖이다.

## Decision

**셸이 관측한 제출 명령을 키 조립보다 우선하고, 명시적 clear 입력을 성공적으로 전달하면 활동 종류와 독립적으로 입력 표시의 삭제 경계를 보존한다.**

- PowerShell은 기존 PSReadLine reader가 반환한 실행 문자열을 C 다음의 OSC 133 E로 보낸다. 자동완성·이력·여러 줄 편집 결과를 포함하고 실행 원문은 바꾸지 않는다. 표시 사본은 C0/C1 제어문자를 공백으로 바꾸고 최대 16,384 UTF-16 단위로 제한해 OSC 종료/삽입을 방지한다. PSReadLine 부재·제한 언어 모드 정책은 유지한다.
- Rust OSC 파서/훅이 기존 `command-status.command` 경로로 본문을 전달한다. 프론트에서 OSC를 새로 파싱하지 않는다. 본문 없는 시작/종료는 기존 입력의 시각을 새 제출 시각으로 바꾸지 않는다. 키 쓰기가 대기하는 동안 셸 명령 본문이 바뀌면 키 조립 결과가 표시를 덮지 않는다.
- Claude·Codex·Grok의 기존 세션/턴 조회 응답에 선택적 `submittedInput: {text,timestamp}`를 추가한다. 본문은 표시 보정 전용이며 작업/권한 증거로 쓰지 않는다. Claude는 실제 사용자 문자열/텍스트 블록만 선택하고 tool_result·메타·sidechain·요약을 제외한다. Codex는 user_message와 item_completed/UserMessage의 text content를 사용한다. Grok은 같은 promptIndex의 user_message_chunk 텍스트를 합친다. 세션 불일치·손상·불완전한 그룹은 보정하지 않는다.
- Claude/Grok은 사용자 제출 뒤 15초 동안만 기존 상태 조회에 `inputTerminalIds`를 보내 이미 귀속된 파일의 마지막 1 MiB를 읽는다. Codex는 기존 증분 reader에서 본문을 최대 2048 code point로 보유한다. 새 OS/WSL 실행은 추가하지 않는다. 입력 본문을 로그에 남기지 않는다. 프론트는 기존 로컬 제출보다 이전이거나 미래 5초 초과의 기록, clear 이전 기록을 거절하고 문자열만 보정한다. 원래 제출 시각·작업 상태는 유지한다. 응답 적용에는 세대·작업·입력·삭제 경계를 검증한다.
- 선택적 `lastInputClearedAt` 이하의 사용자 입력·셸 명령은 표시하지 않는다. 경계는 기존 데몬 문맥과 로컬 SQLite 표시 checkpoint에 포함한다. 데몬/디스크 병합은 큰 삭제 경계를 유지하고 이후 제출은 경계보다 큰 시각을 갖는다. 새 설정이나 마이그레이션은 추가하지 않는다.
- 사람의 Ctrl+L 및 정확히 `clear`·`cls`·`Clear-Host`·`/clear`인 제출, workspace clear의 성공한 Ctrl+L 쓰기, pane clear의 성공한 제출/재시작은 공통 입력 표시 초기화를 사용한다. 실패·skip에는 적용하지 않는다. clear 자체의 활동별 입력·busy·권한 정책은 유지한다.
- 성공한 Enter의 런타임 제출 경계 `lastInputSubmissionAt`은 키 조립 문자열이 비어 있어도 기록한다. 이력 탐색/앱 완성으로 채운 입력도 해당 경계 이후의 실제 사용자 본문으로 보정한다. 빈 Enter는 그 자체로 표시 문자열·제출 시각·작업을 새로 만들지 않는다. 본문 확인 후에만 보정 문자열과 그 제출 경계 시각을 표시한다. 이 경계는 영속하지 않는다.
- Ctrl+L/workspace clear는 앱 초안을 보존하므로 Direct 조립 초안도 보존한다. 실제 pane clear 및 clear 명령의 초안 폐기만 런타임 `inputDraftResetRevision`으로 조립기를 초기화한다. 표시 삭제 경계와 초안 폐기 신호는 독립이다.
- 지연 clear 완료는 그사이의 사용자 제출·셸 명령을 모두 보호한다. pane clear가 직접 제출한 설정 명령 본문만 자기 clear의 관측으로 허용한다.
- 입력 쓰기는 시작 당시 PTY generation과 삭제 경계를 보유한다. clear 이전 또는 교체된 PTY의 늦은 완료는 기록하지 않는다. 비동기 clear 동안 새 사용자 제출이 관측됐다면 그 입력을 지우지 않는다. 작업 상태·결과·활동은 삭제 대상이 아니다.
- PTY 출력의 화면 지우기·TUI redraw는 삭제 신호가 아니다. 전달 성공은 기존 clear API와 같은 입력 전달 성공이며 앱의 대화 초기화 완료를 별도 확인하는 것은 아니다.

## Alternatives Considered

- **키 조립만 유지**: 셸이 편집 버퍼에 채운 문자를 알 수 없다.
- **제출 직전 화면에서 모든 앱의 입력 복원**: prompt·wrap·완성 메뉴·placeholder가 섞이며 빠른 Tab→Enter에서는 redraw가 아직 없을 수 있다. 보편적인 정확성 계약이 되지 않는다.
- **화면 지우기 escape sequence마다 삭제**: 일반적인 redraw에도 표시 문맥이 사라진다.
- **문자열만 undefined로 변경**: 재시작·재결합·늦은 완료가 문자열을 되살린다.
- **clear 활동별 정책 제거**: 진행 중 작업/확인창에 임의 문자열을 보내는 위험이 있으므로 표시 초기화만 공통화한다.

## Consequences

PowerShell에서 Tab 완성과 이력 탐색을 반영한 명령을 표시하며 Bash E 경로도 같은 우선순위를 사용한다. 기존 셸은 재시작해야 새 통합을 받는다. 기능 추가 없는 표시 오류 수정으로 버전 영향은 patch다.

삭제 시각 하나를 checkpoint에 추가하는 비용이 생긴다. 런타임 시계 역행은 경계+1로 보완하며 다른 머신 사이의 시계 동기화는 다루지 않는다. 지원하는 세 에이전트는 공식 세션 기록을 읽을 수 있을 때 제출 후 보정된다. 그 밖의 TUI, 미귀속 세션, 지연/절단/손상된 기록, 기록되지 않는 slash 명령은 키 조립 결과를 유지한다. 화면의 추측을 정확한 원문으로 주장하지 않는다. 새 앱이나 형식은 어댑터를 추가한다. 기록 시각이 클라이언트보다 뒤처진 환경에서는 보정보다 과거 입력 오염 방지를 우선한다.

셸 ConPTY 통합 테스트·입력 쓰기 경합·clear 성공/실패·복원 병합·에이전트 기록/구독 테스트로 검증한다. 입력 보정만을 위한 조회는 확정된 작업 상태를 오래된 세션 상태로 바꾸지 않는다. `scripts/tests/selector-input-history.e2e.mjs`는 dev(19281)의 실제 xterm에 키를 보내 PowerShell Tab/Clear-Host/workspace clear와 Claude 파일 완성/pane clear를 확인하고 스크린샷을 저장한다. 실행에는 CDP를 켠 dev와 로그인한 native Claude가 필요하며 `--shell-only`로 셸만 검증할 수 있다. 테스트가 만든 workspace와 fixture만 정리한다. 2026-11-03 Windows dev에서 PowerShell·Claude 실기 경로를 확인했으며 Codex·Grok은 기록/구독 회귀 테스트로 검증했다.

Codex 형식 근거: [공식 TurnItem/UserMessageItem](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/items.rs), [공식 UserInput](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/user_input.rs), [rollout 저장 테스트](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder_tests.rs). Claude/Grok은 기존 세션 어댑터와 로컬 기록의 필드 구조를 대조했다.
