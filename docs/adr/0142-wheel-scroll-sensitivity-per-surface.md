# 0142. 휠 스크롤 민감도는 표면별 설정이다

- Status: Accepted
- Date: 2026-08-11
- Source: 사용자 요구("마우스 휠, 리모트에서 스크롤하는 휠 민감도 조절을 settings 에 추가"), architecture/api-contracts.md §Settings, [ADR-0077](0077-remote-terminal-font-serving.md)(원격 appearance 전달 경로)

## Context

데스크톱 터미널과 Remote 브라우저 터미널 모두 xterm 기본 휠 배율(`scrollSensitivity` 1, `fastScrollSensitivity` 5)을 그대로 쓰고 있었고 설정 키가 없었다. 고DPI 마우스·트랙패드·휠 없는 모바일까지 한 값으로 묶여 있어 사용자가 조절할 수단이 없다.

두 표면은 같은 xterm 옵션을 쓰지만 **입력 장치가 서로 다른 기기에 있다**. 데스크톱은 PC 마우스, Remote 는 폰·태블릿·다른 PC 브라우저다. 한쪽에 맞춘 값이 다른 쪽에서 그대로 맞을 이유가 없다.

Remote 페이지는 `include_str!` 로 컴파일된 정적 HTML 이고 host `settings.json` 을 읽는 endpoint 가 없다. 원격 클라이언트가 설정에서 파생된 값을 받는 통로는 현재 terminal 목록 payload 의 per-terminal `appearance`(폰트·커서·테마) 하나뿐이다.

Remote 의 손가락 드래그 스크롤은 성격이 또 다르다. 휠은 xterm 이 처리하지만 드래그는 Remote 페이지가 직접 픽셀을 행으로 환산하며, 기본 동작이 손가락과 화면이 1:1 로 붙는 물리 스크롤이다. 폰 화면에서는 이 1:1 때문에 긴 스크롤백을 넘기는 데 여러 번 쓸어야 한다.

범위: 휠(및 Alt+휠) 배율과 Remote 터치 드래그 배율 설정 추가. 비목표: 프로필별 override, 축(수평 스크롤) 확장, 데스크톱 터치 스크롤(대상 기기가 아니다).

## Decision

**휠 배율은 표면별로 소유한다.** `terminal.scrollSensitivity`/`terminal.fastScrollSensitivity` 는 데스크톱 xterm 만, `remote.scrollSensitivity`/`remote.fastScrollSensitivity` 는 Remote 브라우저 xterm 만 정한다. 한쪽 값이 다른 쪽으로 상속되거나 동기화되지 않는다 — Remote composer recall 설정([ADR-0055](0055-composer-history-scope-setting.md))이 데스크톱과 별개 계약인 것과 같은 경계다.

- **값 의미와 범위.** xterm 옵션 그대로의 배율이며 기본값은 xterm 기본값(1 / 5)이다. 유효 범위는 `0.1..=20`. 상수는 Rust `constants.rs`(`MIN/MAX/DEFAULT_SCROLL_SENSITIVITY`, `DEFAULT_FAST_SCROLL_SENSITIVITY`)와 프론트 `lib/scroll-sensitivity.ts` 각각 한 곳에 둔다.
- **0 이하는 clamp 대상이 아니라 fallback 대상이다.** xterm 은 비양수 sensitivity 에 throw 하므로 `0`·음수·NaN·비수치는 하한으로 끌어올리지 않고 기본값으로 되돌린다. 양수인데 범위를 벗어난 값만 clamp 한다. `validate_settings` 는 범위 밖 값을 `/terminal/scrollSensitivity` 등 경로로 보고하고, 실행 경로는 그와 별개로 항상 정규화한다(parserAdmission 과 같은 "보고 + clamp" 정책).
- **원격 전달은 기존 per-terminal appearance payload 를 탄다.** 새 endpoint 를 만들지 않는다. 값의 출처는 `settings.remote.*` 이지만 클라이언트가 이를 적용하는 지점이 폰트·테마와 동일한 `terminalOptionsForAppearance`/`applyTerminalAppearance` 이기 때문이다. 클라이언트는 필드가 없거나 비정상이면 자기 기본값으로 떨어진다(구버전 데스크톱 호환).
- **적용 시점.** 데스크톱은 live — 저장 즉시 실행 중인 xterm 옵션에 반영하고 레이아웃·fit 을 건드리지 않는다. Remote 는 다음 attach 기준(`nextUse`)이며, appearance 갱신이 도는 시점에 함께 반영된다.
- **터치 드래그는 세 번째 키(`remote.touchScrollSensitivity`, 기본 1)를 따로 갖는다.** 휠 키를 재사용하지 않는다 — 폰에는 휠이 없고 브라우저를 여는 PC 에는 손가락이 없어, 한 값에 묶으면 어느 기기에서든 다른 쪽 몫이 죽은 값이 된다. 기본 1 은 기존 1:1 물리 스크롤을 그대로 유지한다는 뜻이다.
- **터치 배율은 xterm 옵션이 아니다.** Remote 페이지가 소유한 픽셀→행 환산의 입력 델타에 한 번만 곱하고, 하위 셀 나머지(`scrollRemainderPx`)에는 다시 곱하지 않는다. 옵션 번들에 넣지 않는 이유는 xterm 이 모르는 옵션 키를 거부하기 때문이기도 하다.
- **마우스 트래킹 TUI 는 휠 계약을 따른다.** 전체화면 TUI 가 마우스 리포팅을 켜면 드래그는 합성 wheel 이벤트로 앱에 전달되고 그 경로의 배율은 xterm 의 `scrollSensitivity` 다. 같은 제스처가 모드에 따라 다른 키를 따르지만, 두 배율을 겹쳐 곱하는 쪽이 더 예측 불가능하다.

