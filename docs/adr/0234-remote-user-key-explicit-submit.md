# 0234. Remote 사용자 키는 Enter 제출 의도를 별도로 저장한다

- Status: Accepted
- Date: 2026-09-06
- Source: 사용자 요구(raw sequence의 줄바꿈과 Send Enter 체크박스 분리); [api-contracts §13.4](../architecture/api-contracts.md); [ADR-0213](0213-remote-input-action-segment-placement-and-user-keys.md); [ADR-0034](0034-single-send-terminal-composer.md)
- Amends: ADR-0213의 모든 사용자 키를 raw write로 전송한다는 결정

## Context

raw sequence의 LF/CR은 입력 바이트다. 본문과 함께 쓰인 CR은 셸이나 TUI가 붙여넣기 줄바꿈으로 처리할 수 있어 Send의 제출 의미와 같지 않다. 기존 structured input은 백엔드가 붙여넣기 모드와 본문·Enter 간격을 처리한다. 기기 OS 추측이나 클라이언트 지연 타이머를 추가할 필요가 없다.

## Decision

**사용자 키의 `submit` 불리언으로 raw 바이트 전송과 기존 Send 동작을 명시적으로 선택한다.**

- raw 등록 폼에 기본 off인 `Send Enter` 체크박스를 둔다. 체크한 키는 파싱된 sequence를 text로 기존 `/input`의 `submit:true`에 전달한다. 본문의 줄바꿈 정규화·끝 줄바꿈 제거·bracketed paste·별도 Enter 쓰기는 기존 백엔드가 소유한다.
- 체크하지 않은 키와 조합키는 기존 `/write`로 바이트를 그대로 보낸다. 문자열에 CR/LF가 있다고 제출 의도를 추론하지 않는다. 제어 바이트를 그대로 보내려는 사용자는 체크하지 않는다.
- `submit`은 `laymux.remote.keybar.userKeys`에 저장한다. 저장된 값이 정확히 `true`일 때만 제출하며 누락·다른 타입은 false다. 기존 ID·문자열·개수 상한을 유지한다.
- 제출 키는 pending raw 입력을 먼저 flush하고 같은 클라이언트 write chain에 들어간다. queued terminal/lease가 바뀌면 보내지 않는다. 백엔드 owner 검증과 terminal FIFO가 최종 권한·본문/Enter 순서를 보장한다.
- 새 endpoint, OS별 프론트 분기, settings.json 필드나 데이터 마이그레이션은 만들지 않는다.

## Alternatives Considered

- raw 문자열 뒤에 CR 추가: 같은 물리 쓰기로 합쳐져 제출 대신 줄바꿈으로 처리되는 문제를 남긴다.
- 클라이언트에서 raw write 후 지연·Enter 요청: 기존 백엔드 제출 규칙을 중복하고 본문/Enter 사이에 다른 입력이 들어갈 수 있다.
- 모든 raw 키를 structured input으로 전환: 기존 제어 시퀀스의 byte 의미를 바꾼다.

## Consequences

사용자는 escape 표기와 무관하게 제출 여부를 선택한다. 체크 시 sequence는 text로 처리되어 raw 제어 바이트와 다른 의미를 갖는다. 폼에서 이를 안내하고 저장 복원·명시적 true 검증·raw/submit 요청 순서를 브라우저 테스트로 고정한다. OS와 셸의 실제 수신 동작은 기존 structured input 검증 범위에 의존한다. raw 제어 시퀀스와 제출을 하나의 원자 작업으로 혼합해야 한다면 별도 계약을 재검토한다.
