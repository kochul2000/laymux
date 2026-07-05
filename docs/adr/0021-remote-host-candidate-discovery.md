# 0021. Remote Host Candidate Discovery

- Status: Accepted
- Date: 2026-07-05
- Source: approved implementation plan `glistening-roaming-stardust.md`; architecture/api-contracts.md §10

## Context

Remote Access 모달은 복사 URL의 host 자리에 `<laymux-host>` 플레이스홀더를 넣었다. 사용자는 Tailscale IP, LAN IP, localhost, 수동 DNS 이름 중 실제 접속 경로를 알고도 매번 복사 후 URL을 고쳐야 했다. 동시에 host 후보는 실행 환경의 네트워크 interface와 Tailscale 설치 여부에 따라 달라지므로 프론트엔드 상수로 고정할 수 없다.

Remote URL host 후보는 편의 기능이지만, Automation/Remote/IPC 표면과 크로스플랫폼 네트워크 탐색 전략을 새로 정하므로 ADR로 남긴다.

## Decision

Remote Access URL host 후보는 Tauri IPC command `get_remote_host_candidates` 로 감지하고, 프론트엔드가 `settings.remote.customHosts` 와 병합한다.

- IPC command는 감지 후보만 반환한다. 반환 항목은 `{ kind, host, label }` 이며 `kind` 는 `loopback | tailscale | lan` 이다.
- `127.0.0.1` loopback 후보는 항상 포함한다.
- Tailscale 후보는 `crate::process::headless_command("tailscale").args(["ip", "-4" | "-6"])` 로 조회한다. CLI가 없거나 실패하거나 빈 출력이면 조용히 제외한다.
- LAN 후보는 `if-addrs` 로 interface 주소를 열거하고 loopback/link-local/unspecified/multicast 주소를 제외한다. IPv4 후보를 IPv6 후보보다 먼저 둔다.
- 중복 host 는 앞선 후보를 유지한다.
- 수동 host 목록과 기본 host 는 `settings.remote.customHosts` / `settings.remote.preferredHost` 로 저장한다. 프론트엔드는 감지 후보와 수동 host 를 병합하고, 기본 host 가 유효하면 URL selector 초기값으로 선택한다.

## Consequences

- URL 복사 UX는 실제 접속 가능한 host 를 선택하는 방식으로 바뀌지만, 접속 보안 경계는 변하지 않는다. Remote 접속 허용은 계속 IP allowlist, bearer token, Origin 정책이 결정한다.
- Tailscale 설치 여부나 권한 문제는 사용자에게 오류로 노출하지 않고 후보 누락으로만 표현한다.
- LAN 탐색은 Rust 백엔드 책임이다. 프론트엔드는 browser/network API 추측 대신 구조화된 IPC 결과와 settings 의 수동 host 목록만 조합한다.
- 수동 host 는 감지 실패나 DNS 이름 사용을 보완하지만, 포트와 스킴은 laymux Remote 계약의 고정 URL builder가 붙인다.
