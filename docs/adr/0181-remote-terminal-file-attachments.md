# 0181. Remote 터미널 첨부는 bounded 호스트 임시 파일과 기존 structured input을 사용한다

- Status: Proposed
- Date: 2026-08-19
- Source: 사용자 요구(Remote에서 이미지·텍스트 파일 첨부 버튼과 긴 텍스트 자동 전환), [architecture/api-contracts.md §13.4](../architecture/api-contracts.md), [ADR-0029](0029-detached-terminal-input-composer.md), [ADR-0034](0034-single-send-terminal-composer.md), [ADR-0042](0042-remote-file-viewer-secret-capability.md)

## Context

데스크톱의 스마트 붙여넣기는 호스트 클립보드의 파일 경로를 붙여 넣고, 이미지 바이트만 있는 경우에는 호스트 임시 파일로 저장한 뒤 그 경로를 terminal structured input으로 전달한다. Remote 브라우저의 파일 선택기와 클립보드는 접속 기기의 파일만 볼 수 있으므로 현재 `/write`와 `/input` 계약만으로는 같은 동작을 만들 수 없다. 브라우저의 로컬 경로 문자열은 PC에서 의미가 없고 브라우저 보안 모델도 원본 경로를 노출하지 않는다.

Remote가 브라우저 파일 바이트를 호스트에 저장하도록 허용하면 새 외부 계약과 디스크 쓰기 권한이 생긴다. 호출자가 임의 저장 경로·확장자·크기를 정할 수 없게 하고, controller 전환과 경쟁하는 저장 작업이 다음 owner 뒤까지 남지 않게 해야 한다. Direct, Cloud browser, Android E2E wrapper가 같은 PC 소유 페이지를 실행하므로 기존 2 MiB Android E2E RPC envelope 안에서도 동일 계약이 동작해야 한다.

긴 자연어를 그대로 structured input으로 보내면 Claude Code·Codex 같은 CLI가 자체 pasted-content 표현으로 접어 주기도 하지만, Remote에서는 브라우저·전송·PTY의 공통 1 MiB 상한까지 본문 전체를 통과시켜야 하고 선택 파일과 다른 사용자 경험이 된다. 사용자가 요구한 자동 전환은 긴 clipboard text도 선택한 text 파일과 같은 호스트 첨부 경로로 취급하는 정책이 필요하다.

범위는 Remote main page에서 선택한 이미지·UTF-8 text 파일과 긴 text paste를 현재 terminal 입력에 경로로 연결하는 것까지다. 임의 binary 업로드, 디렉터리 업로드, host 임의 경로 덮어쓰기, Remote FileViewer 열람 권한 확대, 첨부 내용을 모델 API로 직접 보내는 것은 비목표다.

## Decision

**Remote 터미널 첨부는 active controller가 bounded 이미지·UTF-8 text를 앱 소유 임시 디렉터리에 업로드하고, 반환된 terminal-visible 경로를 기존 structured input으로 삽입하는 방식으로 구현한다.**

1. Remote footer는 paperclip 버튼과 숨은 `input[type=file]`을 제공한다. 선택기는 이미지와 text 계열만 허용하고 여러 파일을 순서대로 처리한다. Android wrapper의 두 WebView는 Activity Result 기반 native chooser를 공유하며 새 요청·WebView 교체·Activity 종료 때 이전 callback을 정확히 한 번 취소한다. native chooser가 `FileList`만 채우고 `change`를 누락하는 System WebView는 page의 focus 복귀 bounded retry로 보완한다. 이 retry는 chooser를 연 시점의 generation·lease·terminal snapshot에 고정하고 disconnect·새 chooser·terminal 변경 때 폐기하며, upload in-flight guard와 완료 시 input clear로 정상 `change` 경로와의 중복을 막는다. Composer mode에서는 현재 selection에 경로를 삽입하고 자동 제출하지 않는다. Direct mode에서는 경로 문자열을 기존 `/input`의 `submit=false`로 붙여 넣는다.
2. `POST /remote/v1/terminals/{id}/attachments`는 `{leaseId,fileName,mimeType,data}` JSON을 받는다. `data`는 base64이며 한 파일의 decoded 상한은 1 MiB, route body와 Android native HTTP bridge의 사전 검사 상한은 1.5 MiB다. 이 크기는 기존 Android E2E RPC 2 MiB envelope를 변경하지 않고 한 번 더 base64로 감싼 요청도 전달할 수 있는 공통 상한이다. 응답은 `{path,byteLength}`이며 캐시하지 않는다.
3. 서버는 image signature가 확인되는 PNG/JPEG/GIF/WebP/BMP 또는 NUL이 없는 유효 UTF-8 text만 받는다. text는 허용된 MIME/확장자만 보존하고 그 밖에는 거절한다. 호출자 파일명은 basename·길이·문자 집합을 정규화하며 실제 이름에는 서버 UUID를 붙인다. 저장 디렉터리와 최종 경로는 호출자가 정할 수 없고 기존 파일은 덮어쓰지 않는다.
4. 저장은 controller owner gate의 non-PTY mutation permit 안에서 수행한다. permit 등록보다 owner transition이 먼저면 요청을 거절하고, 저장이 먼저면 transition은 저장 완료와 permit 해제를 기다린다. terminal profile은 저장 전에 host terminal catalog에서 복사하고 Windows host의 WSL profile에는 기존 path converter를 적용한다. AppState lock은 파일 I/O 동안 잡지 않는다.
5. 첨부 디렉터리는 사용자별 Laymux cache 아래에 두고 Unix에서는 mode 0700으로 강제한다. cache는 regular-file 총 크기 64 MiB와 파일 수 1,024개를 모두 넘기지 않는다. 시작할 때 7일 지난 regular file을 제거한다. 업로드 성공 뒤 client가 사라지거나 두 번째 `/input`이 실패하면 파일은 orphan이 될 수 있으며 같은 cleanup 정책으로 회수한다.
6. Remote page는 UTF-8 기준 5 KiB를 초과한 clipboard text를 `pasted-text.txt` 첨부로 자동 전환한다. Composer에서는 경로를 초안에 넣고, Direct에서는 경로를 structured paste한다. 다른 첨부가 진행 중인 긴 paste는 raw input으로 우회하지 않고 명시적으로 거절한다. 실제 업로드가 실패하면 선택 파일은 오류로 남기되 긴 clipboard text는 유실 방지를 위해 원래 paste 동작으로 복구한다. 하나의 attachment attempt는 upload뿐 아니라 Direct 경로 입력과 긴 paste 실패 fallback 입력까지 소유한다. disconnect와 non-Android BFCache `pagehide` release는 lease release를 기다리기 전에 이 attempt의 `AbortController`·identity와 chooser identity를 폐기하고, 각 비동기 경계 뒤 identity를 다시 확인해 늦은 completion이 새 lease의 UI나 입력을 바꾸지 못하게 한다. release drain 중 사용자가 다시 연결하면 이전 Exit의 늦은 surface 전환과 status 갱신도 claim revision으로 폐기한다. 1 MiB를 넘는 text는 서버로 보내지 않고 크기 오류를 표시한다.
7. Android E2E의 inner HTTP exact allowlist는 terminal action `attachments`를 추가한다. Android native는 method/path/body를 해석하지 않는 기존 opaque RPC adapter를 그대로 사용하므로 compat version은 올리지 않는다. 새 API는 host 파일을 읽거나 임의 경로에 쓰지 않으므로 FileViewer 전용 secret capability를 재사용하거나 확장하지 않는다.

