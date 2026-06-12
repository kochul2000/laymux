# 0011. DECTCEM 커서 주차(park)를 shadow cursor 5번째 레이어로

- Status: Accepted
- Date: 2026-06-11
- Source: docs/terminal/cursor-jump-evidence/ (실측 트레이스), ADR-0008 확장

## Context

ADR-0008의 4-layer shadow cursor와 PR #207의 pre-frame 스냅샷(`frameSavedCursorX/Y`)에도 Codex pane에서 커서 튐이 재발했다. 실측 트레이스(`cursor-jump-evidence/codex-footer-frame.log`)를 재독해한 결과, DEC 2026 프레임의 양 끝점은 둘 다 신뢰할 수 없는 스냅샷 시점이었다:

- **post-frame**(`?2026l` 시점): Codex의 footer 프레임은 커서를 footer 행에 둔 채 끝난다 — footer로 점프.
- **pre-frame**(`?2026h` 시점): 타이핑·composer 행 이동처럼 프레임이 입력 커서를 *정당하게* 옮기는 경우 옛 위치를 복원하고, 프레임이 연속이면 직전 프레임이 footer에 두고 간 위치를 스냅샷한다. 기존 row-equality 동기화 게이트는 행이 바뀐 뒤를 복구하지 못해 footer에 고착될 수 있었다.

반면 트레이스에는 활용하지 않던 결정적 신호가 있었다: Codex는 매 프레임 flush 후 ~15ms 안에 **별도 청크로 `?25l` + CUP + `?25h`(hide–move–show)** 를 보내 보이는 커서를 입력 위치에 "주차"한다. 프레임 밖 DECTCEM show는 앱이 "보이는 커서는 여기"라고 선언하는, Codex가 내보내는 가장 권위 있는 커서 신호다.

## Decision

**DECTCEM(`?25l/h`)을 shadow cursor의 5번째 레이어로 채택한다.**

1. **프레임 밖 `?25h` = 커서 주차(권위 신호).** 그 순간의 버퍼 커서를 shadow cursor에 무조건(행 일치 게이트 없이) 기록한다.
2. **프레임 안 `?25h` = 리페인트 꼬리.** 위치를 신뢰하지 않고 visibility 플래그만 갱신한다.
3. **`?2026l` 직후에는 overlay를 동결(`parkPending`)** 하고 주차를 기다린다. settle 타임아웃(50ms) 안에 주차가 안 오면 기존 pre-frame 스냅샷 폴백으로 복귀한다 — 최악의 경우 "튀었다 돌아옴" 대신 "50ms 늦게 이동".
4. **지속적 `?25l`(앱이 커서를 숨김) 동안 overlay 캐럿도 숨긴다.** 한 청크 안의 일시적 hide/show 쌍은 rAF coalescing 때문에 화면에 도달하지 않는다.

상태 전이는 `ui/src/lib/shadow-cursor-state.ts`의 순수 함수(`applyDectcemShow/Hide`, `applyParkSettleTimeout`)로 두고(ADR-0005), 트레이스 리플레이 테스트를 `shadow-cursor-state.test.ts`에 둔다.

## Consequences

- pre/post-frame 스냅샷 "추측"이 앱의 명시적 선언으로 대체되어 타이핑 에코·composer 이동·연속 프레임·스크롤 케이스를 휴리스틱 없이 일괄 해결한다.
- 주차를 보내지 않는 TUI는 settle 타임아웃만큼(≤50ms) 커서 이동이 지연된다. 커서 블링크 주기보다 짧아 체감되지 않는다.
- 근본 원인은 Codex 자체 버그(footer 프레임이 `?25h` 전에 커서를 복원하지 않음 — openai/codex#9081, #2805 계열)다. upstream 수정이 들어와도 본 레이어는 무해하게 공존한다.
- ADR-0008의 "4-layer"는 본 ADR로 5-layer로 확장된다(번복 아님). research 정본 `docs/terminal/xterm-shadow-cursor-architecture.md`·`cursor-jump-evidence/README.md`는 사용자 승인 하에 함께 개정되었다.
