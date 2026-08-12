# 0148. 선택 경로 링크는 bounded maximal-munch 복수 후보를 사용한다

- Status: Accepted
- Date: 2026-08-12
- Source: 사용자 요구("좀 넓게 선택해도 검사", "최대 드래그 범위", "한 경로로 이미 포함된 것이 다른 경로로 해석되지 않도록", "remote 도 동일") · [ADR-0045](0045-remote-path-link-reuses-desktop-parser.md) · [architecture/data-flow.md §8.6](../architecture/data-flow.md)
- Extends: ADR-0045

## Context

기존 path-link는 사용자가 선택한 문자열 전체를 경로 하나로 해석하고 `stat_path`를 한 번 호출한다. 파일시스템 조회 범위를 명확히 제한하지만 사용자가 경로 경계만 정확하게 드래그해야 하며, 한 선택에 여러 파일 경로가 들어 있으면 아무 링크도 만들 수 없다. 화면 전체를 상시 탐색하면 출력·스크롤마다 후보 수만큼 filesystem stat과 IPC가 늘고 Windows의 WSL·UNC 경로에서 비용이 특히 커진다.

선택 영역을 검색 범위로 쓰면 비용을 명시적 사용자 동작에 묶으면서 정확한 드래그를 요구하지 않을 수 있다. 다만 경로 `src/components/App.tsx` 안의 `components/App.tsx`나 `App.tsx`를 다시 후보로 만들면 긴 경로의 검증 실패가 우연히 존재하는 내부 파일로 fallback하여 사용자가 선택한 텍스트와 다른 대상을 열 수 있다. 복수 후보는 desktop 데코레이션 상태와 Remote `path-link` 응답 계약도 단일 값에서 목록으로 바꾼다.

범위는 desktop과 browser Remote의 선택 기반 파일 링크 발견, 검증, 표시다. 화면 전체 상시 탐색, scrollback 탐색, Remote 디렉터리 CWD 전파, 공백이 실제 파일명인 경로의 추론은 비목표다.

## Decision

**desktop과 Remote는 최대 1,024자·8줄의 선택을 왼쪽부터 maximal-munch로 소비해 최대 16개의 비중첩 경로 후보를 만들고, 중복 절대경로를 제거한 한 번의 bounded batch stat 뒤 존재하는 각 후보만 독립 링크로 표시한다.**

- 공통 TypeScript parser가 공백·따옴표·괄호 등의 경계로 선택을 maximal token으로 나눈 뒤 후행 `:line:col`과 문장부호만 제거한다. 한 maximal token을 소비한 뒤에는 그 내부 substring이나 suffix를 다시 후보로 만들지 않는다. 그 최장 후보가 길이 상한을 넘거나 stat에 실패해도 내부 경로로 fallback하지 않는다.
- 선택이 정리된 maximal token 하나뿐이면 기존 호환성을 유지해 `laymux`, `v3` 같은 슬래시·확장자 없는 맨이름도 후보로 받는다. 주변 문장이 포함된 넓은 선택에서는 절대경로, `/`·`\` 구분자, 파일 확장자 중 하나가 있는 strong candidate만 받는다.
- 선택 전체 상한은 1,024 UTF-16 code unit과 8줄, 후보 상한은 16개다. 하나라도 전체 상한을 넘거나 17번째 후보가 나오면 부분 결과를 내지 않고 선택 전체를 검사하지 않는다. 기존 `terminal.pathLinkMaxLength`는 각 정리된 후보의 길이 상한으로 적용한다.
- frontend는 후보를 CWD와 조합하고 동일 절대경로를 입력 순서대로 deduplicate한다. 새 Rust `stat_paths` command는 최대 16개 입력만 받아 결과 순서를 보존하며 Windows의 기본 WSL distro를 batch당 최대 한 번 해석한다. 같은 path가 선택에 여러 번 보여도 stat은 한 번이지만 각 원문 위치는 별도 링크다.
- desktop은 드래그 중 오래된 링크를 즉시 지우고 120ms trailing debounce하며 pointer-up에서는 최종 선택을 즉시 검사한다. 검증 결과는 후보별 xterm decoration으로 표시하고 pointer 좌표 아래의 정확한 후보만 클릭·힌트·OS 위임 대상으로 삼는다.
- ADR-0045의 Remote 권한 경계와 stale-response 폐기 규칙은 유지한다. `path-link` 성공 응답은 단일 `{token,path}` 대신 `{valid:true,matches:[{token,path,lineIndex,startIndex,endIndex}]}`를 반환한다. Remote는 좌표 범위가 최신 선택 원문과 exact match인지 다시 검증하고 최대 16개 파일만 각각 장식한다. 디렉터리는 계속 Remote 링크로 활성화하지 않는다.

## Alternatives Considered

- **화면 전체 또는 viewport 전체를 상시 탐색한다.** 사용자는 선택할 필요가 없지만 출력·스크롤·reflow마다 후보 추출과 filesystem 조회가 발생한다. 과거 hover 줄 전체 stat 방식도 느려 제거됐으므로 사용자 선택에 비용을 묶는다.
- **넓은 선택에서 유효 후보 하나만 허용한다.** 구현과 클릭 상태는 단순하지만 입력·출력 파일이 한 로그 문장에 함께 있을 때 사용자가 다시 좁혀 선택해야 하므로 넓은 선택의 목적을 충분히 달성하지 못한다.
- **긴 후보의 stat이 실패하면 내부 suffix를 차례로 검사한다.** 링크 성공률은 높아 보이지만 사용자가 본 최장 경로와 다른 파일을 조용히 열 수 있고 후보 수가 입력 길이에 따라 증가한다. maximal token 범위를 실패까지 원자적으로 소비한다.
- **후보마다 기존 `stat_path` IPC를 병렬 호출한다.** 코드 변경은 작지만 WSL distro 탐지와 IPC가 후보 수만큼 반복된다. bounded batch command로 비용과 결과 순서를 고정한다.

## Consequences

- 사용자는 로그 문장이나 여러 줄을 대략 선택해도 그 안의 복수 파일 경로를 각각 열 수 있다. 같은 긴 경로의 내부 basename이 별도 링크가 되는 일은 없다.
- strong candidate 휴리스틱 때문에 넓은 문장 안의 확장자 없는 맨이름은 자동 링크되지 않는다. 그 이름만 단독 선택하면 기존처럼 존재 검증한다. 공백이 포함된 실제 경로도 따옴표 안의 공백을 하나의 token으로 추론하지 않으며 정확성과 bounded 비용을 우선한다.
- Remote 응답 shape가 바뀌므로 구형 page와 신형 frontend bridge의 혼용은 링크를 표시하지 않는 fail-closed 결과가 된다. page는 desktop binary에 내장되어 함께 배포되므로 별도 schema migration은 없다.
- 테스트는 maximal-munch 비중첩, 긴 후보 실패 시 내부 fallback 금지, 복수 줄/복수 후보, 모든 상한, 중복 stat 제거, desktop 복수 데코레이션 hit-test, CWD 변경 중 stale stat 폐기, Remote 목록 응답·stale selection·와이드 셀 좌표 계약, Rust batch 순서·상한을 다룬다.
- 후보 휴리스틱이나 상한을 바꾸면 filesystem 조회량과 Remote 계약의 의미가 달라지므로 living doc과 이 ADR의 제약을 함께 검토한다.
