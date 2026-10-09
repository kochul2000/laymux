# 0302. TUI 화면 폭 줄바꿈은 버퍼 셀 폭으로 판정해 복사·여러 줄 URL 링크가 공유한다

- Status: Accepted
- Date: 2026-10-09
- Source: PR #1148, `docs/architecture/data-flow.md` §8.6, 설정 `paste.removeLineBreak`·`paste.linkJoin`, 관련 [ADR-0235](0235-wrapped-path-link-logical-lines.md)

## Context

Claude Code·Codex 같은 전체 화면 TUI 는 긴 문단과 URL 을 터미널 auto-wrap 에 맡기지 않고 행마다 진짜 개행과 내어쓰기(2칸, 목록 4칸)를 넣는다. xterm 버퍼에는 이 행들이 `isWrapped=false` 로 남으므로 `getSelection()` 은 화면 폭마다 개행과 내어쓰기를 그대로 복사하고, 문자열만 보는 기존 휴리스틱(`smartRemoveLineBreak` 의 URL 복원, 같은 들여쓰기 줄을 잇는 indented link provider)은 "화면 폭에서 넘어간 행"과 "원래 개행"을 구분하지 못했다. 그 결과 `paste.removeLineBreak`(기본 켜짐)는 TUI 출력에서 거의 동작하지 않았고, 여러 줄 URL 링크는 목록 URL 을 놓치거나 줄 끝 URL 에 다음 줄 첫 단어를 붙였다.

같은 문제 영역의 경로 링크는 [ADR-0235](0235-wrapped-path-link-logical-lines.md)가 "오른쪽 끝 경로 토큰·같은 들여쓰기·후속 경로 토큰" 조건으로 hard wrap 을 잇는다. 이 결정은 경로 토큰 문법에 묶여 있어 산문·URL 에는 쓸 수 없다.

범위: 데스크톱 복사(`runTerminalCopy`)와 여러 줄 URL link provider. 비목표: 경로 링크 판정 교체, Remote 페이지의 `WebLinksAddon`, 붙여넣기 경로(버퍼가 없다).

## Decision

**복사와 여러 줄 URL 링크는 버퍼 행의 셀 폭으로 화면 폭 줄바꿈을 판정하는 단일 함수(`detectTuiWrap`)를 공유하고, `paste.removeLineBreak` 는 복사 시 이 판정으로 TUI 가 나눈 행(산문 포함)을 잇는 동작까지 포함한다.**

- **판정 불변식** — 줄바꿈기는 들어갈 토큰을 다음 행으로 넘기지 않는다. 따라서 `이전 행 끝 셀 + 1 + 다음 첫 토큰 셀 > cols` 이고 다음 행이 이전 문단의 내어쓰기(마커 뒤 내용 시작 또는 들여쓰기)에 정렬될 때만 연속 행이다. 빈 행·목록 마커 행·박스/표 테두리 행·말줄임(`…`)으로 끝난 행은 잇지 않는다.
- **줄바꿈 폭 여백** — TUI 의 줄바꿈 폭은 cols 보다 좁을 수 있다(Codex 입력창 cols-1, Claude OAuth cols-2). 단어 중간 판정은 이 여백을 허용한다.
- **복사는 내어쓰기 있는 연속 행만 잇는다** — TUI 연속 행은 항상 내어쓰기가 있고, 0열 행이 화면 폭을 채우는 출력은 대부분 셸 출력(pytest 진행 줄, 폭에서 잘린 `ps aux`)이다. 기본 켜짐 설정이 셸 출력을 바꾸지 않는 것이 산문 결합보다 우선한다.
- **매핑을 믿을 수 없으면 원문** — 선택 문자열이 일반(행 단위) 선택으로 버퍼 행에서 나온 것과 맞지 않으면(열 선택 등) 버퍼 결합을 건너뛰고 `getSelection()` 원문을 쓴다. 복사 결과가 원문보다 나빠지지 않는 것이 불변식이다.
- **음절 단위 줄바꿈** — 활동이 Codex 인 pane 은 한글을 음절 사이에서도 자르므로 와이드 문자끼리 맞닿은 행 끝 경계를 공백 없이 잇는다. 원래 공백이 있었는지는 버퍼에 남지 않으므로 공백 없는 쪽으로 기운다.
- **URL 경계** — `WebLinksAddon`, 여러 줄 URL provider, TUI 마우스 우회 클릭은 같은 `TERMINAL_URL_REGEX` 를 쓰며 RFC 3986 ASCII 문자만 URL 로 본다. 바로 붙은 한글 조사·전각 구두점은 URL 이 아니다. 퍼센트 인코딩되지 않은 한글 경로는 한글 앞까지만 링크된다.
- **경로 링크는 ADR-0235 판정을 유지한다** — 경로 토큰 조건은 경로 문법에 근거한 별도 판정이며 이번 결정으로 바뀌지 않는다.

## Alternatives Considered

- **문자열 휴리스틱 강화** — 복사 문자열만으로는 행이 화면 폭에서 끝났는지 알 수 없어 원래 개행과 구분되지 않는다. 기각.
- **활동(Claude/Codex) 감지로만 결합 켜기** — 앱 종료 뒤 scrollback 복사를 잃고, 활동 감지 지연에 결과가 흔들린다. 0열 행을 잇지 않는 조건만으로 셸 출력 회귀를 막을 수 있어 기각. 활동은 줄바꿈 단위(`word`/`anywhere`) 선택에만 쓴다.
- **새 설정 키 추가** — `paste.removeLineBreak` 의 이름("스마트 줄바꿈 제거")이 이미 이 동작을 가리키고, 이번 단계는 마이그레이션 없는 내부 개발 단계다. 설명 문구만 실제 동작에 맞춘다.
- **경로 링크(ADR-0235)와 판정 통합** — 경로 판정은 Remote 3 mode 와 공유하고 토큰 문법에 묶여 있다. 범위가 커서 이번 결정에서 제외한다.

## Consequences

- TUI 문단·목록·잘린 URL 을 복사하면 한 줄로 이어지고 연속 행 내어쓰기가 지워진다. 여러 줄 URL 링크가 목록 URL 을 잡고 줄 끝 URL 에 다음 단어를 붙이지 않는다.
- 남는 모호성: 원래 공백이 있던 Codex 한글 경계는 공백 없이 이어진다. 줄바꿈 폭과 거의 같은 길이의 URL 이 자기 행을 통째로 차지하면 다음 행 첫 단어가 URL 꼬리로 붙을 수 있다. 0열에서 시작하는 TUI 연속 행이 생기면 복사에서 잇지 않는다.
- 줄바꿈 단위는 선택 전체에 pane 의 현재 활동 하나로 적용된다 — Codex 실행 중 그 이전 셸 scrollback 을 함께 선택하면 `anywhere` 로 판정된다.
- 판정 근거는 실측 버퍼 fixture(`ui/src/lib/__fixtures__/tui-wrap-capture.ts`)로 고정하며, TUI 레이아웃이 바뀌면 fixture 를 다시 캡처해 이 결정을 재검토한다.
