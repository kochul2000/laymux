# 0013. 브라우저 원격 접속 — Direct Remote Mode 우선

- Status: Accepted
- Date: 2026-06-28
- Source: 사용자 요구(브라우저에서 Tailscale 경유 laymux 접속, 추후 서버 경유 접속 고려) · architecture/api-contracts.md §12 · ADR-0002

## Context

laymux 는 Tauri WebView 안에서 React UI 가 `@tauri-apps/api` IPC 로 Rust 백엔드와 통신하는 데스크톱 앱이다. 단순히 Vite/정적 UI 를 Tailscale IP 로 노출하면 브라우저는 HTML/JS/CSS 를 받을 수 있지만, 일반 브라우저에는 Tauri IPC 가 없으므로 터미널 생성, PTY 입출력, 파일 접근, 설정 저장 같은 핵심 기능이 동작하지 않는다.

사용자 목표는 단기적으로 Tailscale 에 연결된 장치의 브라우저에서 laymux 를 여는 것이고, 장기적으로는 우리 서버를 경유한 접속도 고려한다. 두 목표는 "브라우저 UI 가 원격 백엔드와 안전하게 통신한다"는 같은 기반을 공유하지만, 연결 경로가 다르다.

기존 Automation API 는 외부 도구와 자율 검증 루프를 위한 제어면이다. 이 API 는 고정 포트, IP allowlist, 무인증 모델을 따른다([ADR-0002](0002-automation-api-fixed-port-ip-allowlist.md)). 터미널 IDE 전체를 사용자가 브라우저에서 조작하는 원격 UI 경로는 세션, 인증, 지속 스트리밍, Origin/CORS, 권한 경계가 다르므로 Automation API 를 그대로 확장해 Tailscale 대역에 여는 방식은 장기 구조와 맞지 않는다.

## Decision

브라우저 원격 접속은 **Direct Remote Mode** 로 설계한다. 첫 구현 대상은 Tailscale 직결 접속이지만, API/클라이언트 경계는 추후 relay 서버 경유 접속에도 재사용 가능해야 한다.

- Tauri WebView 모드와 브라우저 원격 모드를 분리한다. 기존 데스크톱 모드는 `@tauri-apps/api` IPC 를 계속 사용하고, 브라우저 모드는 remote client 어댑터를 통해 HTTP/WebSocket 백엔드와 통신한다.
- 사용자용 원격 UI API 는 Automation API/MCP 와 분리된 경계로 둔다. 같은 axum 프로세스에 올라갈 수는 있지만, route namespace, 인증, 세션, CORS/Origin 정책은 별도로 가진다.
- PTY 출력과 이벤트는 WebSocket 기반 스트림을 표준 경로로 둔다. HTTP 는 초기 상태 조회, 설정, 파일/워크스페이스 조작 같은 요청/응답 작업에 사용한다.
- Direct Remote Mode 는 명시적 opt-in 설정이다. 기본값은 꺼짐이며, 활성화 시 bind address, allowed origins, allowed IPs/Tailnet, 토큰 또는 세션 인증을 설정으로 제어한다.
- Tailscale 은 첫 transport 로 취급한다. Tailscale IP allowlist 만으로 권한을 끝내지 않고, 원격 UI 세션 인증을 둔다.
- 추후 서버 경유 접속은 같은 browser remote client 와 remote API 계약을 사용하고, transport 만 "direct peer" 에서 "relay tunnel" 로 바꾼다.

## Consequences

- 단기 Tailscale 작업은 장기 relay 접속의 기초가 된다. UI 의 remote client, Rust 의 HTTP/WebSocket remote API, PTY 스트리밍 계약, 세션/권한 모델은 그대로 재사용한다.
- 기존 Automation API 는 자동화/검증용으로 유지한다. Tailscale 브라우저 접속을 위해 Automation API allowlist 를 넓히는 방식은 피한다.
- remote mode 는 로컬 IPC 가 아니라 원격 제어면이다. 터미널 입력, 파일 읽기, 설정 변경, 클립보드/외부 앱 열기 같은 위험 작업은 명시적으로 권한 경계 안에 있어야 한다.
- 브라우저 원격 UI 에서 필요한 기능은 Tauri IPC 함수를 직접 호출하지 않고 추상화된 client 인터페이스를 통과해야 한다. 이 리팩터링은 데스크톱 모드 동작을 보존하면서 점진적으로 진행한다.
- relay 서버 설계 시 서버는 인터넷 인증과 세션 라우팅을 담당하고, 로컬 laymux 는 인증된 agent/backend 로 터널을 맺는다. 이때 브라우저와 laymux 사이의 상위 API 계약은 Direct Remote Mode 와 동일하게 유지한다.
