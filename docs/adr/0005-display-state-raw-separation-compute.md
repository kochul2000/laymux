# 0005. 표시 상태 — 원시 상태 분리 → 단일 계산 함수

- Status: Accepted
- Date: 2026-06-03
- Source: 구 ARCHITECTURE.md §9 · §15.6, CLAUDE.md 규칙

## Context

WorkspaceSelectorView 의 한 표시(아이콘·색상·메시지·알림)에는 여러 시스템이 관여한다 — OSC 133 C/D 셸 라이프사이클, OSC 0/2 타이틀 스피너, DEC 2026 동기화 렌더 burst, `lx notify`. 각 시스템이 하나의 공유 표시 필드를 직접 덮어쓰면, 시스템 간 경합으로 표시가 깜빡이거나 잘못된 상태로 고착된다.

## Decision

**각 시스템은 자기 원시 상태만 독립 저장하고, 최종 표시는 단일 계산 함수에서 도출**한다.

- 원시 상태(`commandText`, `exitCode`, `outputActive`, `title` 등)는 activity 와 무관하게 독립 저장. 공유 필드를 앱별로 덮어쓰지 않는다.
- `computeCommandStatus(rawState, activity)` 가 status/statusMessage/notification 세 가지를 도출한다.
- 앱 전용 분기는 `ActivityHandler`(예: `ShellActivityHandler`, `ClaudeActivityHandler`)로 격리하고 계산 함수에서 import.
- `outputActive` 는 프론트엔드 단일 소스(Zustand). 백엔드 응답에 포함하지 않으며, DEC 2026 은 burst(windowMs·threshold) 로만 활성 판정(포커스 리드로/키 에코 false positive 방지).

## Consequences

- 표시 규칙이 바뀌면 계산 함수만 수정한다. activity 타입이 늘면 핸들러만 추가한다.
- 핸들러를 import 하지 않으면 그 앱 전용 로직은 완전히 제거된다(설정 플래그로 default 폴백 가능).
- 현재 계산 규칙·감지 경로는 [architecture/data-flow.md](../architecture/data-flow.md) §9 가 SoT.
