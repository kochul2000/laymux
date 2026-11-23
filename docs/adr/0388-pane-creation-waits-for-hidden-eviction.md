# 0388. 자동화 pane 생성은 숨김 터미널 회수가 끝난 뒤 승인한다

- Status: Accepted
- Date: 2026-11-23
- Source: MCP로 리뷰 pane을 생성할 때의 사용자 보고, [Automation API](../architecture/api-contracts.md#121-아키텍처), [ADR-0231](0231-hidden-eviction-target-scoped-input-admission.md), [ADR-0365](0365-navigation-admission-during-hidden-eviction.md)

## Context

MCP의 `stack_pane`과 `split_pane`은 숨김 터미널의 세션 저장·종료와 겹치면 프런트엔드에 도달하기 전에 거절됐다. 다른 workspace의 터미널 하나만 회수 중이어도 같은 오류가 발생했다. 명시적인 뷰 재시작도 같은 승인 경로를 사용한다. 두 생성 작업은 레이아웃을 변경하므로 회수의 체크포인트와 순서를 지켜야 한다.

## Decision

**MCP와 Automation REST의 pane 분할·스택 추가는 백그라운드 회수가 끝날 때까지 승인 전에 기다린다.** Rust가 회수 해제를 알리면 요청은 기존 세션 변경 승인을 다시 시도한다. 대기 중에는 진행 수에 포함하지 않고, 승인되면 같은 요청 ID로 프런트엔드에 한 번 전달한다. 창 닫기가 확정되거나 전역 finalization이 시작되면 발행 전 요청을 거절한다. 이는 종료 시 Codex 세션 확인 설정과 독립적이다. 종료가 취소된 뒤에는 새 요청을 받을 수 있다.

승인 대기는 최대 10초다. 수 초 안에 끝나는 회수는 같은 호출에서 기다리고, 회수가 길어지면 호출자에게 시간 초과를 반환한다. 이때 회수는 계속되며 만료되거나 발행 전에 취소된 요청은 pane을 생성하지 않는다. 승인 후에는 프런트엔드 응답을 최대 5초 기다리므로 두 단계의 대기 예산은 합계 15초다. 전달된 요청은 늦은 응답까지 추적한다.

## Alternatives Considered

- 분할·스택 추가를 탐색처럼 즉시 허용하면 회수가 세션을 저장하는 도중 레이아웃이 바뀔 수 있다.
- 호출자가 생성 도구를 다시 실행하게 하면 모든 클라이언트가 회수 정책을 알아야 한다. 이미 전달된 요청의 응답이 늦는 경우에는 재호출로 pane이 두 개 생길 수 있다.

## Consequences

사용자는 통상적인 회수가 끝나면 원래 호출의 응답으로 새 pane ID를 받는다. 회수가 오래 걸리면 호출 시간도 늘어난다. 동시 분할·스택 추가, 대기 기한, 전역 finalization, MCP 취소를 검증한다. Windows와 Linux가 같은 승인 경로를 사용한다.
