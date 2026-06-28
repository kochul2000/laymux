# 0013. 브라우저 원격 접속 — Direct Remote Mode 와 Focused UI

- Status: Accepted
- Date: 2026-06-28
- Source: 사용자 요구(브라우저에서 Tailscale 경유 laymux 접속, 추후 서버 경유 접속 고려) · architecture/api-contracts.md §12 · ADR-0002

## Context

laymux 는 Tauri WebView 안에서 React UI 가 `@tauri-apps/api` IPC 로 Rust 백엔드와 통신하는 데스크톱 앱이다. 단순히 Vite/정적 UI 를 Tailscale IP 로 노출하면 브라우저는 HTML/JS/CSS 를 받을 수 있지만, 일반 브라우저에는 Tauri IPC 가 없으므로 터미널 생성, PTY 입출력, 파일 접근, 설정 저장 같은 핵심 기능이 동작하지 않는다.

사용자 목표는 단기적으로 Tailscale 에 연결된 장치의 브라우저에서 laymux 를 여는 것이고, 장기적으로는 우리 서버를 경유한 접속도 고려한다. 두 목표는 "브라우저 UI 가 원격 백엔드와 안전하게 통신한다"는 같은 기반을 공유하지만, 연결 경로가 다르다.

원격 접속의 목적은 다중 클라이언트가 동시에 같은 워크스페이스를 편집하도록 동기화하는 것이 아니다. PC 에 이미 열린 pane/session 을 원격 브라우저가 잠시 가져가 제어하면 충분하다. 원격 클라이언트가 연결된 동안 PC UI 는 입력을 중지하고, PC 사용자는 더 높은 권한으로 언제든 제어권을 회수할 수 있어야 한다.

원격 UI 도 별도 제품이 아니다. laymux 는 같은 React 코드베이스 안에 기존 전체 레이아웃 UI 와 pane 하나에 집중하는 UI 를 함께 둔다. 좁은 화면에서는 pane 하나를 크게 열고 workspace/pane/dock 요약으로 전환하는 편의 UI 가 기본이 될 수 있지만, 이 UI 는 "모바일 전용"이 아니라 PC 에서도 쓸 수 있는 **Focused UI** 다. 기존 그리드/독 전체 화면은 **Full UI** 로 유지하며 두 UI 는 전환 가능해야 한다.

기존 Automation API 는 외부 도구와 자율 검증 루프를 위한 제어면이다. 이 API 는 고정 포트, IP allowlist, 무인증 모델을 따른다([ADR-0002](0002-automation-api-fixed-port-ip-allowlist.md)). 터미널 IDE 전체를 사용자가 브라우저에서 조작하는 원격 UI 경로는 세션, 인증, 지속 스트리밍, Origin/CORS, 권한 경계가 다르므로 Automation API 를 그대로 확장해 Tailscale 대역에 여는 방식은 장기 구조와 맞지 않는다.

## Decision

브라우저 원격 접속은 **Direct Remote Mode** 로 설계한다. 첫 구현 대상은 Tailscale 직결 접속이지만, API/클라이언트 경계는 추후 relay 서버 경유 접속에도 재사용 가능해야 한다.

