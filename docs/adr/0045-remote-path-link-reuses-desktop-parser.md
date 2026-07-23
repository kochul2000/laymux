# 0045. Remote 경로 링크는 데스크톱 파서와 CWD를 재사용해 검증한다

- Status: Accepted
- Date: 2026-07-21
- Source: 사용자 요구(“PC 버전의 상대경로 파싱·유효성 확인·밑줄·클릭을 Remote에도 적용”), issue #363, [architecture/data-flow.md §8.6](../architecture/data-flow.md), [architecture/api-contracts.md §13.3.1](../architecture/api-contracts.md), [ADR-0015](0015-remote-terminal-state-ownership.md), [ADR-0042](0042-remote-file-viewer-secret-capability.md), [ADR-0044](0044-remote-file-viewer-explicit-host-path.md) 확장

## Context

데스크톱 `TerminalView`는 사용자가 선택한 한 토큰을 `trimSelectionToPath`로 정리하고, 해당 pane의 CWD와 `joinCwdPath`로 결합한 뒤 `stat_path`로 실제 존재를 확인한다. 유효한 파일은 밑줄을 긋고 FileViewer로 열며, 디렉터리는 SyncGroup CWD 변경으로 분기한다. 이 파서는 URL 배제, 따옴표·괄호·문장부호와 `:line:col` 제거, MSYS CWD 정규화처럼 크로스플랫폼 세부 규칙을 이미 가진다.

Remote xterm은 별도 정적 HTML/JavaScript surface이므로 같은 선택 UI가 없고, 브라우저 자체로는 호스트 파일의 존재 여부를 확인할 수 없다. 파서를 Remote JavaScript에 복제하면 두 구현이 독립적으로 변해 같은 선택이 desktop과 Remote에서 다르게 해석될 수 있다. Remote가 navigation payload의 CWD를 사용해 절대경로를 만들어 보내는 방식도 stale CWD와 client 조작 경로를 서버가 신뢰하게 만든다. 반대로 유효성 확인을 위해 기존 render API를 미리 호출하면 클릭 전 파일 내용을 최대 8 MiB까지 읽고 전송하게 된다.

범위는 active Remote terminal에서 사용자가 선택한 단일 **파일** 경로의 검증, 밑줄 표시, 기존 Remote FileViewer 새 탭 열기다. 디렉터리 CWD 이동, 자동 토큰 스캔, 파일 내용 prefetch, observer의 파일 접근 권한 확대는 비목표다.

## Decision

**Remote 경로 링크는 선택·표시 좌표만 브라우저 surface가 소유하고, 토큰 파싱·CWD 결합·파일 존재 판정은 새 lease/capability-gated bridge가 데스크톱 구현을 그대로 재사용한다.**

1. `POST /remote/v1/file-viewer/path-link`를 추가한다. 요청 body는 `{terminalId, selection}`이며, bearer token/IP/Origin gate에 더해 active lease와 `X-Laymux-Remote-File-Viewer` capability를 요구한다. selection은 설정 상한의 최대값인 4096자, terminal id는 256자를 서버에서 제한한다.
2. Rust route는 CWD나 해석된 path를 client에서 받지 않고 frontend async bridge의 `fileViewer.pathLink`로 terminal id와 선택 원문만 전달한다. bridge 완료 뒤 ADR-0042와 동일하게 요청 당시 lease/capability를 다시 검증하고 모든 응답에 `Cache-Control: no-store`를 적용한다.
3. frontend bridge는 desktop `useTerminalStore`에서 terminal의 최신 CWD를, `useSettingsStore`에서 `pathLinkEnabled`와 `pathLinkMaxLength`를 읽는다. 기존 `isWithinPathLengthLimit` → `trimSelectionToPath` → `joinCwdPath` → `statPath` 순서를 그대로 실행한다. 존재하는 일반 파일만 `{valid:true, token, path}`로 반환하며, 비활성 설정·부적합 선택·없는 경로·디렉터리는 `{valid:false}`다.
4. Remote page는 선택 변화 시 검증을 trailing debounce하고 새 선택에서는 이전 요청을 취소한다. 응답 시점의 xterm selection 좌표와 응답 token으로 밑줄 범위를 다시 계산해 `IDecoration`으로 표시한다. 이 좌표·marker·pointer hit-test는 ADR-0015의 surface-local 상태이며 Remote API에 넣지 않는다. 최신 selection/terminal/lease와 맞지 않는 비동기 응답은 버린다.
5. 밑줄 영역의 짧은 primary pointer click은 ADR-0044의 명시적 host path action인 `openFileViewerTab(path)`를 동기 user gesture 안에서 호출한다. 새 탭의 credential 전달과 실제 파일 render는 ADR-0042/0044의 기존 handshake를 그대로 사용한다. 검증 단계에서는 파일 내용을 읽지 않는다.
6. 검증 상태와 decoration은 선택 해제·다른 terminal 전환·xterm reset·lease/capability 상실 때 폐기한다. 검증된 절대경로는 문서 메모리에만 두며 URL이나 storage에 기록하지 않는다.

