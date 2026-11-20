# 0386. Windows 터미널의 OSC 52 클립보드 쓰기는 기본으로 허용한다

- Status: Accepted
- Date: 2026-11-20
- Source: 사용자 요청, [ADR-0384](0384-desktop-osc52-clipboard-write.md), [Settings 계약](../architecture/api-contracts.md#터미널-프로그램의-클립보드-쓰기)

## Context

Windows에서 Claude Code 전체 화면의 복사는 OSC 52 쓰기에 의존할 수 있다. 기존 기본값에서는 Claude가 복사를 안내하고도 Laymux 설정을 별도로 켜기 전까지 클립보드에 내용이 들어가지 않았다. 전경의 포커스된 터미널로 권한을 제한해도 프로그램이 실시간 출력으로 클립보드의 텍스트를 덮어쓸 수 있으므로 사용자가 끌 수 있어야 한다.

## Decision

**Windows에서 `terminal.allowOsc52ClipboardWrite`의 기본값은 `true`다. 같은 설정으로 사용자가 끌 수 있다.**

- 새 설정과 키가 없는 설정에는 켬을 적용한다. 저장된 `false`는 이전 버전에서 저장됐더라도 유지한다.
- [ADR-0384](0384-desktop-osc52-clipboard-write.md)의 전경 창, 실제 xterm 입력 포커스, PTY generation과 실시간 출력 제한을 적용한다. 클립보드 읽기 질의를 무시한다.

## Alternatives Considered

- 기본 끔은 전경 프로그램의 클립보드 덮어쓰기를 차단하지만 일반적인 터미널 복사에도 설정 변경을 요구한다.
- 항상 허용하면서 설정을 없애면 전경의 프로그램이나 SSH 세션에 클립보드 쓰기를 허용하고 싶지 않은 사용자가 끌 수 없다.
- 저장된 `false`를 켬으로 바꾸면 이전 기본값과 명시적으로 끈 값을 구별할 수 없으므로 사용자의 선택을 덮어쓸 수 있다.

## Consequences

- 설정을 새로 만들거나 해당 키를 생략한 경우 전체 화면 프로그램에서 바로 복사할 수 있다. 이미 `false`가 저장된 경우 설정 화면에서 켤 수 있다.
- 기본값과 저장된 끔의 우선순위를 Rust의 설정 로딩과 프런트엔드의 설정 로딩에서 검증한다.
