# 0177. Remote 터치 스크롤 민감도를 한 손가락·두 손가락으로 분리한다

- Status: Proposed
- Date: 2026-08-18
- Source: 사용자 요구("remote 에서 터치 스크롤 민감도만 되어 있는데 … 원래는 1손가락 민감도, 2손가락 민감도를 분리하려고 했어. 그래서 2손가락 민감도도 5배율로 두려고 했었다")
- Extends: [ADR-0142](0142-wheel-scroll-sensitivity-per-surface.md)

## Context

ADR-0142 는 Remote 터치 드래그 배율을 단일 키 `remote.touchScrollSensitivity`(기본 1)로 두고, 한 손가락·두 손가락 드래그가 같은 값을 공유한다고 전제했다. 실제 구현도 `routeOneFingerScroll`/`routeTwoFingerScroll` 이 본문이 동일해 같은 배율을 썼다.

그러나 원래 의도는 두 제스처를 분리하는 것이었다: 한 손가락은 1:1 물리 스크롤(정밀), 두 손가락은 긴 스크롤백을 빠르게 넘기는 가속(휠의 fast-scroll 과 같은 5배율). 폰 화면에서 스크롤백이 길 때 한 손가락 1:1 로는 여러 번 쓸어야 한다.

이벤트 레벨에서는 이미 완전히 분리돼 있다 — Pointer Events 로 활성 포인터 수(`touchPointers.size >= 2`)를 세어 `twoFingerScrolling` 모드와 별도 진입 함수를 갖는다. 빠졌던 것은 **배율 값 하나**뿐이었다. (안드로이드 WebView 는 네이티브 ScrollView 와 달리 두 손가락 스크롤을 자동 이벤트로 주지 않으므로, 페이지의 Pointer Events 레이어가 직접 세는 이 구조가 전제다.)

## Decision

**Remote 터치 드래그 배율을 두 키로 나눈다.** `remote.touchScrollSensitivity` 는 이제 **한 손가락** 전용(기본 1, 1:1 유지)이고, 새 키 `remote.twoFingerScrollSensitivity` 가 **두 손가락** 전용(기본 5)이다.

- 기존 키 이름을 유지하고 의미만 "한 손가락"으로 좁힌다 — 마이그레이션 없이 기존 설정값이 한 손가락 배율로 그대로 이어진다.
- 두 배율 모두 ADR-0142 의 나머지 계약을 그대로 따른다: `0.1..=20` 범위, 비양수/비수치는 각자 기본값으로 fallback, xterm 옵션이 아니라 Remote 페이지의 픽셀→행 환산 입력 델타에 한 번만 곱함, per-terminal appearance payload 로 전달, 다음 attach 기준 적용.
- **마우스 트래킹 TUI 는 여전히 휠 계약을 따른다** — 정상 스크롤백 모드에서만 두 배율이 갈리고, TUI 합성 wheel 경로는 두 손가락도 xterm `scrollSensitivity` 를 쓴다(ADR-0142 §29 유지).
- 데스크톱 Settings 의 Remote 섹션에 "한 손가락/두 손가락" 두 행으로 노출하고 한/영 라벨을 둔다.

## Alternatives Considered

- **단일 키 유지(현행).** 스키마가 가장 단순하나 원래 의도인 "정밀 한 손가락 + 가속 두 손가락"을 못 준다. 기각.
- **두 손가락을 fastScroll 휠 배율에 연동.** 값 하나 아끼지만 서로 다른 축(터치 픽셀→행 vs 휠 notch)이라 의미가 어긋나고, 휠 값 변경이 터치까지 흔든다. ADR-0142 가 이미 터치를 휠에서 분리한 이유와 동일하게 기각.
- **두 손가락을 핀치줌으로만 쓰기.** 두 손가락 스크롤이 이미 구현돼 있고 사용자 요구가 스크롤 가속이라 부적합.

## Consequences

- 설정 키가 하나 늘어(`remote.twoFingerScrollSensitivity`) Remote 섹션이 5개 행이 된다.
- 기본값이 한 손가락 1 / 두 손가락 5 로 갈리므로, 두 손가락 스와이프는 기본적으로 5배 빠르게 넘어간다 — 사용자가 원한 동작이자 새 기본값의 체감 변화다.
- ADR-0142 §27 의 "세 번째 키, 기본 1, 한/두 손가락 공통" 서술은 이 ADR 로 보완된다: 터치 배율은 이제 두 키이고 두 손가락 기본은 5다.
- 마이그레이션 없음(내부 개발 단계). 기존 `touchScrollSensitivity` 값은 한 손가락 배율로 승계되고, 두 손가락 키는 기본 5 로 채워진다.
