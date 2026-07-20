# 0041. Remote FileViewer는 lease-gated API와 자격 증명 없는 새 탭으로 제공한다

- Status: Accepted
- Date: 2026-07-19
- Source: 사용자 요구(“서빙을 하고 이용자 브라우저로 새탭에서 열기”), issue #481, [api-contracts.md §13](../architecture/api-contracts.md), [ADR-0013](0013-direct-remote-mode.md), [ADR-0031](0031-extension-viewer-profile-path-conversion.md) 확장

## Context

데스크톱 FileViewer는 Tauri IPC로 호스트 파일을 읽고, text/image/HTML/Markdown을 overlay에서 표시하거나 `extensionViewers` 매핑에 따라 별도 terminal session에서 외부 명령을 실행한다. Remote Focused UI는 terminal만 표시하므로 MCP나 데스크톱 UI가 FileViewer를 열어도 원격 사용자는 그 내용을 볼 수 없다.

호스트 파일은 Remote token만 가진 관찰자에게 공개할 일반 navigation metadata가 아니다. 파일 경로와 내용은 민감할 수 있고, raw HTML을 remote origin에서 직접 제공하면 호스트 파일의 script가 Remote API와 같은 origin에서 실행될 수 있다. token·lease·path를 새 탭 URL에 넣으면 브라우저 history, 로그, referrer, 화면 공유에 남는다. 또한 MCP 이벤트에 반응해 비동기로 `window.open`을 호출하면 브라우저 popup blocker를 안정적으로 통과할 수 없다.

범위는 현재 데스크톱 viewer 파일 또는 사용자가 Remote drawer에 직접 입력한 단일 호스트 파일의 읽기 전용 표시다. 디렉터리 탐색, 파일 편집·저장, 외부 terminal viewer 투영, 자동 popup은 비목표다.

## Decision

**Remote FileViewer는 active controller lease로 보호한 bounded render API를 통해 호스트 파일을 읽고, 사용자의 동기 gesture로 연 자격 증명 없는 `/remote/viewer/` 새 탭에 same-origin `postMessage`로 세션을 한 번 전달해 렌더한다.**

1. Rust remote server는 `/remote/viewer/`와 외부 script `/remote/viewer/viewer.js`를 제공한다. 두 asset은 `/remote/`와 같은 enabled/token-exists/IP base gate를 통과하고 no-store·no-referrer·nosniff 및 `script-src 'self'`/`frame-ancestors 'none'` CSP를 사용한다. bootstrap HTML에는 token, lease, path, inline script가 없다.
2. Remote drawer는 `GET /remote/v1/file-viewer/status`로 desktop `useFileViewerStore`의 `{open,path}`를 조회하고, `POST /remote/v1/file-viewer/render`로 `source="current"|"path"`를 렌더한다. 두 API는 Remote 인증 middleware와 active lease를 모두 요구한다. `current`의 path SoT는 desktop store이며 client path는 받지 않는다.
3. 새 탭은 button/Enter의 user gesture에서 먼저 연다. child의 exact-origin ready 메시지와 opener가 보관한 pending `Window` identity가 모두 맞을 때만 token·lease·source/path를 메모리상 메시지로 한 번 전달한다. child URL·bootstrap DOM·persistent/session storage에는 자격 증명이나 path를 넣지 않는다. child는 exact origin·opener source를 확인한 첫 세션만 받고 즉시 opener 참조를 끊는다.
4. Rust가 render 요청마다 8 MiB source 상한을 정하고 frontend async bridge에 전달한다. `readFileForViewer`는 image에도 상한을 적용한 bounded read를 수행한다. frontend는 데스크톱 FileViewer의 text/image/binary 분류와 HTML/Markdown sanitizer를 재사용해 typed payload 또는 완성된 safe preview document를 반환한다.
5. child는 일반 text를 `textContent`, image를 제한된 `data:image/*`, HTML/Markdown preview를 빈 sandbox iframe의 `srcdoc`으로만 표시한다. raw source를 parent DOM의 HTML로 삽입하지 않는다.
6. Remote surface는 `extensionViewers` 매핑을 실행하지 않고 built-in web renderer를 사용한다. 외부 viewer 프로세스는 desktop 전용 권한·surface이며, 파일 읽기 요청이 임의 host process 실행으로 확대되어서는 안 된다.
7. desktop/MCP가 viewer를 비동기로 열면 Remote heartbeat 성공 후 status를 best-effort 갱신해 “Desktop file” action을 활성화한다. 브라우저 popup 정책을 우회하지 않으며 사용자가 눌러 새 탭을 연다.

## Alternatives Considered

- **FileViewer terminal session을 Remote의 main terminal로 attach**: vi 같은 terminal viewer는 일부 확장자를 표시할 수 있지만 built-in text/image/HTML/Markdown viewer와 동작이 다르고 image·safe preview를 다루지 못한다. global viewer terminal을 workspace/dock navigation에 섞으면 ADR-0018/0020의 focused terminal 경계도 흐려진다.
- **호스트 파일을 raw GET URL로 직접 서빙**: 구현은 단순하지만 path와 인증 정보가 URL에 노출되고, raw HTML의 same-origin script 실행·MIME sniffing·캐시 위험이 생겨 기각한다.
- **MCP/desktop open 이벤트에서 자동 새 탭**: 비동기 이벤트는 user activation이 없어 모바일/데스크톱 브라우저 popup blocker에 막힌다. 차단 우회 대신 상태를 표시하고 명시적 user gesture를 요구한다.
- **서버 발급 1회용 ticket을 URL fragment에 전달**: bearer token 노출은 줄지만 ticket 저장소·만료·consume race라는 새 서버 상태가 생긴다. 이미 same-origin opener와 active lease가 있고 새 탭을 user gesture에서 열 수 있으므로 메모리 `postMessage`가 더 작은 계약이다.
- **Remote에서도 `extensionViewers` shell command 실행**: 명시적 desktop 설정을 재사용할 수 있으나 독립 browser tab에 프로세스 UI를 투영할 수 없고, read-only remote 기능이 process execution 권한을 갖게 되어 기각한다.

## Consequences

- Remote 사용자는 MCP나 데스크톱에서 열린 파일과 직접 입력한 호스트 파일을 새 탭에서 볼 수 있다. child URL만 복사·history 기록해도 자격 증명과 경로는 포함되지 않는다.
- controller lease 보유자는 allowlist 범위 안에서 임의 호스트 파일 경로를 읽을 수 있다. 이는 terminal을 제어하는 동일한 고권한 사용자에게만 허용하며, observer/token-only client에는 허용하지 않는다.
- HTML/Markdown source는 기존 sanitizer 한 곳을 공유하고, preview document는 이중 CSP+sandbox 경계에서 실행된다. sanitizer 변경 시 desktop과 Remote 회귀 테스트를 함께 수행해야 한다.
- image base64와 preview document는 source보다 커질 수 있으므로 8 MiB는 응답 메모리 비용의 상한이 아니라 입력 상한이다. 메모리 문제가 관측되면 streaming/blob ticket 계약을 새 ADR로 재검토한다.
- 외부 terminal viewer와 remote web viewer의 표시 정책은 의도적으로 다르다. 향후 remote에 외부 viewer projection을 추가하려면 process 권한과 surface routing을 별도 결정한다.
- 테스트는 frontend bridge unit, Rust bound/route/bootstrap contract, Playwright 새 탭 handshake·자격 증명 비노출·모바일 overflow를 포함한다.
