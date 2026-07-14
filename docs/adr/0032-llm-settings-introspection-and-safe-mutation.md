# 0032. LLM 설정 계약 — 자기설명·엄격 검증·민감값 보호

- Status: Accepted
- Date: 2026-07-14
- Source: 사용자 요구(LLM이 laymux 설정을 의미에 맞게 읽고 검증한 뒤 수정) · ADR-0004 · ADR-0006 · ADR-0014 · ADR-0017

## Context

ADR-0014는 MCP에 `get_settings`와 `update_settings`를 추가하고 frontend bridge를 통해 `settings.json`과 런타임 store를 함께 갱신하기로 결정했다. 그러나 값만 읽고 부분 JSON을 쓰는 계약만으로는 LLM이 각 필드의 의미, 허용값, 적용 시점, 민감 여부를 알 수 없다. 특히 범용 JSON 입력은 오타 키가 조용히 무시되거나, 복구용 `validate_and_repair`가 잘못된 쓰기 요청을 다른 값으로 자동 수정해 사용자의 의도와 다른 설정을 적용할 수 있다.

설정에는 일반 환경설정뿐 아니라 workspace/layout/dock의 구조적 세션 상태와 `remote.authToken` 같은 민감값도 함께 들어 있다. 구조 상태는 이미 전용 MCP 도구가 수명주기와 참조 무결성을 관리하며, 민감값을 일반 조회·diff 응답에 그대로 포함하면 모델 컨텍스트와 로그로 불필요하게 확산된다. 또한 frontend 설정은 settings/workspace/dock 여러 Zustand store에 나뉘어 있어, MCP가 디스크만 직접 수정하면 현재 런타임과 `settings.json`이 갈라진다.

## Decision

ADR-0014의 읽기·쓰기 경로를 다음 자기설명·검증 계약으로 확장한다.

- release와 dev MCP에 `get_settings`, `describe_settings`, `validate_settings`, `update_settings`를 노출한다. Direct Remote 브라우저 API에는 노출하지 않는다.
- `get_settings`는 현재 frontend store에서 합성한 설정과 revision을 반환한다. 선택적 JSON Pointer 경로 필터를 지원한다. revision은 일반 patch가 쓸 수 있는 구성만 반영하고 구조 키와 cloud pairing 소유 필드는 제외해 CWD·pane 수명주기 같은 비설정 변화가 낙관적 동시성 검사를 깨지 않게 한다.
- `describe_settings`는 Rust `Settings` 타입에서 생성한 JSON Schema, 기본값, 필드 의미, 쓰기 가능 여부, 민감 여부, 런타임 적용 시점(`live`/`nextUse`/`restart`)을 반환한다.
- `validate_settings`는 현재 설정에 부분 JSON을 deep-merge하되 저장하거나 store를 변경하지 않고, 오류·diff·적용 시점·후보 revision을 반환한다. 객체는 재귀 병합하고 배열은 전체 교체한다.
- `update_settings`는 `validate_settings`와 같은 엔진을 사용하고 선택적 `expectedRevision`이 현재 revision과 다르면 충돌로 거부한다. 검증된 후보만 frontend bridge를 통해 저장하고 런타임 store에 적용한다.
- 설정 쓰기는 `AppState`의 공용 비동기 락 안에서 현재 snapshot 조회부터 적용까지 직렬화한다. frontend도 저장 직전과 직후 store가 기대 snapshot과 같은지 검사하고, 저장 중 사용자 설정 편집이 발생하면 최신 store를 디스크에 복원한 뒤 충돌로 거부한다. 따라서 MCP 세션끼리뿐 아니라 Settings UI와의 경쟁에서도 조용한 덮어쓰기를 막는다.
- 디스크 로드 복구와 쓰기 검증을 분리한다. `validate_and_repair`는 손상된 기존 파일의 복구에 사용하고, MCP/Automation 쓰기는 알 수 없는 키·타입 오류·허용값 위반·교차 참조 오류를 적용 전에 거부한다. 요청값을 다른 의미의 값으로 조용히 보정하지 않는다.
- 내부 개발 중 과거 설정에 이미 남아 있는 의미 위반은 무관한 patch를 막지 않는다. 후보에서도 값과 오류가 그대로인 위반은 `existingIssues`로 보고하고, patch가 새로 만들거나 해당 값을 다른 잘못된 값으로 바꾼 위반만 `errors`로 거부한다. 기존 위반을 수정한 경우에는 후보 응답에서 사라진다.
- `remote.authToken`은 쓰기 가능하지만 모든 조회·검증·diff·업데이트 응답에서 `***REDACTED***`로 마스킹한다. 이 마스킹 값을 patch로 다시 보내면 기존 원문을 유지하며, 새 문자열이나 빈 문자열을 명시해야만 교체·삭제한다. cloud pairing이 소유하는 `remote.cloudInstanceId`, `remote.cloudTunnelUrl`, `remote.cloudServerBaseUrl`은 일반 설정 patch에서 읽기 전용이다.
- 구조적 세션 키 `workspaces`, `layouts`, `docks`, `workspaceDisplayOrder`는 일반 설정 patch에서 읽기 전용이다. 변경은 기존 workspace/grid/dock 전용 MCP 도구를 사용한다.
- frontend의 설정 수집·적용·영속 로직을 재사용 가능한 단일 경로로 추출한다. 기존 좁은 REST/MCP 설정 세터도 이 경로를 호출해 store와 디스크를 함께 갱신한다.

## Consequences

- LLM은 설정값뿐 아니라 의미와 제약을 필요할 때 조회하고, dry-run 결과를 확인한 뒤 동일 계약으로 적용할 수 있다.
- 알 수 없는 키와 잘못된 값이 조용히 유실되거나 자동 복구되어 의도와 다른 설정이 저장되는 경로가 사라진다.
- 설정 응답은 민감값을 확인할 수 없으므로 token이 설정됐는지는 마스킹 상태로만 판단한다. 호출자가 기존 token 원문을 회수하는 용도로 MCP를 사용할 수 없다.
- 구조 상태를 범용 배열 patch로 바꿀 수 없으므로 LLM은 전용 도구를 여러 번 호출해야 할 수 있지만, PTY·pane·dock 수명주기와 참조 무결성이 유지된다.
- JSON Schema와 기본값은 Rust 모델에서 생성하고, 적용 시점·민감·쓰기 권한 같은 런타임 메타데이터만 별도 카탈로그로 관리한다. 설정 필드 추가 시 모델·메타데이터·테스트를 함께 갱신해야 한다.
- frontend 창이 살아 있어야 현재 store 스냅샷을 읽고 적용할 수 있다는 ADR-0014의 제약은 유지된다.
