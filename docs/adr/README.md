# Architecture Decision Records

laymux 의 아키텍처 결정 기록. **append-only, 불변.** "왜 그렇게 정했나" 의 SoT 다.
현재 구조(살아있는 설명)는 [../architecture/](../architecture/) 를 본다 — ADR 은 결정의 *근거*만 고정하고, 코드가 지금 어떻게 생겼는지는 living doc 이 SoT.

## 작성 기준

중요한 설계 결정은 git issue/PR 설명/채팅에만 남기지 않고 ADR 로 기록한다. 구현 전에 방향을 고정해야 하는 결정이면 먼저 ADR PR 을 열고, 구현 중 새 결정이 생기면 같은 PR 에 ADR 을 포함한다.

ADR 이 필요한 대표 기준:

- Automation/Remote/API/MCP/IPC 같은 외부 계약, 인증·권한·포트·CORS·네트워크 노출 정책을 바꾸는 경우
- PTY/OSC/터미널 렌더링, CWD 동기화, 세션 영속, 설정 스키마처럼 여러 모듈의 책임 경계를 바꾸는 경우
- 상태의 단일 진실원, 락 순서, 프로세스 실행, 크로스플랫폼 전략처럼 이후 구현 방향을 제한하는 경우
- 기존 ADR 과 충돌하거나 기존 ADR 을 확장·정정·폐기해야 하는 경우

단순 버그 수정, 지역적 리팩터, 테스트 보강, 문구 수정처럼 새 아키텍처 결정을 만들지 않는 변경은 ADR 없이 living doc/코드 주석/테스트로 충분하다. 판단이 애매하면 ADR 을 쓰는 쪽을 기본값으로 한다.