## Alternatives Considered

- **Remote JavaScript에 desktop 파서를 복제**: 서버 왕복 전에 후보를 줄일 수 있지만 따옴표, grep suffix, MSYS/Windows/WSL 조합 규칙이 두 곳에서 쉽게 어긋난다. 사용자가 요구한 desktop과 정확히 같은 파싱을 장기적으로 보장하지 못한다.
- **기존 `/file-viewer/render`를 선택 때 preflight로 호출**: 새 endpoint는 없지만 클릭하지 않은 파일도 최대 8 MiB까지 읽고 브라우저로 전송한다. 선택 검증 비용과 민감 데이터 노출 범위가 불필요하게 커진다.
- **Remote가 navigation CWD와 선택을 조합해 절대경로를 보내고 서버는 stat만 수행**: navigation snapshot이 오래됐을 수 있고, 데스크톱 parser/settings와 별도 구현이 된다. client가 terminal의 실제 CWD와 무관한 path를 검증하도록 만드는 것도 책임 경계를 흐린다.
- **디렉터리도 밑줄을 긋고 Remote에서 CWD를 변경**: desktop 기능 전체와 대칭이지만 새 CWD 제어 action과 SyncGroup 정책을 Remote 계약에 추가해야 한다. 이번 요구는 파일을 Remote Viewer로 여는 것이므로 별도 결정 없이 권한과 범위를 넓히지 않는다.

## Consequences

- desktop과 Remote가 동일한 parser, path length 설정, terminal CWD, Rust `stat_path`를 사용하므로 플랫폼별 경로 해석이 한 구현을 따른다.
- 선택이 정착할 때마다 작은 bridge 왕복과 filesystem stat이 발생한다. 드래그 중 변화는 debounce하고 이전 요청은 취소하며 4096자 hard cap을 두지만, 느린 네트워크 filesystem에서는 밑줄 표시가 지연될 수 있다.
- 새 endpoint는 호스트 파일의 존재 여부를 간접적으로 확인할 수 있으나, 임의 파일 내용을 이미 읽을 수 있는 현재 claim 성공자의 FileViewer capability에만 허용한다. token-only observer의 권한은 늘지 않는다.
- Remote에서는 디렉터리를 링크로 활성화하지 않으므로 desktop의 `changeDir` 분기와 의도적으로 다르다. Remote 디렉터리 탐색 요구가 생기면 navigation/CWD 권한과 SyncGroup 전파를 새 ADR에서 결정한다.
- 테스트는 frontend bridge의 parser/settings/CWD/stat 재사용, Rust 요청 상한·capability 재검증, 실제 xterm selection의 밑줄과 클릭 새 탭, terminal/lease 전환 시 stale 결과 폐기를 검증한다.
