# 0259. Remote 파일 열람 중 system back은 직전 Files 목록으로 돌아간다

- Status: Accepted
- Date: 2026-09-21
- Source: [issue #1063](https://github.com/kochul2000/laymux/issues/1063), [ADR-0198](0198-remote-file-explorer-overlay.md), [ADR-0219](0219-android-back-defers-to-remote-ui-stack.md), [api-contracts §13.3.1](../architecture/api-contracts.md#1331-remote-file-viewer)
- Amends: ADR-0219의 FileViewer system back 정책만 대체한다. 나머지 레이어 우선순위와 native 위임 계약은 유지한다.

## Context

Files에서 파일을 연 뒤 Android 뒤로가기를 누르면 목록까지 닫혀 터미널로 돌아간다. 다른 파일을 보려면 Files를 다시 열고 디렉터리를 다시 찾아야 한다. ADR-0219는 파일 열람도 오버레이 전체 닫기로 정했지만, 사용자는 Files 내부의 탐색 단계를 한 단계씩 돌아가기를 요구했다.

Remote 문서는 이미 직전 디렉터리를 페이지 지역 상태로 소유하고 헤더 Back으로 fresh 목록을 요청한다. Android wrapper가 파일 모드를 해석하거나 브라우저 history를 도입할 필요가 없다. 이번 범위는 system back의 Files 내부 복귀이며 Escape·닫기·backdrop과 browser/PWA history 동작은 변경하지 않는다.

## Decision

**Remote system back은 FileViewer에 복귀할 Explorer 경로가 있으면 그 목록을 다시 요청하고, 없으면 오버레이를 닫는다.**

- PC가 제공하는 Remote 문서가 `dismissTopLayer(): boolean` 안에서 판단한다. Android는 기존 위임 경계를 그대로 사용하고, 목록 복귀도 입력을 소비한 `true`로 처리한다.
- 헤더 Back과 system back은 동일한 복귀 함수를 사용한다. 파일을 연 직전의 디렉터리를 재조회하며 부모 디렉터리를 추측하거나 목록을 캐시하지 않는다.
- 파일 요청 로딩·실패 중에도 복귀 경로가 있으면 같은 규칙을 적용한다. 목록 요청은 기존 revision을 증가시켜 늦은 파일 응답을 무효화하고 기존 lease/capability 검증을 거친다. 디렉터리 이동 실패 시 기존 헤더 Back이 가진 복구 경로도 공유한다.
- 디렉터리 목록 표시 중이거나 복귀 요청 중에는 복귀 경로가 없으므로 다음 system back은 Files를 닫는다. Explorer를 거치지 않은 터미널 파일 링크도 복귀 경로가 없으므로 한 번에 닫는다.
- 탐색 상태는 기존 페이지 지역 상태로만 유지한다. native 코드, HTTP 계약, 보안 게이트, 영속 상태는 추가하지 않는다.

## Alternatives Considered

- **system back으로 항상 전체 닫기 유지:** 현재 계약을 유지하지만 다른 파일을 열기 위한 반복 탐색을 줄이지 못한다.
- **Android에서 viewer 모드를 확인:** wrapper에 PC UI 지식을 복제하고 APK와 Remote 자산의 동시 변경이 필요해 기각했다.
- **브라우저 history에 탐색 단계 추가:** browser/PWA까지 의미가 넓어지고 history·문서 이탈 수명 관리가 필요하다. 이번 요구는 기존 Android 위임 함수 안에서 충족된다.

## Consequences

- Files에서 연 파일은 뒤로가기 한 번으로 목록, 다시 한 번으로 터미널에 복귀한다. 명시적 닫기나 Escape는 기존처럼 전체를 닫는다.
- 목록 복귀에 네트워크 왕복이 필요하고 실패하면 기존 오류·재시도 UI가 남는다. 현재 헤더 Back과 같은 비용과 실패 정책이다.
- Playwright로 모바일 목록 복귀, 다음 back의 닫기, 지연 응답 무효화와 Android E2E bridge의 레이어 순서를 검증한다. Remote 배포 번들과 living doc을 함께 갱신한다.
- browser/PWA history 탐색까지 통합하거나 폴더 탐색 전체 이력을 되돌려야 한다면 별도 결정으로 재검토한다.
