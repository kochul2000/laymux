# 0052. Truecolor capability 광고는 기본 활성화된 전역 터미널 설정으로 제어한다

- Status: Accepted
- Date: 2026-07-24
- Source: 사용자의 성능 opt-out 요구; [ADR-0051](0051-terminal-capability-environment-contract.md); [architecture/data-flow.md §8.1–8.3](../architecture/data-flow.md); [architecture/api-contracts.md §10](../architecture/api-contracts.md)
- Supersedes: [ADR-0051](0051-terminal-capability-environment-contract.md) 전체. PTY 환경 변경 계획과 터미널 정체성·OSC 책임 경계는 유지하고, `COLORTERM=truecolor`의 무조건 주입과 설정 비노출 결정을 전역 opt-out 계약으로 대체한다.

## Context

ADR-0051은 xterm.js 렌더러의 실제 24-bit 색상 능력을 모든 PTY 자식에
`COLORTERM=truecolor`로 항상 광고하도록 결정했다. 이는 Codex를 비롯한 CLI가 laymux에서
불필요하게 ANSI16 경로를 선택하는 문제를 기본 상태에서 해결한다.

그러나 truecolor를 선택한 애플리케이션은 더 많은 SGR 전환과 RGB 데이터를 출력할 수 있다.
출력량·렌더링 비용 차이는 애플리케이션과 작업 부하에 따라 달라 성능 향상을 보장할 수
없지만, 호환성 문제를 진단하거나 더 제한적인 색상 출력을 원하는 사용자가 광고를 끌 수
있는 명시적 opt-out이 필요하다. 이 선택은 특정 프로필의 렌더러 능력이 아니라 laymux 전체가
자식 프로세스에 알릴 capability 정책이다.

결정 범위는 전역 Settings 계약, Settings UI, 새 PTY에 snapshot되는 정책, native·WSL의
`COLORTERM` 처리다. xterm.js 렌더러 자체의 24-bit 지원을 비활성화하거나 실행 중 PTY 환경을
변경하는 기능, 프로필별 override, `TERM`/terminfo 정책, Codex 전용 처리는 비목표다.

## Decision

**`terminal.advertiseTrueColor` 전역 Boolean 설정이 PTY 자식의 `COLORTERM` 광고를 소유하며 기본값은 `true`다.**

- Rust `settings.json`과 프론트엔드 settings store의 정본 키는
  `terminal.advertiseTrueColor`다. 필드가 없는 기존 설정은 `true`로 역직렬화하며 Settings
  UI의 Terminal 섹션에서 읽고 저장할 수 있다.
- 터미널 세션 생성 시 현재 설정값을 `TerminalConfig`에 snapshot한다. 설정 변경은 이미
  실행 중인 프로세스 환경을 바꾸지 않으며, 저장 이후 새로 생성하거나 재시작한 PTY부터
  적용한다.
- 값이 `true`면 환경 변경 계획의 `Set`에 `COLORTERM=truecolor`를 넣는다. 값이 `false`면
  `COLORTERM`을 `Unset`에 넣어 명시적 세션 환경과 부모 환경의 상속값도 제거한다. opt-out이
  실행 출처에 따라 무효화되지 않아야 한다.
- `TERM_PROGRAM=laymux`와 `TERM_PROGRAM_VERSION=<빌드 패키지 버전>`은 설정과 무관하게
  항상 `Set`한다. `WT_SESSION`과 `WT_PROFILE_ID`도 항상 `Unset`한다. truecolor 광고 선택이
  터미널 정체성 소유권을 바꾸지 않는다.
- 환경 계획은 ADR-0051과 같이 부모 환경 전체가 아닌 `Set`/`Unset` mutation으로 유지한다.
  native adapter는 `CommandBuilder::env`/`env_remove`를 사용하고, WSL adapter는 같은 mutation만
  init에 `export`/`unset`하며 제거 대상이 든 `WSLENV` 항목만 선택적으로 정리한다.
- `TERM`, `NO_COLOR`, `FORCE_COLOR`와 대상 환경의 나머지 값은 설정과 무관하게 보존한다.
  애플리케이션별 탐지 우선순위와 사용자 색상 override는 계속 존중한다.
- ADR-0051이 명확히 한 OSC 책임 경계를 유지한다. laymux semantic OSC 훅·액션은 Rust 단일
  패스가 담당하고, OSC 10/11 같은 터미널 에뮬레이터 질의 응답은 xterm.js core와 기존 PTY
  입력 경로가 담당한다.

## Alternatives Considered

- **ADR-0051처럼 항상 truecolor 광고:** 가장 단순하고 기본 UX는 좋지만 사용자가 호환성·성능
  실험을 위해 제한된 색상 출력을 선택할 수 없어 기각했다.
- **기본값을 `false`로 변경:** 기존 laymux와 Codex의 시각 차이를 그대로 남기고 렌더러의
  실제 능력을 기본적으로 숨기므로 기각했다.
- **프로필별 설정:** 셸마다 다른 값을 줄 수 있지만 같은 xterm.js surface capability에
  중복 정책을 만들고 복원·viewer 세션의 해석을 복잡하게 하므로 전역 설정을 택했다.
- **설정 변경을 실행 중 PTY에 즉시 반영:** 이미 생성된 프로세스 환경은 안전하게 바꿀 수
  없고 자식 프로세스별 상태도 달라진다. 새 PTY 경계에서만 snapshot하기로 했다.
- **끄면 `COLORTERM`을 주입하지 않기만 함:** Windows Terminal 등 부모가 설정한 값이 남아
  opt-out이 무효화될 수 있으므로 명시적 `Unset`을 선택했다.

## Consequences

- 기본 설정에서는 ADR-0051이 의도한 truecolor UX가 그대로 활성화된다. 사용자는 Settings의
  Terminal 섹션에서 광고를 끄고 새 PTY를 열어 애플리케이션별 출력량·호환성 차이를 비교할
  수 있으나, 성능 향상은 보장된 결과가 아니다.
- `settings.json` 스키마와 Rust/TypeScript 모델에 필드가 추가된다. 내부 개발 단계 정책에
  따라 별도 마이그레이션은 만들지 않고 serde와 프론트엔드 기본 병합으로 누락 필드를
  `true`로 처리한다.
- 구현은 기본값·누락 필드·UI 저장 round-trip, 세션 snapshot, true/false 환경 계획, 예약 키
  대소문자 충돌, native child와 실제 WSL child를 검증한다. false 경로에서는 부모나 명시적
  환경에 있던 `COLORTERM`도 자식에 없어야 한다.
- living doc에는 Settings 키, 새 PTY 적용 시점, native·WSL mutation과 OSC 책임 경계를
  동기화한다.
- 렌더러별 capability가 달라지거나 실제 계측에서 더 세분화된 정책이 필요해지면 전역
  Boolean과 프로필별·자동 감지 대안을 다시 검토한다.
