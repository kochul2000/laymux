# 0033. Terminal composer는 Send 단일 action을 제공한다

- Status: Accepted
- Date: 2026-07-16
- Source: 사용자 피드백(Insert와 Send의 구분이 일반적인 채팅형 composer 사용법과 어긋나고, Direct mode가 이미 실행 없는 터미널 편집을 제공함) · [ADR-0029](0029-detached-terminal-input-composer.md)

## Context

ADR-0029는 분리 입력 composer에 Enter 없이 PTY 입력줄을 채우는 Insert와 최종 CR까지 보내는 Send를 함께 두었다. Insert는 셸 자체의 completion·history·line editor를 사용하기 전에 입력줄을 미리 채울 수 있지만, composer가 이미 초안 편집을 담당하고 Direct mode도 같은 터미널 네이티브 편집 경로를 제공한다. 따라서 기본 surface에 두 action을 함께 노출하면 실질적으로 겹치는 기능 때문에 사용자가 “입력”과 “전송”의 차이를 먼저 학습해야 한다.

데스크톱 채팅형 composer에서는 일반 Enter로 전송하고 Shift+Enter로 줄바꿈하는 관례가 익숙하다. 반면 모바일 소프트 키보드는 Shift 조합을 안정적으로 제공하지 않으므로 Enter를 줄바꿈으로 유지하고 화면의 Send 버튼으로 제출해야 여러 줄 초안을 편집할 수 있다.

## Decision

- PC `TerminalView`와 Remote composer에서 Insert 버튼을 제거하고 Send action 하나만 노출한다. Composer Send는 structured input의 `submit=true`로 text와 최종 CR을 하나의 terminal input job에 넣는다.
- PC WebView와 fine-pointer Remote에서는 IME 조합 중이 아닌 일반 Enter가 Send다. Shift+Enter는 브라우저 기본 textarea 줄바꿈으로 남긴다.
- coarse-pointer Remote에서는 IME 조합 여부와 무관하게 제출 가능한 Enter gesture를 만들지 않는다. 조합 중 Enter는 IME에 위임하고, 그 밖의 Enter는 textarea 줄바꿈이며 화면의 Send 버튼만 제출한다.
- 전송 중 중복 action 차단, revision/token snapshot, 변경되지 않은 초안만 조건부 clear, 실패·불명확 결과에서 초안 보존 규칙은 ADR-0029의 계약을 그대로 유지한다.
- structured input API의 `submit=false`는 제거하지 않는다. Direct clipboard paste처럼 Enter를 붙이지 않아야 하는 내부 입력 경로에서 계속 사용하며, 사용자에게 보이는 composer action으로는 제공하지 않는다.
- output attach, authoritative bracketed-paste tracker, owner permit, PTY FIFO와 cancellation, lease·claim reservation 등 ADR-0029의 나머지 결정은 변경 없이 승계한다.

## Consequences

- 사용자는 composer에서 초안을 작성하고 전송하는 단일 흐름만 이해하면 된다. 실행 없는 셸 편집이 필요하면 Direct mode를 사용한다.
- PC와 fine-pointer Remote는 Enter/Shift+Enter 관례를 따르고, 모바일은 줄바꿈 능력을 잃지 않으면서 명시적인 Send 버튼으로 의도하지 않은 전송을 피한다.
- backend의 `{ text, submit }` 계약과 bracketed-paste 안전성은 유지되므로 Direct paste나 향후 내부 입력 경로가 영향을 받지 않는다.
- ADR-0029의 Insert/Send UI 및 키 gesture 결정만 이 ADR로 대체되며, 분리 composer와 backend 안전성 모델 자체는 유지된다.