## Alternatives Considered

- **단일 공용 키(`terminal.scrollSensitivity` 를 양쪽에 적용).** 스키마는 가장 단순하지만 PC 마우스에 맞춘 값이 폰/트랙패드에서도 강제된다. 표면별 조절이 이 요구의 핵심이라 기각.
- **Remote 전용 설정 endpoint 신설.** 계약상 더 정직하지만 인증·lease·캐시 경계를 새로 정의해야 하고, 값 하나 때문에 Remote 표면에 두 번째 설정 전달 통로를 만든다. appearance 는 이미 매 attach 마다 최신 설정에서 재해석되므로 실익이 없어 기각.
- **surface-local localStorage(Remote 가 자기 기기에서 직접 조절).** ADR-0132 의 위젯 기기별 토글과 같은 모양이지만, 사용자는 데스크톱 Settings 한 곳에서 관리하기를 요구했다. 기기별 조절이 실제로 필요해지면 localStorage 층을 이 값 위에 덧붙이는 형태로 다시 검토한다.
- **터치 드래그에 휠 배율을 그대로 재사용.** 키가 하나 줄지만, 한 기기에서 두 입력이 같이 쓰이는 경우가 사실상 없어 "폰에서 올린 값이 브라우저 휠까지 흔드는" 부작용만 남는다. 기각.
- **범위를 정수 "줄 수"로 노출.** 직관적이지만 xterm 의 계산은 deltaMode 에 따라 픽셀→행 변환을 거치는 배율이라, 정수 줄 수는 트랙패드의 부드러운 스크롤에서 의미가 깨진다. 배율 그대로 노출하고 0.1 단위로 조절하게 했다.

## Consequences

- 설정 표면이 4개 키 늘어난다. 두 쌍이 이름이 같고 소유 표면만 다르므로, 설명 문구와 문서에서 "데스크톱/원격" 을 항상 명시해야 한다.
- Remote 값은 `appearance` 구조체에 실린다. 이름상 "외형"이 아닌 입력 동작이 한 payload 에 섞이므로, 이후 입력 관련 원격 설정이 더 생기면 payload 를 `appearance`/`input` 으로 쪼개는 리팩터를 검토한다.
- 원격은 per-terminal payload 라 터미널 수만큼 같은 값이 중복 직렬화된다. 숫자 두 개라 비용은 무시할 수준이지만 payload 크기 논의가 생기면 첫 후보다.
- 마이그레이션은 없다(내부 개발 단계 규칙). 기존 settings.json 은 serde/스토어 기본값으로 채워지고 동작이 그대로 유지된다.
- 터치 배율을 1 보다 올리면 손가락과 화면이 의도적으로 어긋난다. 기본값을 1 로 두는 이유이며, 사용자가 명시적으로 올릴 때만 발생한다.
- 같은 드래그가 스크롤백 모드(터치 배율)와 마우스 트래킹 TUI(휠 배율)에서 다른 키를 따른다. 설명 문구로 드러내되, 사용자가 두 값을 크게 다르게 두면 모드 전환 시 체감이 튄다 — 불만이 생기면 TUI 경로에도 터치 배율을 적용하는 쪽으로 재검토한다.
