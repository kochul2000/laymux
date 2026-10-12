# 0290. Android 첨부 선택 결과를 복귀 후 전달하고 파일 공유를 받는다

- Status: Superseded by [0293](0293-android-attachment-direct-system-picker.md) (첨부 선택 메뉴와 메뉴의 공유 파일 항목만; 결과 유예·공유 수신·확인창은 유지)
- Date: 2026-10-05
- Source: 사용자 요구(갤러리 왕복 첨부 실패·Android 파일 공유 수신), architecture/api-contracts.md §13, ADR-0163, ADR-0181, ADR-0227
- Extends: [ADR-0163](0163-android-foreground-preserves-remote-document.md), [ADR-0181](0181-remote-terminal-file-attachments.md)

## Context

시스템 파일 선택기에서 갤러리 등 다른 앱으로 이동하면 focus가 파일 반환보다 먼저 돌아올 수 있다. Remote 페이지는 focus 후 250ms까지 파일이 없으면 선택을 폐기하고, native Activity Result는 보안 transport 복귀 전에 WebView에 전달될 수 있다. 선택 완료와 transport 복구는 서로 독립된 사건이므로 순서를 고정해야 한다.

현재 APK는 다른 앱의 파일 공유 대상이 아니다. 파일의 업로드·종류·크기·입력 대상 정책은 기존 PC 소유 Remote UI와 서버가 유지해야 한다. 최근 첨부 목록을 따로 영속하는 것은 이번 범위에서 제외한다.

## Decision

**Android는 파일 URI 선택과 공유 수신을 소유하고, 원래 문서의 선택 콜백을 transport 복귀 후 한 번만 완료하며, 공유 파일도 사용자의 첨부 선택을 거쳐 기존 업로드 경로에 전달한다.**

- focus의 빈 FileList는 취소가 아니다. 페이지는 change·cancel·문서/lease/terminal 교체로 선택의 수명을 판정한다. focus 재검사는 change 누락을 보완하며 시간 경과로 선택을 폐기하지 않는다.
- native는 onStop에서 결과 전달을 유예하고, 같은 Remote 문서의 foreground callback이 성공하거나 새 문서 로드가 끝난 뒤 결과를 전달한다. 문서 교체·Activity 종료는 대기 결과를 취소하며 새 문서에 넘기지 않는다.
- 앱은 단일 task의 MainActivity에서 ACTION_SEND와 ACTION_SEND_MULTIPLE을 받고, EXTRA_STREAM 또는 ClipData의 content URI만 중복 제거해 최대 64개 보관한다. file/http URI는 거절한다. 공유 파일은 앱 메모리에만 보관하며 파일 바이트나 URI 접근 권한을 영속하지 않는다. 새 공유는 이전 미첨부 공유를 대체한다.
- 공유 수신은 현재 접속한 PC·터미널을 그대로 사용한다. 미접속 상태에서는 파일을 유지하고 PC 연결 후 첫 터미널 준비 완료를 기다린다. native는 무작위 공유 ID·파일 개수만 PC 소유 페이지의 `offerSharedFiles`로 알리고, 페이지는 준비 완료 후 대상 이름이 있는 확인창을 자동 표시한다. 사용자의 `여기에 첨부` 클릭에서 기존 file input을 열고 native는 `takeSharedFileSelection`로 원래 chooser·lease·terminal identity가 유효한 공유 ID를 확인한 뒤 URI를 기존 WebView file callback으로 반환한다. WebView의 user activation을 유지하므로 native가 file input을 프로그램으로 자동 클릭하지 않는다.
- 확인창은 `대상 변경`에서 다른 터미널 또는 PC를 고르게 한다. 대상 변경·문서 교체는 공유를 소비하지 않고 새 대상이 준비되면 다시 확인한다. 취소·system back은 문서 세대가 검증된 `LaymuxNative.cancelSharedFiles(id)`로 해당 ID만 폐기한다. 오래된 확인·취소는 새 공유에 영향을 주지 않는다. 구 PC 문서는 기존 첨부 메뉴로 fallback한다. 서버의 lease·크기·종류 검증과 Composer/Direct 동작은 유지한다.
- 첨부 선택은 `최근 파일·파일 찾아보기`(ACTION_OPEN_DOCUMENT)와 `갤러리·다른 앱에서 선택`(ACTION_GET_CONTENT)을 제공한다. OPENABLE, accept MIME 목록과 multiple을 반영한다. 최근 파일은 OS 제공 목록이며 laymux 첨부 이력과 같지는 않다.

Android의 `onStop`은 현재 Remote 문서에 `onNativeBackground()`를 통지한다. 페이지는 heartbeat·output 재접속을 멈추고 chooser·lease·terminal identity를 유지한다. background lease 유지/반납은 기존 native·PC 정책이 소유하며 페이지의 heartbeat 경과 시간으로 대신 판단하지 않는다. foreground에서는 로컬 heartbeat 시간 기준을 다시 시작하고 실제 PC 응답으로 유효성을 확인한다. PC가 lease 상실을 확인하면 기존 취소·reclaim 정책을 따른다.

## Alternatives Considered

- focus 대기 시간을 늘리기: provider별 지연 상한을 알 수 없어 같은 실패를 늦출 뿐이다.
- native에서 bytes를 base64로 보내는 새 JS bridge: 기존 file callback과 서버 검증을 중복하고 별도 body 상한·입력 대상 계약을 요구한다.
- 공유 시 현재 터미널에 자동 업로드: 복귀 중 PC·lease·터미널이 바뀔 수 있고 사용자의 목적지를 확인할 수 없다.
- 최근 첨부 URI와 persistable grant 저장: 모든 갤러리/공유 provider가 지속 접근을 지원하지 않으며 삭제·만료·민감 파일 보존 정책이 추가로 필요하다. OS 최근 목록으로 제한한다.

## Consequences

APK 업데이트 후 Android 공유 대상에 laymux가 나타나며, PC Remote 자산 업데이트 후 늦은 갤러리 결과가 폐기되지 않는다. APK와 PC 양쪽을 업데이트해야 전체 개선을 사용한다. 공유받은 파일은 현재 대상의 확인창에서 한 번 눌러 첨부하며, 연결·대상 변경 중에는 URI를 계속 보유한다. 앱 프로세스 종료 시 미첨부 공유는 다시 공유해야 한다.

native 결과 순서와 취소는 JVM 테스트, Intent·URI·시스템 선택기 계약은 Android instrumentation, 늦은 change와 취소·lease 교체·공유 확인 UX는 실제 Remote 페이지 브라우저 테스트로 검증한다. 외부 provider의 읽기 권한 만료나 파일 삭제는 기존 첨부 오류 경로로 처리한다. 공유 취소용 native bridge와 metadata/선택 ID callback을 추가하지만 Remote HTTP 업로드 계약과 파일 저장소는 유지한다.
