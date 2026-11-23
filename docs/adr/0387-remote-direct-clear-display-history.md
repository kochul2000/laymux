# 0387. Remote 직접 입력의 clear가 마지막 입력 표시를 초기화한다

- Status: Accepted
- Date: 2026-11-20
- Source: 사용자 요구(Remote에서 Codex에 직접 `/clear`를 보내면 이전 워크스페이스 메시지가 남음), [ADR-0373](0373-submitted-shell-input-and-clear-history.md)

## Context

Remote Direct 키 입력은 데스크톱의 xterm 입력 조립기를 거치지 않고 호스트의 PTY 쓰기로 들어간다. Codex가 `/clear`를 실행해도 셸 명령 본문이나 일반 사용자 턴 기록이 남지 않으므로 데스크톱과 Remote의 워크스페이스에 이전 입력이 계속 표시된다.

## Decision

**호스트가 성공한 Remote raw 쓰기에서 명시적인 clear 입력을 관측하면 현재 PTY의 공통 표시 이력을 초기화한다.**

- PTY 쓰기 워커는 PC와 Remote가 쓴 바이트를 실제 쓰기 순서로 조립한다. 붙여넣기 안의 개행과 작성기의 Ctrl+J는 제출로 세지 않고, 붙여넣기 밖의 Enter에서 명시적인 clear를 판정한다. 세션 재연결 직후나 해석할 수 없는 편집 뒤에는 확인된 입력 경계까지 판정을 보류한다.
- 데스크톱 표시 소유자에게 PTY 세대, 입력 시각, 초안 초기화 여부만 전달한다. Remote에서 입력한 본문은 이 이벤트에 포함하지 않는다.
- 표시 소유자는 현재 세대와 더 최근의 표시를 보호하며 ADR-0373의 삭제 경계를 사용한다. 서버는 기존 Remote lease와 PTY 쓰기 성공 여부를 사용한다.

## Alternatives Considered

- Codex 세션 변경으로 추론하면 `/resume`과 같은 대화 전환도 삭제로 해석하게 된다.
- 키 전체를 데스크톱으로 전달하면 표시 초기화에 필요한 정보보다 많은 원격 입력이 WebView에 노출된다.

## Consequences

직접 입력한 clear가 성공하면 데스크톱과 Remote가 같은 표시를 읽는다. 지원 범위는 원격 키로 조립 가능한 명시적 clear다. 에이전트의 자동완성으로 완성된 명령이나 확인할 수 없는 편집 조합은 추가 관측이 필요하다.
