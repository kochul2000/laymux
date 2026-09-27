# 0272. 물리 키 폴백은 사용자가 치는 문자를 가로채지 않는다

- Status: Accepted
- Date: 2026-09-27
- Source: PR #1088 독립 리뷰(Windows AltGr·Mac Option 문자 입력 회귀), [ADR-0269](0269-remote-physical-keyboard-shortcuts.md) §7·§8
- 관계: ADR-0269 §8(키 매칭 보강)을 좁히고 §7의 "설정" 문구를 정정한다. ADR-0269 의 나머지는 유지.

## Context

ADR-0269 §8 은 Ctrl/Alt 조합에서 `e.key` 가 영문·숫자가 아니면 물리 키 `e.code` 로 다시 맞추기로 했다. 그런데 그 조합이 문자를 치는 경우가 있다.

- Windows 는 AltGr 를 Ctrl+Alt 로 보고한다. 독일어 AltGr+7 은 `{` 인데 `workspace.7`(Ctrl+Alt+7)로, 폴란드어 AltGr+L `ł` 은 워크스페이스 클리어로 잡혔다. PC 의 기존 동작을 깨는 회귀다.
- Mac Option 은 배열마다 문자를 친다. 독일어 Option+L 은 `@` 인데 Remote 에서 Alt+L 클리어로 잡혀 `@` 를 칠 수 없었다.

배열 정보 없이는 US 배열의 Option+L `¬` 과 독일어 Option+L `@` 를 구분할 수 없다.

## Decision

**물리 키 폴백은 그 입력이 문자를 치지 않을 때만 쓴다.**

- 쓴다: 아직 문자가 없는 키(`Dead`, `Process` 등), 한글 IME 자모, Ctrl 단독 조합(러시아어 Ctrl+С → Ctrl+C), Apple 플랫폼의 Ctrl 조합(Mac Chrome 은 Ctrl+Option+1 을 `¡` 로 보고하지만 아무것도 입력되지 않는다).
- 안 쓴다: AltGraph 가 눌린 입력, Windows AltGr 로 나온 문자(Ctrl+Alt), Mac Option 이 친 문자(Alt 단독). 이때는 `e.key` 그대로만 맞춘다.
- 그래서 Mac 에서 Option+문자 단축키(예: US 배열 Option+L)는 동작하지 않는다. 필요하면 Ctrl 조합으로 재바인딩한다. AZERTY 의 Ctrl+Alt+숫자도 이전처럼 동작하지 않는다.
- Remote 터미널에 친 Ctrl+영문·숫자 한 글자는 PC 터미널처럼 셸이 받는다(터미널 전용 zoom 제외). 비라틴 배열의 Ctrl+글자(러시아어 Ctrl+И)도 같은 물리 키 기준으로 셸 소유다.
- ADR-0269 §7 정정: 가로채기를 멈추는 표면은 Remote 도구(파일 뷰어·GitHub·메모)가 열렸을 때와, Composer·터미널이 아닌 입력칸에 포커스가 있을 때다. 설정 화면은 입력칸 포커스일 때만 해당한다.

## Alternatives Considered

- **`navigator.keyboard.getLayoutMap()` 으로 배열을 읽는다** — Chromium 계열 보안 컨텍스트에서만 되고, Tailscale http Remote·Safari 에서는 쓸 수 없다. 표면마다 결과가 달라진다.
- **AltGraph 만 제외한다** — Windows AltGr 는 막지만 Mac Option 문자(독일어 `@`)는 여전히 가로챈다.
- **폴백을 없앤다** — 한글 IME 에서 Alt+L·Ctrl+Alt+L 이 안 된다. 문자를 치지 않는 경우는 안전하게 살릴 수 있다.

## Consequences

- 문자 입력이 단축키로 사라지지 않는다. PC 의 AltGr 사용자와 Remote 의 Mac 사용자가 모두 안전하다.
- Mac 의 Option+문자 조합과 AZERTY Ctrl+Alt+숫자는 단축키로 쓸 수 없다. 재바인딩으로 피한다.
- 배열별 회귀 케이스(독일어 `{`, 폴란드어 `ł`, 헝가리어 `|`, 독일어 Mac `@`)를 단위 테스트로 고정한다.
