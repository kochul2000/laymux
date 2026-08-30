# 0218. Codex transcript 포인터 스크롤은 호스트 설정으로 표면 간 공유한다

- Status: Accepted
- Date: 2026-08-30
- Source: 사용자 요구("Remote에서 Codex Ctrl+T 모드 터치 스크롤을 방향키로 바인딩하고 Settings의 Codex 섹션에서 토글"), architecture/api-contracts.md §휠 스크롤 민감도·§Codex 설정·§13.3, [ADR-0206](0206-codex-normal-buffer-transcript-wheel-routing.md), [ADR-0142](0142-wheel-scroll-sensitivity-per-surface.md)
- Extends: [ADR-0206](0206-codex-normal-buffer-transcript-wheel-routing.md)

## Context

ADR-0206은 `alternate_screen = "never"`인 Codex transcript pager를 현재 화면의 헤더와 Codex activity로 판별하고, 데스크톱 마우스 휠을 방향키 입력으로 바꾸도록 정했다. 당시 Remote는 비목표였다. Remote의 터치 라우터는 normal buffer를 언제나 로컬 scrollback으로 취급하므로 같은 pager를 한 손가락이나 두 손가락으로 밀어도 Codex에 입력이 전달되지 않는다. Remote의 마우스 휠도 같은 이유로 로컬 viewport 경로에 머문다.

감도 값은 표면마다 물리 입력 특성이 달라 ADR-0142·ADR-0209에 따라 기기 로컬로 소유한다. 그러나 transcript에서 포인터 스크롤을 방향키 탐색으로 해석할지는 Codex 통합 동작의 활성 여부이며, 표면마다 뜻이 달라질 이유가 없다. 사용자는 이 편의 기능을 명시적으로 끌 수 있어야 하고, 일반 셸 scrollback이나 다른 TUI 입력은 영향을 받지 않아야 한다.

범위는 데스크톱 마우스 휠과 Remote 마우스 휠·한 손가락·두 손가락 스크롤이다. Codex keymap 해석, 다른 overlay 판별, 감도 설정의 소유권 변경은 비목표다.

## Decision

**normal-buffer Codex transcript의 포인터 스크롤 방향키 변환 활성 여부는 호스트 `codex.transcriptScrollEnabled` 하나가 소유하고, 데스크톱과 Remote가 같은 현재 화면 판별을 사용한다.**

- 설정은 기본 `true`, 적용 모드는 `live`다. 데스크톱은 settings store의 현재 값을 각 휠 이벤트에서 읽는다.
- Remote read-only `/remote/v1/navigation` 응답은 최상위 `codexTranscriptScrollEnabled` boolean을 투영한다. Remote 문서는 최신 navigation snapshot의 값이 명시적으로 `true`일 때만 특수 라우팅하며, 필드 누락·`false`는 기존 xterm/local scrollback 경로로 fail-open한다.
- 두 표면은 ADR-0206의 공용 판별 함수만 사용한다. terminal activity가 `interactiveApp/Codex`이고 현재 normal-buffer viewport에 정해진 transcript 헤더가 보이는 조건을 모두 만족해야 한다. Ctrl+T 입력이나 사용자 keymap 상태는 저장하지 않는다.
- Remote 마우스 휠은 고정 xterm의 wheel consumer가 계산한 행 수와 Remote 기기의 마우스 휠 감도를 사용한다. Remote 터치는 기존 한 손가락·두 손가락 픽셀→행 계산과 각 기기 로컬 감도를 유지한다.
- 방향키는 현재 DECCKM에 맞추고 행마다 별도 Remote write로 보낸다. replay 중이거나 active lease·terminal이 없으면 입력을 만들지 않는다.
- 설정은 의미적 Codex 동작만 gate한다. alternate buffer, mouse tracking TUI, 일반 normal-buffer scrollback의 기존 라우팅과 모든 감도 설정의 표면별 소유권은 바꾸지 않는다.

## Alternatives Considered

- **Remote 기기 로컬 토글로 둔다.** 감도처럼 장치의 물리 특성에 따른 값은 아니고 같은 Codex 편의 기능이 표면마다 다르게 켜지는 혼란이 생긴다. 호스트 Codex 설정을 SoT로 선택했다.
- **Remote에서 항상 활성화한다.** 구현은 작지만 사용자가 요청한 opt-out을 제공하지 못하고 기존 로컬 scrollback을 선호하는 사용자의 선택을 없앤다.
- **Remote 전용 화면 판별을 다시 구현한다.** 정적 클라이언트만 독립적으로 보이지만 Codex 헤더·좁은 pane 기준이 데스크톱과 갈라질 수 있다. 번들 입력에 공용 판별 모듈을 포함한다.
- **Ctrl+T gesture를 관찰해 Remote 상태를 둔다.** Remote의 soft key·사용자 키·데스크톱에서 이미 열린 화면 등 진입 경로를 모두 포착하지 못하고 ADR-0206이 기각한 keymap 중복 소유를 되살린다.

## Consequences

- 설정 하나로 데스크톱 휠과 Remote 휠·터치의 transcript 탐색을 함께 켜고 끌 수 있다. 기존 사용자는 기본값 `true`로 데스크톱 동작을 유지하며 Remote 기능도 바로 얻는다.
- Remote는 연결 시와 열린 drawer의 주기적 navigation 조회에서 설정 변경을 받는다. 별도 push channel은 만들지 않으므로 이미 연결된 상태에서 drawer가 닫혀 있으면 다음 navigation snapshot까지 반영이 늦을 수 있다.
- Remote 정적 bundle은 `codex-transcript-wheel.ts`도 생성 입력과 hash stamp에 포함해야 한다. 공용 판별 변경은 screen test와 Remote 브라우저 테스트를 함께 통과해야 한다.
- Codex가 화면 헤더를 바꾸면 두 표면 모두 잘못된 방향키를 보내지 않고 기존 scrollback으로 돌아간다. 새 overlay나 다른 표식까지 지원하려면 공용 판별 계약과 테스트를 다시 검토한다.
