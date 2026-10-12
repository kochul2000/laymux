# 0318. Remote localhost 프리뷰를 철회하고 기존 Remote 보안 경계를 복원한다

- Status: Accepted
- Date: 2026-10-11
- Source: 사용자의 앱·서버 리버트 및 v1.9.1 배포 요청, [앱 PR #1178](https://github.com/kochul2000/laymux/pull/1178), [서버 PR #91](https://github.com/kochul2000/laymux-server/pull/91), [api-contracts.md §13](../architecture/api-contracts.md)
- Supersedes: [ADR-0317](0317-remote-localhost-web-preview.md)

## Context

PC의 로컬 웹서비스에 다른 기기에서 접속하려는 요구를 v1.9.0에서 내장 프리뷰로 확장했다. 이 구현은 Rust 읽기 세션, 브라우저 sandbox, Android 전용 WebView와 Cloud CSP 예외를 추가했다. 사용자는 Tailscale로 원격 접근을 해결할 수 있음을 지적하고 두 저장소의 변경을 철회하도록 명시했다. 추가 공격 표면과 유지보수 비용을 없애는 것이 이번 결정의 목적이다.

## Decision

**앱 PR #1178과 서버 PR #91의 프리뷰 구현을 되돌리고, 그 직전의 Remote 인증·OAuth 중계·링크 열기·CSP 계약을 복원한다.**

- localhost 프리뷰 API, 세션·캐시 수명 확장, bootstrap, 링크 가로채기, Android bridge와 별도 WebView를 제거한다. 기존 FileViewer capability와 E2E 소유권·재전송 검증은 프리뷰 도입 전 상태로 복원한다.
- Cloud의 프리뷰 전용 framing·WASM 예외를 제거하고 기존 Caddy/ASGI 보안 정책으로 복원한다. 로컬 서비스 접근을 위한 새 포트나 인증 경로를 만들지 않는다.
- 로컬 웹서비스 접근은 사용자가 구성한 Tailscale 등 별도 네트워크 경로에서 수행한다. 이 리버트는 Tailscale을 설치하거나 네트워크 설정을 변경하지 않는다.
- 사용자 지정에 따라 PC·Android를 v1.9.1로 발행한다. 이 버전은 v1.9.0 기능 철회의 명시적 예외이며 일반 릴리스 버전 정책은 변경하지 않는다. 기존 ADR-0317은 삭제하지 않고 대체 상태만 표시한다.

## Alternatives Considered

- 프리뷰를 기본 비활성 옵션으로 보존: 사용자 요청과 다르고 추가 코드·보안 검토 비용이 남아 기각한다.
- Tailscale 관리 기능을 앱에 추가: 별도 인증·프로세스 책임이 생기며 현재 철회 범위를 벗어나 기각한다.
- 이전 릴리스 태그를 덮어쓰기: 업데이트 전진성과 배포 이력을 훼손하므로 새 v1.9.1을 발행한다.

## Consequences

- v1.9.0의 내장 localhost 프리뷰는 더 이상 제공하지 않는다. 이전 클라이언트는 업데이트해야 하며, 서버의 보안 정책 복원만으로 이미 설치된 PC·Android 코드가 제거되지는 않는다.
- 앱과 서버의 일반 Remote/OAuth/FileViewer 회귀 테스트 및 배포 산출물·업데이트 채널을 검증한다. 저장 데이터 스키마 변경이나 마이그레이션은 없다.
- 내장 프리뷰를 다시 요구받으면 설치 없는 접속의 필요성과 보안·유지보수 비용을 먼저 검토하고 새 ADR로 결정한다.
