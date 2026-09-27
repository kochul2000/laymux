# 0271. Remote 가 요청한 PC 실행 동작은 lease 로 쓴다

- Status: Accepted
- Date: 2026-09-27
- Source: [ADR-0269](0269-remote-physical-keyboard-shortcuts.md) 구현(Remote Alt+L·Ctrl+Alt+L 클리어), [ADR-0158](0158-activity-aware-single-pane-clear.md), [ADR-0137](0137-workspace-clear-ctrl-l-broadcast.md)
- 관계: ADR-0269 의 "클리어는 기존 경로를 중계한다"를 구현하는 쓰기 권한 규칙. ADR-0158·0137 의 클리어 의미는 그대로.

## Context

Remote 가 lease 를 쥐고 있으면 PC WebView 의 Local 쓰기는 거부된다. 사람이 둘이 동시에 치지 못하게 하는 장치다.

PC 의 클리어 실행기(activity 별 입력, busy 정책, interrupt → settle)는 PC WebView 안에 있다. 그래서 Remote 가 클리어를 부탁해도 실행기의 쓰기가 Local 로 나가서 거부된다.

## Decision

**Remote 가 요청한 PC 실행 동작은 요청한 Remote 의 lease 를 싣고 쓴다.**

- Remote route 는 lease 를 검증한 뒤 bridge params 에 `remoteLeaseId` 로 넘긴다.
- PC 실행기는 `remoteLeaseId` 가 있으면 전용 명령(`write_to_terminal_for_remote`, `write_terminal_input_for_remote`)으로 쓴다. 이 명령은 Remote 출처로 쓰므로 lease 검사가 한 번 더 걸린다. lease 가 바뀌었거나 끊겼으면 거부된다.
- `remoteLeaseId` 가 없으면 지금처럼 Local 로 쓴다. Automation(MCP)은 lease 를 우회하지 않는다.
- 실행 로직은 PC 실행기 하나만 가진다. Rust 나 Remote 에 복제하지 않는다.

## Alternatives Considered

- **Rust 가 계획만 받아 직접 쓴다** — interrupt → settle → submit 과 deadline 을 Rust 에 한 벌 더 만들어야 한다. ADR-0158 의 단일 소유자가 깨진다.
- **Remote 가 계획을 받아 자기 write/input 경로로 쓴다** — 실행이 PC 와 Remote 로 쪼개지고 restart 같은 동작은 따로 또 필요하다.
- **Remote 가 lease 를 쥐고 있을 때 Local 쓰기를 예외로 허용** — lease 가 막으려는 동시 입력을 다시 연다.

## Consequences

- Remote Alt+L·Ctrl+Alt+L 이 PC 와 같은 클리어 결과를 낸다.
- PC WebView 는 활성 lease id 를 이미 알고 있다(remote-control 상태). 그래서 이 명령으로 Remote 로서 쓸 수 있다. PC WebView 는 원래 신뢰 범위라 권한 상승은 아니고, 쓰기마다 현재 lease 와 대조되므로 끊기거나 바뀐 lease 로는 쓰지 못한다. 실행기는 Remote 가 요청한 동작에서만 `remoteLeaseId` 를 쓴다.
- 앞으로 Remote 가 PC 실행기를 부르는 새 동작도 같은 규칙을 따른다.
