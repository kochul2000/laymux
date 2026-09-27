# Remote Direct 한글 단어 중복 입력 재현과 검증

사용자는 Android laymux 앱의 Direct 입력에서 소프트웨어·하드웨어 키보드 모두 단어가 간헐적으로 반복된다고 보고했다. Composer에서는 발생하지 않는다고 확인했다. 결정은 [ADR-0268](adr/0268-remote-ime-shares-composition-reconciliation.md)이다.

## 원인과 수정

Remote에 배포하는 `src-tauri/src/remote_server/assets/xterm.js`에는 데스크톱의 조합 확정 관측 병합이 없었다. `compositionend`가 deferred finalizer를 예약한 뒤 `input(insertText)`가 같은 단어를 전달하면 input과 finalizer가 각각 송신했다. 단어 전체가 `/write`에 들어가기 전에 이미 중복된다. HTTP 응답 지연 0ms와 150ms에서 모두 재현했다.

설치 스크립트의 데스크톱 CJS와 Remote CJS가 조합 패치 목록을 공유하도록 수정했다. 기존 generation FIFO·input/keypress 병합·keypress 기본 삽입 취소·compositionend 데이터 복구·blur flush를 동일하게 적용한다. 서로 다른 세대의 반복 입력을 제거하는 문자열 필터는 추가하지 않았다. Composer, Android native bridge, HTTP/PTY 계약은 변경하지 않았다.

## 실제 dev 검증

- 기준 HEAD: `c7112b24d30c55ffc428e268bb2655130f8a8297`와 이 워크트리의 수정 사항.
- 브랜치·워크트리: `fix/remote-ime-duplicate-input`, `D:\PycharmProjects\laymux-fix-remote-ime`.
- `cargo tauri dev --no-watch`로 실행한 dev 19281, PID 71104. health의 worktreeRoot·gitBranch·gitCommit을 대조했다. 컴파일 캐시는 기존 `laymux-dev/target`을 재사용하므로 실행 경로는 `D:\PycharmProjects\laymux-dev\target\debug\laymux.exe`다.
- APPDATA·WebView 저장소는 `.tmp/remote-ime-dev` 아래로 격리했다. 해당 워크트리의 Vite는 1432, WebView CDP는 9232다. release 19280은 조작하지 않았다.
- Chromium의 Android 모바일 환경에서 실제 dev가 제공하는 Remote 문서를 열었다. 합성 DOM `compositionstart → compositionupdate → compositionend → input(insertText)`를 같은 task에 전달했다. 각 HTTP `/write` 전송을 150ms 보류한 뒤 실제 서버로 전달했다.
- PowerShell pane에 Node 수신기를 띄워 실제 ConPTY stdin을 UTF-8 파일로 저장했다. 단순 줄 수신기와 관계없는 focus-report 모드는 비교 양쪽에서 껐다. Enter는 브라우저 키 입력으로 보냈다.
- 대조군은 같은 페이지에서 xterm 자산 하나만 기준 HEAD의 번들로 대체했다. 수정군은 dev가 제공한 자산을 그대로 사용했다. 두 자산의 SHA-256을 원본 파일과 비교했다.

| 조건 | 한 번씩 확정한 조합 | 실제 수신 문자열(CRLF 제외) |
|---|---|---|
| 수정 전 번들 | `키보드를` | `키보드를키보드를` |
| 수정 후 번들 | `키보드를` | `키보드를` |
| 수정 후, 별도 조합 두 번 | `그렇게 `, `그렇게 ` | `그렇게 그렇게 ` |

기준 번들의 SHA-256은 `78f19b0123fc7531ab10df64ecd79653a6e4022b5b5bc39647420853f1cd0fec`, 수정 번들은 `ce4fce782ba87c35d26ae356b9986fdc879f31334e3daef53737472dd3e60e35`다. 로컬 측정 JSON·수신 파일·Remote 화면은 `.tmp/remote-ime-dev/`, Automation screenshot은 `.screenshots/`에 남겼다. 스크린샷도 확인했으며 입력 판정의 근거는 전송 본문과 실제 stdin 파일이다.

## 자동 검증

- 수정 전에 실제 Remote 브라우저 단어 확정 2건과 공통 xterm 조합 회귀 중 Remote 14건의 실패를 먼저 확인했다.
- 실제 Terminal 조합·blur 경합·IME 컨트롤러·Remote Unicode·설치 계약 테스트 188개 통과.
- `remote-ime-preedit.spec.ts` 9개 통과. Android 모바일 조건에서 단어 확정, 전파된 keypress, 의도적 반복, 첫 HTTP 응답을 해제하지 않은 상태의 다음 단어, 확정 후 blur를 포함한다.
- UI production build, 변경 파일 ESLint·Prettier, `git diff --check` 통과. Windows dev 빌드·기동 성공.
- postinstall 재실행 전후 ESM·CJS·Remote 번들 SHA-256이 모두 같아 재적용의 멱등성을 확인했다.
- PR #1086 독립 서브에이전트 리뷰에서 P1·P2 finding 없음. 리뷰어가 조합·설치 계약 테스트 44개를 별도로 통과했고 Chromium CDP 입력에서 정상 확정, 별도 조합의 반복, 조합 중 포커스 해제를 검증했다. ADR-0268을 Accepted로 전환했다.
- 추가 실행한 `remote-input-composer.spec.ts`는 50건 중 46건 통과, 기존 4건 실패다. 실패는 snapshot을 보류한 상태에서 완료 문구를 기다리는 3건(1126·1172·1505행)과 double/triple tap의 focus 기대 1건(1578행)이다. 단일 worker 재실행도 같았고, 해당 테스트·helper·사용하는 Remote app/CSS 번들은 기준 HEAD와 동일하다. 이 파일은 실제 xterm 자산을 제거하고 mock Terminal을 사용하므로 이번 변경 자산을 실행하지 않는다.

## 검증 한계와 반영

실제 서버·ConPTY·수신 프로그램은 검증했지만 입력 이벤트 자체는 합성했다. 사용자의 Android 기기, 키보드 앱, 물리 키보드가 만드는 이벤트 trace와 재현 빈도는 아직 측정하지 않았다. 브라우저의 Android 에뮬레이션은 Android System WebView 실기 검증을 대신하지 않는다.

Android 앱은 PC의 Remote 자산을 받아 실행한다([ADR-0149](adr/0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md)). 따라서 이 수정의 반영 대상은 PC Laymux 빌드이며 APK 변경은 없다. PC에 수정 빌드를 배포한 뒤 Remote 문서를 새로 열어야 새 해시의 xterm 자산을 받는다. 위 측정은 release 배포 전 dev에서 수행한 결과다. 수정은 독립 코드 리뷰 후 PC `v1.0.19`로 배포하며 Android 채널은 마지막 APK 버전을 유지한다([ADR-0223](adr/0223-android-release-advances-only-with-apk.md)).
