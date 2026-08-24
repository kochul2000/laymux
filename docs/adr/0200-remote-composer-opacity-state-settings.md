# 0200. Remote Composer 투명도는 PC 소유 3단계 표시 설정이다

- Status: Accepted
- Date: 2026-08-24
- Source: 사용자 요구("composer 영역의 투명도를 remote settings 에서 수정", "Idle 55% · Focused 80% · Active 100%", "Active 는 기본적으로 완전히 불투명") · [architecture/api-contracts.md §10·§13](../architecture/api-contracts.md) · [ADR-0173](0173-remote-display-settings-pc-owned-and-lease-gated.md)
- Extends: ADR-0173

## Context

Remote 입력 Composer는 터미널 아래에 계속 자리를 차지하는 별도 surface다. 지금은 textarea가 불투명한 고정 배경을 사용하고, 연결 불가 시 textarea에 고정 opacity를 한 번 적용할 뿐이다. 사용자는 입력하지 않을 때 Composer가 terminal chrome보다 덜 두드러지고, 포커스를 얻거나 실제 입력 작업이 시작될수록 단계적으로 선명해지도록 조절할 수 없다.

Composer에는 lease, output readiness, 첨부, 전송, 포커스, 초안, 추천 목록, IME처럼 겹치는 raw 상태가 있다. 이들을 설정 항목으로 그대로 노출하면 상태 조합과 우선순위까지 사용자가 이해해야 한다. 표시 목적에는 입력 표면의 관여 정도를 나타내는 Idle, Focused, Active 세 단계면 충분하다. 이 값은 PC Settings와 여러 Remote 클라이언트가 공유해야 하므로 기존 PC 소유 display-settings projection에 속한다.

범위는 Remote Composer 전체 surface의 opacity 상태 계산·기본값·영속 소유권이다. Direct 입력, Composer 접힘 동작, 초안/history 비영속 경계, terminal geometry/crop 정책, desktop Composer의 표시는 바꾸지 않는다.

## Decision

**Remote Composer opacity는 PC의 `settings.remote`가 소유하는 Idle·Focused·Active 세 정수 백분율이며, 런타임은 단일 우선순위 계산으로 정확히 한 단계를 선택한다.**

- 설정 키는 `composerIdleOpacity`, `composerFocusedOpacity`, `composerActiveOpacity`다. 기본값은 각각 55, 80, 100이고 범위는 20~100, 입력 step은 5다. 저장 불변식은 `Idle ≤ Focused ≤ Active`다.
- 세 값은 ADR-0173의 `GET/PUT /remote/v1/display-settings` projection에 함께 실린다. 기존 Remote 인증, active controller lease, `expectedRevision` CAS, 충돌 시 409·재조회 정책을 그대로 따른다. PC Settings ▸ Remote Display와 Remote drawer ▸ Settings ▸ Display가 같은 값을 편집한다.
- Direct mode이거나 Composer가 접힌 경우 surface는 계속 `hidden`이며 opacity 상태를 표시하지 않는다. 보이는 Composer는 다음 우선순위로 한 상태만 고른다.
  1. 입력이 disabled이면 `Idle`이다. 연결 불가·terminal 없음·첨부 업로드로 비활성화된 경우를 별도 opacity 단계로 만들지 않는다.
  2. 초안이 비어 있지 않거나 history/autocomplete 목록이 열렸거나 IME 조합 또는 structured input 전송이 진행 중이면 `Active`다.
  3. textarea가 DOM focus를 가지면 `Focused`다.
  4. 나머지는 `Idle`이다.
- 상태 계산은 raw 상태를 읽는 단일 함수가 소유하고 `.terminal-composer`의 `data-opacity-state`에 투영한다. CSS는 PC 설정에서 채운 세 custom property 중 해당 값을 `opacity`로 적용한다. Active 기본값은 1이므로 입력 텍스트와 추천 목록이 완전히 불투명하다.
- opacity는 Composer surface 전체에 적용한다. 추천 목록이 열린 상태는 Active이므로 목록도 기본적으로 완전히 불투명하며, disabled textarea의 기존 고정 opacity를 중첩 적용하지 않는다. 상태 전환은 짧은 CSS transition을 사용하되 reduced-motion에서는 전환을 제거한다.

## Alternatives Considered

- **lease/readiness/첨부/전송까지 각각 설정한다.** 실제 raw 상태를 충실히 드러내지만 겹치는 조합과 우선순위를 설정 UI에 노출하고 사용자가 구분하기 어려운 값 5개 이상을 만든다. 세 관여 단계로 접는다.
- **Focused/Unfocused 두 값만 둔다.** 단순하지만 초안이 남아 있거나 추천·IME·전송 중인데 포커스를 잃은 Composer가 다시 흐려져 입력 작업의 존재를 숨긴다. Active를 별도로 둔다.
- **브라우저 `localStorage`가 소유한다.** 기기별 취향에는 맞지만 PC Settings에서 편집할 수 없고 Direct/Android client가 서로 다른 값을 갖는다. 기존 Remote display 설정의 PC 소유 원칙과 어긋난다.
- **배경색 alpha만 바꾼다.** 텍스트는 항상 선명하지만 불투명 textarea 아래에는 terminal cell이 배치되지 않아 요구한 Composer 전체의 단계적 존재감 변화가 작다. surface 전체 opacity를 사용한다.
- **값을 독립적으로 허용한다.** 유연하지만 Idle이 Active보다 진해지는 등 상태 이름과 반대되는 결과를 허용한다. 단조 증가 불변식을 유지한다.

## Consequences

- Composer는 비활성일 때 물러나고 포커스·실제 입력 활동에 따라 55%→80%→100%로 선명해진다. 사용자는 세 값을 20~100 범위에서 조정할 수 있다.
- `settings.json`과 display-settings GET/PUT body에 필드 세 개가 추가된다. 내부 개발 단계이므로 필드가 없는 기존 파일은 serde 기본값을 사용하고 별도 마이그레이션은 없다.
- 모든 상태 변경 경로가 단일 appearance 갱신을 호출해야 한다. focus/blur, input, suggestion open/close, IME start/end, submission start/end, terminal/lease 전환을 테스트한다.
- 전체 surface opacity이므로 낮은 값에서는 placeholder·divider도 함께 흐려진다. 20% 하한과 Active 100% 기본값이 조작성·가독성 하한을 보장한다.
- 검증은 Rust 기본값·범위·단조 불변식·projection/lease 테스트, PC Settings 저장 테스트, Remote Playwright의 조회·저장·즉시 적용과 Idle/Focused/Active 상태 전환, 생성 bundle drift 검사를 포함한다.
