# 0007. Pane 식별자 3종 분리 (terminalId / paneIndex / paneNumber)

- Status: Accepted
- Date: 2026-06-03
- Source: 구 ARCHITECTURE.md §13.7, issue #256

## Context

Pane 을 가리키는 식별자는 용도가 셋으로 다르다 — (1) write/focus 의 안정 참조, (2) 레이아웃 조작 API 파라미터, (3) 사람/AI 가 "N번 pane" 으로 지칭하는 표시. 이를 하나의 식별자로 합치면, 레이아웃이 바뀔 때 stale 참조가 생기거나 사용자의 공간 직관과 배열 인덱스가 어긋난다.

## Decision

**세 식별자를 분리하고 각자 용도를 고정**한다.

| 식별자 | 형식 | 용도 | 안정성 |
|---|---|---|---|
| `terminalId` | `terminal-pane-{uuid8}` | 안정 참조 (write/focus 1차 키, `LX_TERMINAL_ID`) | 세션 간 안정 |
| `paneIndex` | 0-based 배열 인덱스 | 레이아웃 조작(`split_pane`/`remove_pane`/…) | split 순서 종속 |
| `paneNumber` | 읽기 순서 1..N | 표시 + 사람/AI 지칭 | 레이아웃 따라 변동 |

`paneNumber` 는 `computePaneNumbers()`(y 우선, 동일 y 는 x 오름차순) **단일 함수**의 파생값이며 어디에도 저장·캐시하지 않는다.

## Consequences

- 지속 참조는 항상 `terminalId`. 번호 주소 지정(`pane_number`/`pane_ref`)은 `terminals.resolveByNumber` 로 호출 시점에 해석하며 `terminal_id` 가 주어지면 우선.
- 배지 클릭 복사 포맷은 `lx:pane:<workspaceName>:<paneNumber>`; locator 파싱은 마지막 `:` 기준으로 분리(이름에 `:` 가 있어도 안전).
- workspace name invariant: 생성/rename 시 공백류는 `-` 로 치환(마이그레이션 없음).
- 현재 노출 지점은 [architecture/data-flow.md](../architecture/data-flow.md) §13.7 이 SoT.
