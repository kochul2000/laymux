# 0038. Remote 높이 축소는 surface-local crop — normal buffer의 rows 축소를 PTY에 전파하지 않음

- Status: Accepted
- Date: 2026-07-19
- Source: 사용자 보고(remote에서 Codex 터미널만 대량 스크롤 반복) · ADR-0015 · ADR-0026 · [openai/codex PR #18575](https://github.com/openai/codex/pull/18575)
- Relation: [ADR-0015](0015-remote-terminal-state-ownership.md)의 PTY 전역/surface 로컬 경계를 확장한다.

## Context

Codex CLI 0.128.0부터 터미널 리사이즈(SIGWINCH)마다 전체 트랜스크립트를 새 폭으로 재래핑해 스크롤백에 재출력한다(scrollback reflow). 이는 codex 쪽의 의도된 기능이며 진짜 geometry 변경에서는 올바른 동작이다. 그러나 remote browser surface는 PTY resize를 자주 유발한다: 소프트 키보드 열림/닫힘(`visualViewport` resize), composer drag 확장, 키바 토글, URL bar 변화가 모두 terminal host 높이를 바꾸고, 기존 정책은 모든 fit 결과를 PTY `cols/rows`로 전파했다. 결과적으로 키보드를 토글할 때마다 codex가 전체 히스토리를 다시 쏟아내 remote 뷰포트가 한참 스크롤되고 스크롤백에 사본이 누적된다. 스냅샷 상한(PR #472)은 attach 시점 재생만 제한하므로 live delta로 도착하는 이 flood를 막지 못한다. Claude Code처럼 리사이즈 시 자기 렌더 영역만 다시 그리는 TUI에서는 증상이 없다.

비목표: attach 시 PC↔remote geometry가 실제로 다른 데서 오는 1회 재출력 제거(진짜 폭 변경이므로 reflow가 맞다), 데스크톱 `TerminalView`의 리사이즈 정책 변경, codex 자체 동작 회피.

## Decision

Remote surface에서 **폭 변경 없이 높이만 줄어드는 경우, normal buffer라면 PTY geometry를 유지하고 xterm surface를 바닥 고정(bottom-anchored)으로 crop한다.** 뷰포트 높이 축소를 PTY 전역 상태가 아니라 surface 로컬 상태로 재분류하는 것이다.

- xterm은 host가 아니라 내부 sizer 요소에 마운트한다. sizer는 평소 host를 따라가고(100%), 높이 축소 시 마지막 fit된 픽셀 높이로 고정되어 host 하단에 정렬된다. TUI가 프롬프트를 그리는 live tail이 항상 보인다.
- 폭 변경과 높이 증가는 기존대로 fit + PTY resize를 전파한다.
- alternate buffer는 스크롤백이 없어 flood가 발생하지 않고, 전체 화면 앱은 상단 행이 필요하므로 crop하지 않고 항상 fit을 전파한다. crop 중 buffer 전환이 일어나면 즉시 재평가한다.
- PTY resize의 controller owner 규칙(ADR-0015)은 불변이다. remote가 owner인 동안 보내는 resize의 "언제"만 달라진다.

## Alternatives Considered

- **resize debounce 연장**: 키보드 애니메이션 중 중복 전송은 줄지만 열림/닫힘 각각의 최종 rows 변경은 여전히 전파되어 flood가 그대로 발생한다.
- **rows를 항상 최대 뷰포트 기준으로 고정**: 높이 증가까지 무시하면 회전·창 확대에서 영구적으로 작은 화면에 갇힌다. 증가는 전파하는 비대칭 정책이 더 예측 가능하다.
- **키보드 감지 휴리스틱(`navigator.virtualKeyboard` 등)으로 키보드일 때만 crop**: 지원 편차가 크고, composer drag·URL bar 같은 다른 높이 축소 원인을 놓친다. "폭 불변 + 높이 축소"라는 geometry 조건이 더 단순하고 전체 원인을 덮는다.
- **codex 전용 감지/우회**: surface가 특정 TUI를 식별하는 것은 계층 위반이고, 같은 전략을 쓰는 다른 TUI에 일반화되지 않는다.

## Consequences

- 소프트 키보드·composer·키바·URL bar로 인한 높이 변화가 더 이상 PTY resize를 만들지 않아, scrollback-reflow형 TUI(codex)의 재출력 flood가 remote 상호작용 중 발생하지 않는다.
- 높이 축소 중 normal buffer 화면은 상단이 잘린 채 하단 슬라이스만 보인다. 키보드가 열린 동안 사용자는 어차피 하단(프롬프트/입력)과 상호작용하므로 수용한다. 스크롤백 탐색은 xterm 내부 스크롤로 계속 가능하다.
- 데스크톱 브라우저에서 창 높이만 줄여도 crop이 일어난다(다시 늘리면 fit 복귀). rows 축소를 원하면 폭도 함께 바꾸면 된다 — 문서화된 비대칭이다.
- attach 시 PC↔remote 폭 차이로 인한 1회 재출력은 남는다. 이는 진짜 geometry 변경이며 codex reflow가 올바르게 동작하는 경우다.
- 재검토 조건: codex가 리사이즈 재출력을 델타화하거나, remote가 Full UI(React bundle)로 전환되어 fit 스케줄러(ADR-0026)를 공유하게 되는 시점.