- 같은 React HTML/JS bundle 을 Tauri WebView 와 원격 브라우저 양쪽에서 사용한다. UI 는 **Full UI**(기존 workspace/grid/dock 전체 레이아웃)와 **Focused UI**(workspace/pane/dock 요약 + 단일 pane 제어)를 전환 가능한 앱 모드로 가진다.
- Tauri WebView 모드와 브라우저 원격 모드는 client adapter 경계에서 분리한다. 기존 데스크톱 모드는 `@tauri-apps/api` IPC 를 계속 사용하고, 브라우저 모드는 remote client 어댑터를 통해 HTTP/WebSocket 백엔드와 통신한다.
- 사용자용 원격 UI API 는 Automation API/MCP 와 분리된 경계로 둔다. 같은 axum 프로세스에 올라갈 수는 있지만, route namespace, 인증, 세션, CORS/Origin 정책은 별도로 가진다.
- 원격 제어는 다중 클라이언트 동기화가 아니라 **exclusive controller lease** 로 처리한다. remote 가 lease 를 claim 하면 PC UI 는 "remote controlling" 상태로 전환해 로컬 키보드/마우스 입력을 막고, PC 사용자는 언제든 lease 를 회수한다. remote disconnect/heartbeat timeout 시 local control 로 복귀한다.
- 원격 클라이언트는 PC 에 이미 열린 pane/session 을 제어한다. remote 연결이 기존 PTY 를 죽이거나 새 SoT 를 만들지 않으며, PC WebView 는 살아 있는 상태로 브릿지와 표시 상태를 유지한다.
- PTY 출력과 이벤트는 WebSocket 기반 스트림을 표준 경로로 둔다. HTTP 는 초기 상태 조회, remote lease claim/release/heartbeat, workspace/pane/dock 메타데이터, 터미널 write/resize 같은 요청/응답 작업에 사용한다.
- Focused UI 의 원격 계약은 "전체 레이아웃 복제"가 아니라 navigation metadata 와 single pane control 을 분리한다. metadata 는 workspaces, active workspace, pane id/number/title/cwd/activity/profile, dock position/visible/active view summary 를 제공하고, control 은 선택된 terminal 의 output/write/resize/attach/detach 를 제공한다.
- Direct Remote Mode 는 명시적 opt-in 설정이다. 기본값은 꺼짐이며, 활성화 시 bind address, allowed origins, allowed IPs/Tailnet, 토큰 또는 세션 인증을 설정으로 제어한다.
- Tailscale 은 첫 transport 로 취급한다. Tailscale IP allowlist 만으로 권한을 끝내지 않고, 원격 UI 세션 인증을 둔다.
- 추후 서버 경유 접속은 같은 browser remote client 와 remote API 계약을 사용하고, transport 만 "direct peer" 에서 "relay tunnel" 로 바꾼다.

## Consequences

- 단기 Tailscale 작업은 장기 relay 접속의 기초가 된다. UI 의 remote client, Rust 의 HTTP/WebSocket remote API, PTY 스트리밍 계약, 세션/권한 모델은 그대로 재사용한다.
- 기존 Automation API 는 자동화/검증용으로 유지한다. Tailscale 브라우저 접속을 위해 Automation API allowlist 를 넓히는 방식은 피한다.
- remote mode 는 로컬 IPC 가 아니라 원격 제어면이다. 터미널 입력, 파일 읽기, 설정 변경, 클립보드/외부 앱 열기 같은 위험 작업은 명시적으로 권한 경계 안에 있어야 한다.
- 브라우저 원격 UI 에서 필요한 기능은 Tauri IPC 함수를 직접 호출하지 않고 추상화된 client 인터페이스를 통과해야 한다. 이 리팩터링은 데스크톱 모드 동작을 보존하면서 점진적으로 진행한다.
- 다중 클라이언트 간 레이아웃/스토어 동기화는 이 결정의 목표가 아니다. remote 활성 중 PC 는 입력이 막힌 관찰/회수 화면이 되고, 제어권은 한 번에 하나의 클라이언트만 가진다.
- Focused UI 는 원격 전용 코드가 아니라 제품의 정식 UI 모드다. PC 에서도 사용할 수 있어야 하며, 화면 폭에 따른 기본 모드 선택은 가능하지만 사용자는 Full UI 와 Focused UI 사이를 전환할 수 있어야 한다.
- 같은 HTML bundle 을 원격으로 서빙하려면 Tauri IPC 직접 의존을 줄이고, `TauriIpcClient` 와 `RemoteHttpWsClient` 같은 client adapter 구조가 필요하다.
- relay 서버 설계 시 서버는 인터넷 인증과 세션 라우팅을 담당하고, 로컬 laymux 는 인증된 agent/backend 로 터널을 맺는다. 이때 브라우저와 laymux 사이의 상위 API 계약은 Direct Remote Mode 와 동일하게 유지한다.