| ADR | 제목 | Status |
|---|---|---|
| [0001](0001-osc-rust-single-pass.md) | OSC 처리 — Rust 단일 패스, 프론트엔드는 이벤트만 | Accepted |
| [0002](0002-automation-api-fixed-port-ip-allowlist.md) | Automation API — 고정 포트 + IP allowlist 무인증 | Accepted |
| [0003](0003-cwd-single-source-syncgroup.md) | CWD 단일 소스 + SyncGroup 전파 (백그라운드 셸 금지) | Accepted |
| [0004](0004-settings-vs-ui-state-separation.md) | settings.json(구성) vs localStorage(UI 상태) 분리 + 오버라이드 레이어 | Accepted |
| [0005](0005-display-state-raw-separation-compute.md) | 표시 상태 — 원시 상태 분리 → 단일 계산 함수 | Accepted |
| [0006](0006-embedded-mcp-server.md) | 내장 MCP 서버 (rmcp HTTP `/mcp`, 별도 바이너리 폐기) | Accepted |
| [0007](0007-pane-identifier-trio.md) | Pane 식별자 3종 분리 (terminalId / paneIndex / paneNumber) | Accepted |
| [0008](0008-shell-cursor-shadow-cursor.md) | 터미널 셸 커서/플리커 — shadow cursor 4-layer | Accepted |
| [0009](0009-process-tree-interactive-app-liveness.md) | 인터랙티브 앱 인식 — 프로세스 트리 liveness + 마운트 동기화 | Accepted |
| [0010](0010-notification-dismiss-on-program-focus-entry.md) | 알림 해제 — 사용자 입력 종류가 아닌 프로그램의 진입/포커스 동작 기준 | Accepted |
| [0011](0011-dectcem-cursor-park-fifth-layer.md) | DECTCEM 커서 주차(park) — shadow cursor 5번째 레이어 | Accepted |
| [0012](0012-focus-entry-clears-requires-action.md) | focus/진입은 requiresAction 알림도 해제 (0010 예외 조항 정정) | Accepted |
| [0013](0013-direct-remote-mode.md) | 브라우저 원격 접속 — Direct Remote Mode 와 Focused UI | Accepted |
| [0014](0014-mcp-settings-configuration.md) | MCP 설정 구성 — 에이전트가 settings 를 읽고 쓰는 경로 | Accepted |
| [0015](0015-remote-terminal-state-ownership.md) | Remote 터미널 상태 소유권 — PTY 전역 상태와 surface 로컬 상태 분리 | Accepted |
| [0016](0016-remote-access-runtime-vs-startup-enable.md) | Remote Access 활성화 — 런타임 허용과 시작 시 허용 분리 | Accepted |
| [0017](0017-mcp-dev-only-tools.md) | MCP dev 전용 툴 노출 정책 | Accepted |
| [0018](0018-remote-navigation-ui-state.md) | Remote navigation reflects UI hidden and notification state | Accepted |
| [0019](0019-remote-notification-interactions.md) | Remote notification interactions use navigation targets and bridge dismissal | Accepted |
| [0020](0020-remote-dock-terminal-navigation.md) | Remote dock terminal navigation stays separate from workspace navigation | Accepted |
| [0021](0021-remote-host-candidate-discovery.md) | Remote Host Candidate Discovery | Accepted |
| [0022](0022-cloud-connection-foundation.md) | Cloud Connection Foundation | Accepted |
| [0023](0023-cloud-pairing-loopback-oauth.md) | Cloud Pairing Loopback OAuth | Accepted |
| [0024](0024-cloud-native-wss-tunnel.md) | Cloud Native WSS Tunnel | Accepted |
| [0025](0025-dev-terminal-viewport-automation.md) | Dev terminal viewport diagnostics | Accepted |
| [0026](0026-conpty-width-resize-repaint-filter.md) | ConPTY width resize repaint filter | Accepted |
| [0027](0027-remote-connection-graceful-recovery.md) | Remote 연결 유예와 무표시 자동 복구 | Accepted |
| [0028](0028-remote-soft-key-toolbar.md) | Remote 소프트 키 툴바 (클라이언트 전용, 커스터마이저블) | Accepted |
| [0029](0029-detached-terminal-input-composer.md) | Terminal 분리 입력 컴포저 — PC와 Remote 공통 surface 모델 | Superseded by [0034](0034-single-send-terminal-composer.md) |
| [0030](0030-cloud-tunnel-follows-remote-control-gate.md) | 클라우드 터널 연결은 원격 제어 게이트를 따른다 (0024 정정) | Accepted |
| [0031](0031-extension-viewer-profile-path-conversion.md) | Extension viewer 실행 프로필과 경로 변환 책임 | Accepted |
| [0032](0032-llm-settings-introspection-and-safe-mutation.md) | LLM 설정 계약 — 자기설명·엄격 검증·민감값 보호 | Accepted |
| [0033](0033-hidden-items-shelf-set-contract.md) | 숨긴 항목 보관함 — raw 숨김 상태와 결정론적 set 계약 | Accepted |
| [0034](0034-single-send-terminal-composer.md) | Terminal composer는 Send 단일 action을 제공한다 | Accepted |
| [0035](0035-workspace-only-shelf-per-pane-hide-toggle.md) | 숨김 보관함은 workspace 전용 상단 배치, Pane 숨김은 pane 자체 토글 (0033 정정) | Accepted |
| [0036](0036-remote-composer-layout-rule.md) | Remote composer 전송 gesture는 pointer가 아니라 layout을 따른다 (0034 보완) | Accepted |
| [0037](0037-remote-lease-takeover-and-pagehide-release.md) | Remote lease는 이탈 시 beacon으로 반납하고, 재접속은 비밀 resume capability로 이어받는다 (0027 보완) | Accepted |
| [0038](0038-remote-height-shrink-surface-crop.md) | Remote 높이 축소는 surface-local crop — normal buffer rows 축소를 PTY에 전파하지 않음 (0015 확장) | Accepted |
| [0039](0039-remote-spatial-notification-step-navigation.md) | Remote 공간순서·알림순서 스텝 내비게이션은 데스크톱 프론트엔드가 계산 (0018/0019/0020/0028 확장) | Accepted |
| [0040](0040-remote-soft-key-user-order.md) | Remote 소프트 키는 사용자가 정한 순서를 유지한다 (0028 확장) | Accepted |
| [0041](0041-remote-served-file-viewer.md) | Remote FileViewer는 lease-gated API와 자격 증명 없는 새 탭으로 제공 | Superseded by [0044](0044-remote-file-viewer-explicit-host-path.md) |
| [0042](0042-remote-file-viewer-secret-capability.md) | Remote FileViewer는 lease-bound 비밀 capability로 호스트 파일을 읽음 (0041 권한·응답 정정) | Accepted |
| [0043](0043-global-terminal-ready-startup-slot.md) | 터미널 시작은 앱 전역 준비 완료 슬롯으로 직렬화한다 | Accepted |
| [0044](0044-remote-file-viewer-explicit-host-path.md) | Remote FileViewer의 호스트 경로 반영은 명시적 action으로만 수행 | Accepted |
| [0045](0045-remote-path-link-reuses-desktop-parser.md) | Remote 경로 링크는 데스크톱 파서와 CWD를 재사용해 검증한다 | Proposed |
| [0046](0046-remote-spatial-pane-exclusions.md) | Remote 공간순회 제외 상태는 Remote 클라이언트가 소유한다 | Accepted |
| [0047](0047-remote-spatial-workspace-exclusions.md) | Remote 공간순회 워크스페이스 제외와 pane↔workspace 승격/강등 | Accepted |
| [0048](0048-kill-terminals-on-exit.md) | 앱 종료 시 터미널 인터럽트(kill-on-exit)는 프론트엔드가 스크롤백 캐시 앞에서 조율 | Accepted |
| [0049](0049-git-drop-in-read-only-html-plugin-runtime.md) | Git drop-in 플러그인은 신뢰된 self-contained HTML에 read-only hook API를 제공 | Deferred |
| [0050](0050-remote-github-reference-links.md) | Remote GitHub 참조 링크는 서버 terminal CWD로 저장소를 해석 | Accepted |
| [0051](0051-terminal-capability-environment-contract.md) | PTY 자식은 laymux 터미널 정체성과 truecolor capability를 받는다 | Superseded by [0052](0052-truecolor-capability-advertising-setting.md) |
| [0052](0052-truecolor-capability-advertising-setting.md) | Truecolor capability 광고는 기본 활성화된 전역 터미널 설정으로 제어한다 | Accepted |

## 새 ADR 추가

1. `0000-template.md` 를 다음 번호로 복사 (`NNNN-kebab-case-제목.md`, 4자리 zero-pad).
2. Context / Decision / Alternatives Considered / Consequences 작성. 리뷰 중에는 Status=Proposed, 방향 승인 후 머지할 때는 Status=Accepted.
3. 이 표에 한 줄 추가.
4. PR 직전 최신 `main` 기준으로 번호 충돌 여부를 다시 확인.
5. 기존 결정을 번복하면 → 새 ADR 작성 + 옛 ADR 의 Status 만 `Superseded by [NNNN]` 로 변경 (본문은 고치지 않는다).

> 초기 ADR(0001–0008)은 구 `ARCHITECTURE.md` 와 `CLAUDE.md` 의 설계 규칙에 흩어져 있던 결정들을 이전한 것이다. 각 ADR 의 `Source` 가 원 출처를 가리킨다.
