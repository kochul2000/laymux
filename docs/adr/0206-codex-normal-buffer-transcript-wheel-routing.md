# 0206. Codex normal-buffer transcript의 휠은 pager 입력으로 라우팅한다

- Status: Accepted
- Date: 2026-08-26
- Source: 사용자 요구("ctrl + t 모드로 볼 때에 마우스 휠을 움직여도 화면이 전혀 움직이지 않아. 이거 움직이도록 해줘."), architecture/api-contracts.md §Settings/휠 스크롤 민감도, [ADR-0142](0142-wheel-scroll-sensitivity-per-surface.md)

## Context

Codex transcript pager는 기본적으로 alternate buffer를 사용하므로 xterm이 휠을 위/아래 커서키로 바꿀 수 있다. 그러나 사용자가 Codex 설정에서 `alternate_screen = "never"`를 선택하면 같은 pager가 normal buffer에 렌더된다. xterm은 normal buffer에 scrollback 용량이 있다는 사실만 보고 휠을 로컬 viewport 스크롤로 처리하며, pager에는 아무 입력도 보내지 않는다. pager가 현재 화면 전체를 다시 그리는 동안에는 로컬 viewport도 움직일 여지가 없어 사용자는 휠이 완전히 무반응인 것으로 보게 된다.

고정 xterm 번들의 기존 보정은 alternate buffer와 마우스 추적 TUI에서 민감도에 따른 행 수를 반복 전송하지만 normal buffer를 애플리케이션 소유 화면으로 판정할 근거는 갖고 있지 않다. normal buffer의 모든 휠을 커서키로 바꾸면 셸 프롬프트에서 명령 기록이 뜻하지 않게 이동한다.

Codex의 transcript 단축키는 사용자 keymap으로 바뀔 수 있다. 따라서 기본 Ctrl+T 입력을 관찰해 임시 상태를 세우는 방식은 키바인딩 계약을 중복 소유하며, 종료 입력이나 화면 전환을 놓치면 stale 상태가 남는다. 반면 pager는 자신이 그리는 현재 화면에 고유 헤더 `/ T R A N S C R I P T`를 계속 렌더한다.

범위는 데스크톱 TerminalView에서 normal buffer로 실행되는 Codex transcript pager의 마우스 휠이다. Remote 입력 표면, 다른 Codex overlay, Codex keymap 변경, xterm의 일반 scrollback 정책은 비목표다.

## Decision

**데스크톱 TerminalView는 활성 앱이 Codex이고 normal buffer의 현재 viewport에 Codex transcript 헤더가 보일 때만 휠을 pager의 위/아래 커서키 입력으로 라우팅한다.**

- 판정 원시는 terminal store의 `{type:"interactiveApp", name:"Codex"}`, xterm active buffer의 `type`, 현재 viewport의 line text 세 가지다. 화면 판정은 이 원시 상태를 한 함수에서 함께 계산하며 별도 "Ctrl+T mode" 상태를 저장하지 않는다.
- transcript 화면 표식은 현재 viewport에서 `/ T R A N S C R I P T`로 시작하는 행이다. pane이 21열보다 좁아 Codex가 헤더를 자르면 terminal 폭만큼의 prefix를 비교하되, 오탐을 막는 최소 표식은 `/ T R A N` 9열로 고정한다. 기본 Ctrl+T나 사용자 keymap, Codex 설정 파일을 읽어 판정하지 않는다.
- TerminalView의 custom wheel handler가 xterm의 일반 wheel 처리보다 먼저 판정한다. 조건이 맞으면 고정 xterm core의 `consumeWheelEvent`가 계산한 민감도·Alt 가속·소수 remainder 반영 행 수를 그대로 사용한다.
- 계산된 각 행은 현재 DECCKM(application cursor keys) 모드에 맞는 위/아래 시퀀스로 변환하고 한 행씩 별도 user input으로 방출한다. ConPTY가 같은 커서키를 한 write에서 축약하지 못하게 하는 기존 alternate-buffer 불변식을 유지한다.
- 로컬 제어권이 없거나, Codex가 아니거나, alternate buffer이거나, 헤더가 보이지 않거나, xterm wheel 내부 계약을 사용할 수 없으면 handler는 입력을 만들지 않고 xterm의 기존 처리로 넘긴다. 판정 실패는 셸 입력 오작동이 아니라 기존 로컬 scrollback 동작으로 fail-open한다.

## Alternatives Considered

- **Ctrl+T keydown으로 pager 진입 상태를 저장한다.** 구현은 단순하지만 Codex keymap을 중복 하드코딩하고, 다른 명령에 Ctrl+T가 배정되거나 종료 이벤트를 놓치면 상태가 틀어진다. 저장하지 않고 현재 화면에서 파생하는 쪽을 선택했다.
- **Codex activity인 normal buffer의 모든 휠을 커서키로 바꾼다.** transcript는 움직이지만 일반 Codex 대화 화면의 scrollback을 읽을 수 없고, 입력부 기록 선택까지 우발적으로 움직인다. 화면 표식으로 범위를 좁혔다.
- **normal buffer 전체에서 scrollback 끝에 있을 때만 커서키를 보낸다.** Codex 이외의 셸 프롬프트에서도 휠이 명령 기록을 바꾸며, transcript 소유권을 증명하지 못한다.
- **사용자의 Codex config/keymap을 읽어 단축키와 alternate-screen 정책을 해석한다.** 외부 제품의 설정 스키마와 경로를 laymux가 소유하게 되고 실행 중 설정·버전과 어긋날 수 있다. 실제로 렌더된 화면이 더 직접적인 근거다.
- **`alternate_screen = "never"`를 무시하고 alternate buffer를 강제한다.** 사용자의 명시적 Codex 선택과 normal-buffer transcript 보존 목적을 깨므로 기각했다.

## Consequences

- 사용자는 기본 Ctrl+T든 재바인딩된 키든, normal-buffer transcript가 실제로 보이는 동안 휠로 이동할 수 있다. 기존 민감도와 Alt 가속도 그대로 적용된다.
- 셸·일반 Codex 화면·다른 TUI·alternate buffer의 동작은 기존 xterm 경로에 남는다. 새 설정이나 마이그레이션은 없다.
- 화면 표식은 Codex의 표현 계약에 의존한다. 이후 Codex가 transcript 헤더를 바꾸면 기능은 조용히 기존 local scrollback으로 돌아가며, 잘못된 커서 입력을 보내지는 않는다. 9열 미만 pane도 충분히 고유한 표식을 증명할 수 없어 같은 fail-open 경로를 쓴다. 지원 버전을 올릴 때 전체 폭과 좁은 pane의 실제 xterm screen test 표식을 함께 갱신한다.
- 고정 xterm의 내부 wheel consumer를 사용한다. 이 저장소가 이미 postinstall exact-pattern patch와 실제 번들 screen test로 같은 내부 계약을 고정하고 있으므로 새 독립 계산기를 만들지는 않는다. xterm을 올릴 때 내부 접근과 fractional accumulator 테스트를 함께 검토해야 한다.
- 이 결정은 Remote 표면을 바꾸지 않는다. Remote에서 같은 요구가 확인되면 ADR-0142의 표면별 소유권에 따라 별도 입력 경로와 실제 브라우저 테스트를 설계한다.
