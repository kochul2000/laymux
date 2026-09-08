# 0242. 설정 MCP의 범위별 설명과 Remote 기기 적용 확인

- Status: Accepted
- Date: 2026-09-08
- Source: 사용자 요구(PC·Remote 설정을 Claude·Codex·Grok으로 조작하고 dev에서 검증, 실행 맥락 판정·플로팅·누락 설정 전수 대조·검증 3배 확대) · [ADR-0032](0032-llm-settings-introspection-and-safe-mutation.md) · [ADR-0209](0209-remote-display-preferences-are-device-local.md) · [ADR-0237](0237-remote-floating-input-controls.md) · [architecture/api-contracts.md §12.7·§13](../architecture/api-contracts.md)
- Extends: ADR-0032, ADR-0209

## Context

전체 조회가 빈 객체를 반환하고, 한 필드의 설명에도 전체 설정 스키마가 포함된다. 에이전트는 허용값과 실제 적용 시점을 찾아내기 어렵다. PC 터미널·비터미널 본문·메뉴·Remote 폰트는 적용 대상이 다르다.

Remote 표시 선호는 기기 localStorage가 소유한다. 호스트 에이전트가 이를 조작하려면 연결된 기기와 통신하고 실제 저장·적용 여부를 확인해야 한다. 임의 JavaScript 실행, 입력 초안·인증정보 조회, 오프라인 기기 관리는 비목표다.

## Decision

**PC는 기존 snapshot/apply 경로를 유지하고, Remote는 현재 controller 기기의 로컬 저장·적용 응답으로 성공을 판정한다.**

- PC 전체 조회는 마스킹한 현재 설정을 반환한다. 설명은 요청한 JSON Pointer의 독립적인 스키마·기본값·의미·허용값·쓰기 권한·적용 시점을 제공한다. 경로 생략 시 섹션 목록과 조작 절차를 제공한다.
- PC 객체 병합·배열 전체 교체·엄격 검증·민감값 마스킹·revision CAS는 유지한다. 프로필 상속·pane override와 메뉴/본문 폰트의 차이처럼 효과를 제한하는 조건을 설명한다.
- Remote 도구는 PC 설정과 별개로 명명한다. 대상은 현재 controller 기기 하나이며 lease와 문서 인스턴스를 고정한다. snapshot과 요청은 메모리에만 보관하고 PC settings.json에 저장하지 않는다.
- 인증된 heartbeat로 허용된 기기 환경설정의 snapshot·대기 요청·적용 응답만 교환한다. 일반 settings, token, 입력 내용과 임의 저장 키는 전달하지 않는다. Direct와 Android E2E가 같은 계약을 사용한다.
- 호스트와 기기 양쪽에서 revision을 비교하고 알 수 없는 키·범위·타입 오류를 거부한다. 기존 UI 적용 함수를 재사용한다. 저장 실패·충돌·연결 종료·기한 초과는 성공으로 보고하지 않으며 만료된 요청은 기기에서도 적용하지 않는다.
- 미연결 또는 bridge 미지원 기기는 원인을 설명하고 다른 기기나 PC 설정으로 대체하지 않는다.
- 대상이 생략된 요청은 `get_settings_context`가 현재 human-control owner에서 도출한 기본 범위를 따른다. Local은 PC, 유효한 Remote lease는 기기 로컬이다. 전환 중·만료 lease는 미확정이며 PC로 대체하지 않는다. 에이전트 프로세스의 OS·localhost 접속은 사용자 표면의 근거가 아니다. 현재 제어 표면이지 개별 채팅 출처의 증명은 아니므로 명시적인 사용자 대상이 우선한다. 자동 작업·다른 채팅처럼 출처가 다를 때는 확인한다.
- 기기 로컬 표시·입력과 PC의 Remote 연결·보안 정책은 두 계약이다. Remote에서 요청해도 연결 정책은 PC `/remote`로 변경한다. 변경 직전 맥락을 재조회하고 대상 전환 시 재판정한다.
- 플로팅 전체 표시 스위치는 기존 `laymux.remote.keybar.floating`에 둔다. 끄면 개별 패드·버튼의 위치·크기·활성 구성을 보존하고 표시만 숨긴다. MCP는 전체 표시와 두 패드의 활성·크기·불투명도를 조작하며 기존 저장·렌더 경로를 재사용한다.
- 사용자 추가 요구에 따른 전수 대조 범위로 패드 위치·일반 플로팅 버튼 목록·입력바 배치·사용자 등록 특수키·에이전트별 숨김 줄 수·탐색 제외도 같은 기기 소유 계약으로 제공한다. 객체·배열은 해당 최상위 키 전체 교체다. 사용자 특수키의 설정된 전송 문자열은 입력 초안·과거 입력 기록과 구별하며 저장만으로 실행하지 않는다. 내장 액션 목록을 설명하고 양쪽에서 키 참조·중복·범위를 검사한다. 탐색 제외는 기기에서 현재 workspace/pane 관계를 검증한 뒤 저장한다.
- PC의 자유 JSON인 CWD 동기화 구조를 설명하고, 위젯 세부 옵션은 frontend의 실제 레지스트리로 안내한다. 새 영속 소유자나 임의 코드 실행 경로를 만들지 않는다.

## Alternatives Considered

- **프롬프트만 보강:** 빈 조회·과도한 응답·기기 접근 부재를 해결하지 못한다.
- **PC 전역 Remote 표시값 복원:** 기기별 독립성을 보존하는 ADR-0209와 충돌한다.
- **모든 기기 등록과 전용 연결:** 오프라인 큐·식별·정리 수명주기가 필요하다. 현재 controller와 heartbeat로 요구를 충족한다.
- **응답 전 성공 반환:** 연결 종료나 저장 실패에도 성공으로 오인한다.

## Consequences

에이전트는 작은 설명을 단계적으로 읽고 검증한 값만 저장할 수 있다. Remote 변경은 현재 controller에 한정되며 heartbeat 왕복 시간이 필요하다. 백그라운드·연결 종료 시 최신 값을 읽고 재시도해야 한다.

PC 계약, Remote 충돌·만료·격리·저장 실패, dev MCP와 실제 세 CLI의 자연어 조작을 검증한다. 여러 비제어 기기 또는 오프라인 변경이 필요해지면 별도 기기 수명주기 설계를 검토한다.
