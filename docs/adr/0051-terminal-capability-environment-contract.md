# 0051. PTY 자식은 laymux 터미널 정체성과 truecolor capability를 받는다

- Status: Accepted
- Date: 2026-07-24
- Source: 사용자 요구와 Windows Terminal/Codex 동작 비교; [architecture/data-flow.md §8.1–8.3](../architecture/data-flow.md); [architecture/api-contracts.md §10 Windows Terminal 호환 항목](../architecture/api-contracts.md); [ADR-0001](0001-osc-rust-single-pass.md); [OpenAI Codex #26181](https://github.com/openai/codex/commit/713192381b74f09f4b92f3ed410da067461d5cd0); [Windows Terminal #17729](https://github.com/microsoft/terminal/commit/3b4ee83ed1edd9fada5750155fce988d082a2821); [Windows Terminal `ConptyConnection.cpp`](https://github.com/microsoft/terminal/blob/4f225a56aff245bbb9d1400f266c20e1747cc580/src/cascadia/TerminalConnection/ConptyConnection.cpp#L55-L101)
- Relation: [ADR-0001](0001-osc-rust-single-pass.md)의 Rust 단일 패스 범위를 laymux가 의미를 부여하는 OSC 훅·액션으로 명확히 하고, 터미널 에뮬레이터 자체의 프로토콜 응답은 그 범위와 구분한다.

## Context

laymux는 xterm.js를 렌더러로 사용하므로 24-bit SGR 색상과 xterm 동적 색상 조회를
처리할 수 있다. 그러나 PTY 자식에는 내부 `TerminalConfig.env`와 PTY 생성 시 조립하는
`LX_*` 세션·IDE 식별자만 명시적으로 주입하고, laymux 자체의 터미널 정체성이나 색상
capability는 광고하지 않는다. `Profile` 설정 모델에는 사용자 환경 변수 필드가 없다.
부모 프로세스의 환경은 기본값으로 상속되므로 laymux를 다른 터미널에서 실행하면
`WT_SESSION` 같은 바깥 터미널 식별자가 반대로 남을 수도 있다.

Codex 0.138.0 이후 Windows TUI는 시작 시 기존 xterm 계약인 OSC 10/11로 기본 전경·배경을
조회하고, 별도의 stdout 색상 capability가 truecolor 또는 256색일 때만 계산한 RGB 배경을
출력한다. Windows Terminal은 `WT_SESSION`을 자식에 주입하므로 Codex가 truecolor로
승격하지만, 현재 laymux 자식은 Windows에서 ANSI16으로 판정되어 같은 배경색을 알아도
RGB 스타일을 reset한다. laymux 셸에서 `COLORTERM=truecolor`를 설정한 뒤 Codex를 다시
실행하면 컴포저 배경이 즉시 정상화됨을 확인했다.

OSC 10/11은 팔레트 값 조회이고 24-bit SGR 출력 지원 선언은 아니다. 따라서 OSC 응답만으로
truecolor를 추론하게 하거나 특정 애플리케이션에 laymux 예외를 추가하는 대신, 실제 렌더러
능력을 아는 PTY 호스트가 자식 생성 경계에서 일반 capability 계약을 제공해야 한다.

결정 범위는 Windows·Linux·WSL 프로필의 PTY 자식 환경, laymux 정체성, 색상 capability와
상위 Windows Terminal 식별자의 제거다. `TERM`/terminfo 전략 변경, OSC 10/11 응답 경로
재설계, Codex 전용 처리, 사용자별 색상 정책 설정은 비목표다.

## Decision

**Rust PTY 생성 계층이 laymux의 정체성과 실제 렌더러 capability를 하나의 정본 환경 변경 계획(`Set`/`Unset`)으로 정의하고 각 PTY 대상 환경에 적용한다.**

- laymux 소유 예약 변수는 `TERM_PROGRAM=laymux`,
  `TERM_PROGRAM_VERSION=<빌드 패키지 버전>`, `COLORTERM=truecolor`다. 버전은 하드코딩하지
  않고 애플리케이션 빌드 메타데이터를 사용한다. xterm.js의 24-bit 렌더링 지원이 이
  선언의 근거이며, 렌더러 capability가 달라지면 광고 값도 함께 바뀌어야 한다.
- 환경 변경 계획은 값을 설정하는 `Set`과 키를 제거하는 `Unset`으로 구성하며, 부모 환경
  전체를 materialize하거나 플랫폼 사이에 복제하지 않는다. `Set`은 내부
  `TerminalConfig.env`, PTY 생성 시 추가하는 `LX_*`, laymux 예약 변수 순서로 조립한다.
  예약 변수는 앞선 명시적 세션 환경과 부모 환경보다 우선하며, 충돌 판단은 ASCII
  대소문자를 구분하지 않고 예약 키를 대문자 정본으로 만든다. 이 계약은 `settings.json`
  토글이 아니다.
- 부모가 Windows Terminal이어도 새 PTY의 렌더러는 laymux다. 따라서 `Unset`에는
  `WT_SESSION`, `WT_PROFILE_ID`를 넣고 `Unset`이 모든 `Set`·상속값보다 우선하게 한다.
  `TERM_PROGRAM`과 `TERM_PROGRAM_VERSION`은 상속값을 laymux 값으로 대체한다. 알려진 상위
  터미널 식별자를 추가로 지원할 때도 같은 소유권 원칙을 적용한다.
- `TERM`은 전역으로 새로 설정하거나 덮어쓰지 않는다. native Windows 프로그램의 분기와
  Linux/WSL terminfo 선택을 바꿀 수 있으므로 별도 호환성 결정 전까지 현재 셸·프로필 값을
  보존한다. 사용자 색상 정책인 `NO_COLOR`, `FORCE_COLOR`도 제거하거나 덮어쓰지 않는다.
- native adapter는 부모가 제공한 대상 환경을 그대로 두고 `CommandBuilder::env`와
  `env_remove`로 계획에 포함된 키만 설정·제거한다.
- WSL adapter는 Windows 부모 환경 전체를 Linux로 export하지 않는다. 생성된 init에서
  명시적 세션·IDE `Set`을 제공하고, 사용자 `.bashrc`를 읽은 뒤 laymux 예약 `Set`과 모든
  `Unset`을 다시 적용해 대화형 셸 진입 시 계약을 보장한다. Windows Terminal이 상속한
  `WSLENV`에 제거 대상 키와 플래그가 들어 있으면 그 항목만 제거하고 나머지 `WSLENV`는
  보존한다. 따라서 Windows `PATH`, 사용자 정보, 자격 증명성 환경을 WSL로 추가 복제하지
  않고 WSL 자체의 초기 환경도 덮어쓰지 않는다.
- native와 WSL이 공유하는 정본은 완성된 환경 map이 아니라 같은 `Set`/`Unset` 계획이다.
  `TERM`, `NO_COLOR`, `FORCE_COLOR` 등 계획 밖의 값은 각 대상 환경의 기존 값을 보존한다.
- ADR-0001의 Rust 단일 패스는 PTY 출력에서 laymux가 의미를 부여하는 OSC 파싱·훅 매칭·액션
  디스패치에 적용된다. OSC 10/11 등 터미널 에뮬레이션 질의의 파싱·응답 생성은 xterm.js
  core가 담당하고, 생성된 응답 바이트는 기존 `terminal.onData`→PTY 입력 경로를 사용한다.
  이는 프론트에서 laymux 훅을 재구현하는 것이 아니며, 이번 결정은 응답을 Rust로 옮기거나
  Codex를 특별 취급하지 않는다.

## Alternatives Considered

- **사용자가 셸 startup command나 `.bashrc`에 `COLORTERM=truecolor`를 설정:** 즉시 증상을
  해결하지만 실제 터미널 capability를 사용자 구성 책임으로 넘긴다. 새 셸·WSL 배포판·복원
  세션마다 빠질 수 있고, 잘못된 값도 허용하므로 기각했다.
- **`WT_SESSION`을 laymux에서도 주입:** Codex의 Windows Terminal 예외를 재사용할 수
  있지만 자식 애플리케이션에 잘못된 터미널 정체성과 세션 의미를 전달한다. 특정 앱을 위한
  사칭 계약이므로 기각했다.
- **`COLORTERM`만 주입:** 현재 시각 차이는 고치지만 `TERM_PROGRAM`이 비어 있거나 부모
  터미널을 가리키는 문제와 stale `WT_SESSION`을 남긴다. capability와 정체성을 같은 생성
  경계에서 소유하는 쪽을 택했다.
- **OSC 10/11 응답을 truecolor 증거로 사용:** 동적 기본색 보고와 24-bit SGR 입력 지원은
  서로 독립된 capability다. 한 계약을 다른 계약의 증거로 삼으면 제한된 터미널에서
  과대 광고할 수 있어 기각했다.
- **모든 플랫폼에 `TERM=xterm-direct` 또는 `xterm-256color` 강제:** terminfo 설치 여부와
  native Windows 라이브러리 분기를 바꾸며, truecolor와 256색 중 어느 계약을 보장할지도
  달라진다. 현재 문제에 필요하지 않아 별도 결정으로 남긴다.

## Consequences

- `NO_COLOR`·`FORCE_COLOR` 같은 사용자 색상 정책 override가 없는 경우, Codex와
  `COLORTERM` 등 해당 capability 신호를 해석하는 CLI는 laymux에서 truecolor 경로를 선택할
  근거를 받는다. 각 CLI의 탐지 우선순위와 사용자 override는 그대로 존중하며, 기존 ANSI16
  폴백 대신 RGB 색상을 출력하는 경우 이는 xterm.js의 실제 능력과 일치하는 의도된 외부
  동작 변화다.
- laymux가 Windows Terminal에서 시작돼도 그 안의 자식은 자신을 Windows Terminal 세션으로
  오인하지 않는다. 반대로 바깥 터미널 세션 정보를 의도적으로 사용하던 비표준 스크립트는
  더 이상 `WT_SESSION`/`WT_PROFILE_ID`를 볼 수 없다.
- 기존 실행 중 PTY의 환경은 바뀌지 않는다. 구현 배포 후 새로 생성하거나 재시작한 PTY부터
  적용되며 settings 마이그레이션은 필요 없다.
- 완성된 Windows 환경을 WSL에 복제하지 않으므로 Windows `PATH`나 우연히 상속된 비밀값이
  이 기능 때문에 새로 Linux 환경에 노출되지 않는다. `WSLENV` 정리도 제거 대상 항목에만
  한정해 기존 사용자 interop 계약을 보존한다.
- 구현 PR은 환경 변경 계획을 순수 함수로 분리해 예약 변수 우선순위, 예약 키의 대소문자
  충돌, 부모 `WT_*` 제거, `TERM`/`NO_COLOR`/`FORCE_COLOR` 보존을 단위 테스트한다. native
  Windows 자식 probe는 부모에 `WT_*`가 있는 상태를, WSL init 단위 테스트와 실제 WSL 자식
  probe는 `WT_*`와 해당 항목이 든 `WSLENV`가 있는 상태를 검증한다. 두 경로 모두 예약
  `Set`이 정확히 보이고 제거 대상은 보이지 않아야 하며, WSL의 `PATH`와 관련 없는
  `WSLENV` 항목은 보존돼야 한다. Codex 실행 자체는 외부 버전에 종속되므로 핵심 자동화
  테스트의 정본으로 삼지 않고 수동 호환 확인에 둔다.
- 구현과 함께 living doc의 TerminalView 환경 주입·Windows Terminal 호환 섹션을 갱신한다.
  OSC 10/11 왕복 지연이나 원격 제어 ownership과 terminal-generated 응답의 관계는 별도
  계측·결정 대상이며 이 ADR이 해결됐다고 간주하지 않는다.
- xterm.js가 아닌 렌더러를 도입하거나 surface별 색상 능력이 달라지거나, Windows/Linux의
  `TERM` 계약을 통일해야 할 때 이 결정을 재검토한다.
