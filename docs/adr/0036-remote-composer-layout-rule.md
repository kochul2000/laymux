# 0036. Remote composer 전송 gesture는 pointer가 아니라 layout을 따른다 (0034 보완)

- Status: Accepted
- Date: 2026-07-18
- Source: 사용자 결정(PC 앱 모바일 뷰는 "모양이 모바일이면 거동도 모바일") · PR #466 리뷰 · [ADR-0034](0034-single-send-terminal-composer.md)

## Context

ADR-0034 는 composer 의 Enter/Send gesture 를 pointer 종류로 분류했다: PC WebView 와 fine-pointer Remote 는 일반 Enter 가 Send, coarse-pointer Remote 는 Enter 가 줄바꿈이고 화면의 Send 버튼만 제출한다.

그러나 Remote 페이지에는 pointer 축으로 설명되지 않는 접속 형태가 있다. PC 앱이 Remote 페이지를 모바일 모양으로 임베드하는 `localApp=1` 뷰는 fine pointer(마우스·키보드)로 조작되지만 화면은 모바일 UI 다. ADR-0034 대로면 이 뷰는 "모바일 모양인데 Enter 가 전송이고 Send 버튼이 없는" 혼종이 된다. 모바일 뷰의 존재 의의가 모바일 경험의 미리보기·검증이므로, 모양과 거동이 어긋나면 실기기 없이 모바일 거동을 확인할 수 없고 사용자 멘탈 모델도 접속 형태마다 갈라진다.

또한 PR #466 초기 구현이 모바일 layout 의 키보드 전송 보완책으로 Ctrl/Cmd+Enter 를 하드코딩했는데, 이는 keybinding 시스템을 거치지 않는 직접 modifier 검사로 `docs/architecture/api-contracts.md` §15.5(재바인딩 불가능한 단축키 금지, Settings 에 없는 단축키는 존재하지 않는 것) 위반이다.

## Decision

- 전송 gesture 분류 축을 pointer 에서 **layout** 으로 바꾼다. 규칙은 한 줄이다:

  `mobileLayout = (pointer: coarse) || localApp=1`

  - **desktop layout** (fine-pointer 웹): IME 조합 중이 아닌 일반 Enter 가 Send, Shift+Enter 는 줄바꿈, Send 버튼 없음.
  - **mobile layout** (터치 기기, PC 앱 임베드 모바일 뷰): Enter 는 항상 줄바꿈이고 footer 우측의 Send 버튼만 제출한다. 소프트 키보드의 Enter(keyCode 229·IME 경합)는 전송 경로에서 완전히 제외된다.
- PC 앱 임베드 모바일 뷰(`localApp=1`)는 fine pointer 여도 mobile layout 이다 — 모양이 모바일이면 거동도 모바일. 데스크톱 gesture 가 필요하면 "PC" 버튼으로 네이티브 UI 에 복귀한다.
- composer 에 keybinding 시스템 밖의 키보드 전송 단축키를 하드코딩하지 않는다(§15.5). Ctrl/Cmd+Enter 전송은 도입하지 않으며, 필요해지면 재바인딩 가능한 keybinding 계약으로만 추가한다.
- 이 분류는 기본값이다. 추후 설정 override 를 추가할 수 있으나 기본 규칙은 위 한 줄을 유지한다.
- ADR-0034 의 나머지 계약(Send 단일 action, `submit=true` structured input, 조합 중 Enter 미제출, 전송 중 초안 보존 규칙)은 그대로 승계한다.

## Alternatives Considered

- **localApp 뷰가 fine-pointer 규칙을 따름(ADR-0034 유지)** — 모바일 모양과 데스크톱 거동의 혼종이 되어 모바일 UX 를 PC 에서 검증할 수 없고, Send 버튼이 실기기 전용이 된다. 기각.
- **Ctrl/Cmd+Enter 를 mobile layout 키보드 전송으로 하드코딩** — §15.5 위반이고 IME 조합 가드보다 앞에 두면 조합 중 이전 초안을 오전송하는 결함도 있었다. 기각.
- **pointer 자동감지 대신 명시적 모드 토글** — 결정적이지만 대부분의 접속에서 불필요한 수동 단계가 생긴다. 기본값은 자동, override 는 추후 설정으로. 기각(부분 채택).

## Consequences

- 접속 형태별 거동이 표 하나로 고정된다: PC 웹=desktop layout, 모바일 웹·PC 앱 모바일 뷰=mobile layout.
- 모바일 전송 경로에 키보드 이벤트가 없으므로 Android soft keyboard 의 keyCode 229/IME 경합 버그류가 구조적으로 재발하지 않는다.
- PC 앱 모바일 뷰 사용자는 plain Enter 전송을 잃는다(줄바꿈으로 변경). 전송은 Send 버튼 클릭이며, 이는 모바일 미리보기라는 뷰의 목적에 부합한다.
- ADR-0034 의 pointer 기반 gesture 분류 문장만 이 ADR 로 대체되고, ADR-0034 자체는 Accepted 로 유지된다.