## Alternatives Considered

- **브라우저 로컬 경로 문자열만 terminal에 전송**: 브라우저는 보안상 유효한 원본 경로를 주지 않으며 그 경로는 PC 파일시스템에도 존재하지 않는다.
- **파일 bytes를 PTY에 직접 paste**: binary image는 terminal text protocol에 실을 수 없고 긴 text도 CLI가 파일로 다시 읽을 수 있는 안정된 참조가 생기지 않는다. bracketed paste mode와 shell/TUI 해석에도 의존한다.
- **Remote FileViewer capability와 저장 API를 결합**: FileViewer token은 호스트 기존 파일을 읽는 별도 비밀 권한이다. 앱 소유 디렉터리에 bounded 새 파일을 만드는 controller action에 재사용하면 읽기와 쓰기 권한의 의미가 섞인다.
- **8 MiB 이상 단일 업로드**: 일반 Cloud tunnel은 수용할 수 있지만 Android E2E RPC의 기존 2 MiB envelope와 맞지 않는다. chunk session을 새로 설계하기 전에는 모든 Remote surface가 공유할 수 있는 1 MiB를 선택한다.
- **긴 text를 계속 raw structured input으로 전송**: CLI별 pasted-content UX에 맡길 수 있지만 선택 text 파일과 동작이 달라지고 Remote 전송 상한과 디스크 첨부 요구를 해결하지 못한다.

## Consequences

- Remote 접속 기기의 이미지와 text 파일을 PC 터미널에서 읽을 수 있는 실제 host path로 전달할 수 있고, 긴 paste도 같은 경로 계약을 사용한다.
- 자동 전환된 긴 text는 기존 composer runtime-only 경계를 벗어나 host cache에 기록된다. 이는 요청한 첨부 동작의 명시적 비용이며 크기·종류·디렉터리·총량·보존 기간을 제한한다. 비밀 text를 디스크에 남기지 않으려는 사용자는 5 KiB 이하로 나누거나 Direct key input을 사용해야 한다.
- 1 MiB보다 큰 원본 사진과 text 파일은 현재 거절된다. 이미지 리사이즈나 chunked upload가 필요해지면 E2E envelope, quota, 재조립 상태와 실패 cleanup을 별도 ADR로 결정한다.
- 파일 저장과 terminal 입력은 두 요청이므로 원자적이지 않다. 저장 성공 뒤 입력 실패는 terminal에 경로가 나타나지 않는 orphan만 만들며 PTY 입력 중복은 만들지 않는다.
- Rust 단위 테스트는 signature/UTF-8/filename/size·개수 quota/private directory/cleanup/path conversion을, Playwright는 파일 선택·Android `change` 누락 복귀와 reconnect 세대 격리·base64 wire·Composer 삽입·긴 paste 자동 전환·Direct structured paste·disconnect/BFCache pagehide 취소를, Android 단위 테스트는 native body 상한을 고정한다. living doc은 endpoint, 보안/보존 정책과 UI 동작을 함께 갱신한다.
