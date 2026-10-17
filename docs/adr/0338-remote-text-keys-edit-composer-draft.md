# 0338. Remote 텍스트 사용자 키는 Composer 초안을 편집한다

- Status: Proposed
- Date: 2026-10-17
- Source: 사용자 요구(명령 단축 입력 뒤 인자를 덧붙인 후 전송); [ADR-0234](0234-remote-user-key-explicit-submit.md); [api-contracts §13.4](../architecture/api-contracts.md)
- Amends: ADR-0234의 `submit:false` 사용자 키가 항상 raw write라는 규칙을 Composer의 일반 텍스트에 한해 정정한다.

## Context

Remote 사용자 키는 Composer 모드에서도 즉시 PTY에 전달된다. 명령을 불러온 뒤 인자를 더 쓰려면 명령과 인자가 서로 다른 편집기에 들어간다. 이미 항목별 `Send Enter`가 제출 의도를 표현하므로 별도 전역 설정 없이 현재 입력 모드와 이 의도를 적용한다. 제어키와 Direct 입력은 바이트 의미를 보존해야 한다.

## Decision

**Composer에서 `submit:false`인 일반 텍스트 사용자 키는 현재 선택 범위를 대체하고, 명시적 제출 키와 제어 시퀀스는 기존 전송 경로를 따른다.**

- 사용자 등록 키 중 C0·DEL·C1 제어 문자가 없는 문자열만 초안에 삽입한다. 내장 Q를 포함한 내장 키와 CR/LF·Tab·Esc·Ctrl 시퀀스는 기존 raw write다. 문자열 안의 CR/LF를 제거해 텍스트로 추측하지 않는다.
- 초안과 첨부 상태의 소유자는 기존 Composer editor다. 같은 editor의 선택 영역 대체와 input 이벤트를 사용해 revision·첨부·자동완성 상태를 갱신하며 커서는 삽입 끝으로 이동한다. 포커스를 강제로 옮기거나 키보드를 열지 않는다.
- lease·활성 terminal·입력 준비가 없거나 pane 이동·IME 조합 중이면 삽입을 거절하고 PTY로 우회하지 않는다. Composer의 전송 중 편집 허용 규칙은 유지한다.
- `submit:true`는 현재 초안과 별도로 기존 structured input을 즉시 제출한다. Direct의 모든 사용자 키는 기존 동작을 유지한다.
- 새 설정·endpoint·저장 스키마·마이그레이션은 추가하지 않는다. 등록 폼에서 Composer 삽입과 `Send Enter`의 차이를 안내한다.

## Alternatives Considered

- 모든 키를 Composer에 삽입: Esc·Ctrl·Enter와 TUI 조작을 깨뜨린다.
- 별도 전역/항목별 목적지 설정: 기존 입력 모드와 제출 의도에 더해 설정 조합을 늘린다. 일반 텍스트 초안 편집 요구에는 불필요하다.
- 명시적 제출 키도 초안에 삽입: 사용자가 켠 `Send Enter`의 의미를 잃는다.

## Consequences

명령 단축 입력 뒤 인자를 붙여 Send할 수 있다. Composer에서 일반 텍스트를 PTY로 즉시 보내던 동작은 바뀌며, 같은 목적은 Direct 또는 `Send Enter`로 명시한다. 브라우저 테스트로 선택 범위·커서·전송 전 요청 부재·초안 보존·Direct·제어키를 검증한다. 텍스트와 제어 시퀀스를 혼합한 매크로까지 편집해야 한다면 목적지 모델을 다시 검토한다.
