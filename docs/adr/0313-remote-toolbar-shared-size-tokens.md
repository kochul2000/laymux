# 0313. Remote 툴바는 하나의 크기 토큰을 공유하고 드로어 헤더는 자기 폭으로 압축한다

- Status: Accepted
- Date: 2026-10-11
- Source: 사용자 결정("공통 레이아웃값 제안해줘" → 40/32/16 제안 승인), PR #1170, [ADR-0180](0180-remote-hidden-workspace-header-icon.md)
- 관계: ADR-0180이 정한 "240px 이하 **viewport**에서 drawer header control을 압축한다"를 "drawer 자신의 폭이 240px 미만일 때 압축한다"로 정정한다. 모든 action을 한 행 안에 둔다는 ADR-0180의 목표는 그대로다.

## Context

Remote의 툴바 네 종류(앱 최상단 헤더, 워크스페이스 drawer 헤더, 파일 뷰어 헤더, 메모·GitHub 헤더)는 각자 크기를 정해 왔다.
- 행 높이: 39 / 32 / 41 / 41px
- 버튼: 26 / 26 / 24 / 30px
- 아이콘: 14px, 메뉴만 18px

drawer를 열면 최상단 헤더 바로 아래에 더 낮은 행이 붙고, 도구마다 버튼 크기가 달라 탭 감각도 달랐다.

버튼을 키우면 drawer 헤더의 action row가 더 넓은 폭을 요구한다. ADR-0180의 압축 조건은 viewport 폭(240px 이하)이었다. 그런데 drawer 폭은 viewport와 별개로 기기 로컬 Menu width 설정(최소 200px, ADR-0209)으로도 좁아진다. 32px 버튼에서는 viewport 241~250px 구간과 좁은 Menu width 설정에서 action row가 넘쳐 가로 스크롤이 생기고, 오른쪽 Settings 버튼이 밀려났다.

## Decision

**Remote의 모든 툴바는 `--toolbar-height`(40px, 아래 테두리 포함), `--toolbar-control-size`(32px), `--toolbar-icon-size`(16px), `--toolbar-padding-x`(6px), `--toolbar-gap`(4px) 토큰 하나를 공유한다.**

- 페이지의 모든 `<header>`는 툴바다. `header, .drawer-header` 규칙 하나가 행 기하와 툴바 버튼 안 아이콘 크기를 소유한다. 개별 툴바 규칙은 배경·정렬 같은 고유 속성만 가진다.
- 툴바의 아이콘 버튼은 `--toolbar-control-size` 정사각형이고 텍스트 버튼은 같은 높이에 폭만 내용에 맞춘다. 파일 뷰어 버튼도 다른 툴바처럼 테두리 없는 ghost 버튼으로 맞춘다.
- drawer 헤더의 압축(제목 숨김, control 24px, gap 0)은 viewport가 아니라 `.navigation-panel` container의 폭이 240px 미만일 때 적용한다. 앱 최상단 헤더의 240px viewport 압축은 그대로 둔다.
- 사용자 배율 설정을 가진 입력 행(Main/Keys)과 플로팅 컨트롤은 이 토큰을 따르지 않는다.

## Alternatives Considered

- **36 / 28 / 14 컴팩트 값:** 기존 크기에 가깝고 터미널 공간을 3px 더 남긴다. 하지만 26px 안팎의 터치 대상이 그대로 남아 탭 실패를 줄이지 못하므로 선택하지 않았다.
- **viewport 미디어 쿼리 breakpoint만 올리기(약 252px):** 변경은 가장 작다. 하지만 Menu width 설정으로 좁아진 drawer는 여전히 넘치므로 선택하지 않았다.
- **breakpoint 없이 action 버튼을 flex-shrink로 줄이기:** 폭 계산이 필요 없다. 하지만 제목이 반쯤 잘린 채 버튼과 함께 줄어들고, ADR-0180이 정한 "제목 숨김 후 압축" 순서를 보장하지 못하므로 선택하지 않았다.
- **데스크톱(`pointer: fine`)만 더 작게:** 화면을 더 촘촘히 쓸 수 있다. 하지만 같은 페이지에 두 규격이 생기고, 사용자는 하나의 값을 원했으므로 선택하지 않았다.

## Consequences

- 툴바 높이가 40px로 통일된다. 앱 헤더는 1px 커지고, drawer 헤더는 8px 커지며, 파일 뷰어·메모·GitHub 헤더는 1px 작아진다.
- 툴바 버튼의 터치 대상이 32px로 커진다. `.github-row-action`은 헤더 액션과 같은 규칙을 공유하므로 목록 행 액션도 32px가 된다.
- 파일 뷰어에서 파일을 열면 버튼이 넓어진 만큼 좁은 화면의 제목 공간이 줄어든다(320px에서 약 38px, 280px에서 0). 360px 이하에서 줌 표시와 Reset을 숨기는 기존 규칙만 유지한다. 더 좁은 화면을 위한 버튼 축소는 후속 판단으로 남긴다.
- drawer 압축 임계값 240px은 기본 글자 크기에서 모든 action(PC, 숨긴 워크스페이스 포함)이 들어가는 최소 폭(약 223px)에 여유를 둔 값이다. Menu font size를 크게 키워 `PC` 라벨이 넓어지면 재검토한다.
- 검증은 툴바 네 종류의 행·버튼·아이콘 크기를 고정하는 e2e와, drawer 폭이 240px 미만일 때 action row가 넘치지 않는지 확인하는 e2e가 맡는다.
