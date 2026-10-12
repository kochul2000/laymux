# 0293. Android 첨부 버튼은 선택 메뉴 없이 시스템 파일 선택기를 바로 연다

- Status: Accepted
- Date: 2026-10-06
- Source: 사용자 요구("첨부버튼을 눌렀을 때 최근파일/갤러리 다른앱에서 선택/취소 모달 없이 이전처럼 최근파일로 진입"), PR #1122, [ADR-0290](0290-android-attachment-picker-and-share-inbox.md), [api-contracts.md §13](../architecture/api-contracts.md)
- Supersedes: ADR-0290 의 첨부 선택 메뉴(`최근 파일·파일 찾아보기`/`갤러리·다른 앱에서 선택`)와 메뉴의 `공유받은 파일 첨부` 항목. 선택 결과의 복귀 후 전달, 공유 수신과 확인창 흐름은 유지한다.

## Context

ADR-0290 은 갤러리 왕복 첨부 유실과 공유 수신을 고치면서 첨부 버튼에 native 선택 메뉴를 추가했다. 갤러리 왕복 실패의 원인은 결과 전달 순서와 laymux 가 공유 대상이 아니었던 점이었고, 두 문제는 결과 유예와 공유 수신으로 이미 해결됐다. 메뉴는 원래 시스템 선택기에서 고를 수 있던 최근 파일·갤러리·다른 앱 사이에 한 단계를 더했다.

## Decision

**첨부 버튼은 accept MIME·multiple 을 반영한 ACTION_GET_CONTENT(OPENABLE) 시스템 선택기를 바로 연다.**

- 시스템 선택기의 최근 파일 화면에서 시작하고, 갤러리·다른 앱은 선택기 drawer 에서 고른다. PR #1122 이전 WebView 기본 선택기와 같은 진입이다.
- 공유받은 파일은 PC 소유 Remote 페이지의 확인창(`여기에 첨부`)으로만 첨부한다. 일반 첨부 버튼은 보유 중인 공유를 소비하거나 폐기하지 않는다.
- 결과 유예·취소·문서 세대 검증 등 ADR-0290 의 나머지 결정은 그대로다.

## Alternatives Considered

- 메뉴 유지: 사용자가 원래 선택기에서 하던 선택을 한 번 더 묻는다.
- ACTION_OPEN_DOCUMENT 로 바로 열기: 최근 파일은 보이지만 drawer 에 갤러리 등 다른 앱이 나오지 않는다.

## Consequences

첨부 버튼 한 번으로 시스템 선택기가 열린다. `offerSharedFiles` 를 모르는 구 PC Remote 문서에서는 native 메뉴 fallback 이 없어지므로 공유 파일을 첨부하려면 PC 를 갱신해야 한다. 공유는 다음 공유나 앱 종료 전까지 메모리에 남는다. Intent 구성은 Android instrumentation 테스트로 검증한다.
