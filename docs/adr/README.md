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
| [0026](0026-conpty-width-resize-repaint-filter.md) | ConPTY width resize repaint filter (필터 조항만 [0067](0067-bundled-conpty-output-and-staging-contract.md)이 대체) | Accepted |
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
| [0053](0053-native-windows-synchronized-output-cursor-transaction.md) | 네이티브 Windows 동기화 출력은 xterm 쓰기 경계에서 커서 복원까지 원자화한다 | Superseded by [0076](0076-codex-in-frame-cursor-park.md) |
| [0054](0054-xterm-human-and-protocol-data-origin.md) | xterm 사용자 입력과 터미널 프로토콜 응답의 출처를 분리한다 | Accepted |
| [0055](0055-composer-history-scope-setting.md) | Composer 과거 입력 recall 범위는 전역·워크스페이스·페인 중 고르는 설정 (0029/0034 확장) | Accepted |
| [0056](0056-remote-crop-window-anchors-live-tail.md) | Remote crop 창은 화면 바닥이 아니라 live tail 에 정렬 (0038 정정) | Proposed |
| [0057](0057-terminal-helper-focus-ownership.md) | 터미널 helper textarea 의 DOM focus 소유권은 앱 blur 시점 기록으로 복원 | Proposed |
| [0058](0058-single-terminal-cell-width-provider.md) | 터미널 셀 폭은 단일 Unicode/grapheme provider 가 소유하고 xterm 에 주입한다 | Proposed |
| [0059](0059-os-input-source-chord-pty-exclusion.md) | OS 입력 소스 전환 chord 는 사용자 바인딩에서만 PTY 입력에서 제외 | Proposed |
| [0060](0060-linux-ime-candidate-key-suppression.md) | Linux IME 후보 선택 키는 IME 소비 표식 + orphan companion 으로만 억제 (0053 유보 확정) | Proposed |
| [0061](0061-native-ime-candidate-anchor.md) | native IME 후보창은 두 커서가 갈릴 때만 helper 위치를 shadow cursor 앵커로 옮김 (0053 정정) | Proposed |
| [0062](0062-composition-commit-keypress-race.md) | 조합 commit 중복은 pending commit 텍스트와의 포함 판정으로만 억제 | Superseded by [0093](0093-xterm-composition-keypress-reconciliation-owner.md) |
| [0063](0063-remote-foreground-auto-reclaim.md) | Remote 재접속은 문서가 보일 때만 자동 claim (ADR-0027 마지막 항목을 이 범위로 좁힘) | Proposed |
| [0064](0064-shared-webgl-atlas-clear-fanout.md) | 공유 WebGL atlas 를 지운 쪽이 모든 터미널의 렌더 모델을 무효화 | Proposed |
| [0065](0065-dev-input-helper-out-of-process.md) | dev 전용 OS 입력 헬퍼는 앱 밖 프로세스 + lease·타깃 락 | Proposed |
| [0066](0066-bundled-conpty-runtime.md) | Windows 는 in-box conhost 대신 번들 ConPTY 런타임으로 자식을 실행 | Superseded by [0067](0067-bundled-conpty-output-and-staging-contract.md) |
| [0067](0067-bundled-conpty-output-and-staging-contract.md) | 번들 ConPTY의 출력·배치 계약을 하나로 고정 (resize repaint filter 제거) | Proposed |
| [0068](0068-remote-terminal-query-single-responder.md) | Remote 터미널 query 응답자는 PC xterm 하나로 제한한다 | Accepted |
| [0069](0069-remote-render-checkpoint-attach.md) | Remote attach는 raw tail이 아니라 xterm 화면 체크포인트에서 시작 | Accepted |
| [0070](0070-unmatched-route-boundary-ownership.md) | 합성 라우터가 미등록 경로 fallback·최외곽 CORS·경계 적용 순서를 소유 | Accepted |
| [0071](0071-pane-resize-single-boundary-owner.md) | Pane 리사이즈 판정은 경계 이동 함수 한 곳이 소유한다 (드래그·Automation 공용) | Accepted |
| [0072](0072-terminal-output-gap-sequence-exact-repair.md) | output delta 유실은 재부착이 아니라 sequence-exact 복구로 갚는다 | Accepted |
| [0073](0073-native-cursor-renderer-level-suppression.md) | 네이티브 커서 숨김은 렌더러 게이트에서 한다 (배경색 위장·옵션 경합 폐기) | Accepted |
| [0074](0074-xterm-cell-grid-screen-test-tier.md) | 실제 xterm 화면 의미는 별도 `*.screen.test.ts` 스위트에서 검증한다 | Accepted |
| [0075](0075-session-restore-live-screen-origin.md) | 세션 복원 출력은 새 PTY 화면 원점 뒤의 scrollback으로 둔다 | Accepted |
| [0076](0076-codex-in-frame-cursor-park.md) | Codex 인프레임 커서 주차를 동기화 출력의 최종 상태로 인정 | Accepted |
| [0077](0077-remote-terminal-font-serving.md) | Remote 터미널 폰트는 데스크톱 시스템 폰트를 sfnt 그대로 서빙한다 (woff2 변환 없음, 기본 off) | Accepted |
| [0078](0078-wsl-in-frame-cursor-park-metadata.md) | WSL 인프레임 커서 주차는 바이트 보류 없이 reset 메타데이터로 전달 | Accepted |
| [0079](0079-dec2026-cursor-gate-lifecycle-bypass.md) | DEC 2026 커서는 renderer lifecycle 우회까지 raw gate로 막는다 | Accepted |
| [0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md) | 스트림 의미는 원래 경계에서 처리하고 xterm 물리 쓰기만 제한적으로 묶는다 | Accepted |
| [0081](0081-pane-focus-transition-single-owner.md) | Pane 포커스 전환은 단일 도메인 액션이 소유한다 | Accepted |
| [0082](0082-terminal-helper-ime-focus-refresh.md) | 앱 복귀 시 DOM-active xterm helper 는 blur/focus 로 IME 문맥을 재활성화 (0057 확장) | Superseded by [0108](0108-windows-ime-editable-focus-relay.md) |
| [0083](0083-automation-health-instance-identity.md) | Automation health는 프로세스·빌드 신원을 함께 공개한다 | Accepted |
| [0084](0084-desktop-terminal-output-parsed-credit.md) | desktop output은 parsed ACK credit으로 PTY producer를 유한하게 제한한다 (0072 일부 대체·0080 확장) | Accepted |
| [0085](0085-provenance-barrier-three-phase-geometry-cutover.md) | PTY geometry cutover는 provenance barrier와 three-phase transaction이 소유 | Accepted |
| [0086](0086-terminal-output-control-epoch-watchdog.md) | terminal output attach·ACK IPC는 epoch watchdog으로 stale lease를 유한하게 교체한다 (0084 확장) | Accepted |
| [0087](0087-mutex-poison-fail-closed-discard-only.md) | Mutex poison은 기본 fail-closed이며 폐기 전용 close만 guard를 회수한다 (0084 확장) | Accepted |
| [0088](0088-pty-output-fatal-generation-teardown.md) | PTY output fatal은 reader를 멈추고 해당 generation을 비동기 teardown한다 (0084 확장) | Accepted |
| [0089](0089-interruptible-pty-reader-is-not-provenance.md) | Interruptible PTY reader는 liveness만 소유하고 exact provenance는 외부 primitive까지 fail-closed | Accepted |
| [0090](0090-linux-native-dialog-gtk3-backend.md) | Linux 네이티브 대화상자는 기존 Tauri GTK3 런타임을 재사용 | Accepted |
| [0091](0091-remote-client-standalone-web-app-manifest.md) | Remote 클라이언트는 gate 안쪽 web app manifest로 standalone 설치를 지원한다 | Accepted |
| [0092](0092-app-wide-terminal-write-round-robin.md) | 데스크톱 xterm physical write는 앱 전역 round-robin으로 진입 | Accepted |
| [0093](0093-xterm-composition-keypress-reconciliation-owner.md) | 조합 commit 관측은 xterm CompositionHelper의 세대별 큐가 소유 | Accepted |
| [0094](0094-terminal-output-control-capacity-admission.md) | 관측된 ACK 용량 경쟁은 화면을 폐기하지 않는 FIFO admission | Accepted |
| [0095](0095-terminal-output-bounded-envelope-and-frame-continuation.md) | desktop output은 bounded envelope와 frame continuation credit을 분리 | Accepted |
| [0096](0096-terminal-human-input-write-failure-observability.md) | 터미널 인간 입력 IPC 실패는 정확히 한 번 기록하고 재전송하지 않는다 | Proposed |
| [0097](0097-transport-lossless-presentation-lossy-ownership.md) | terminal output은 transport lossless·presentation lossy 계층 계약으로 분리한다 | Proposed |
| [0098](0098-terminal-parser-weighted-starvation-free-admission.md) | 데스크톱 terminal parser는 가시성 가중치로 starvation 없이 진입한다 (0092 확장) | Proposed |
| [0099](0099-remote-client-install-affordance-in-drawer.md) | Remote 클라이언트의 설치 권유는 내비게이션 드로어의 버튼 하나로만 한다 (0091 적용) | Accepted |
| [0100](0100-path-link-host-os-open-modifier-contract.md) | path-link 의 OS 열기는 호스트 맥락에서 Ctrl 계열 수정자와 확인 게이트로 수행한다 (#352 수정자 소유권 정정, 0045 경계 유지) | Accepted |
| [0101](0101-active-workspace-weighted-parser-admission.md) | parser admission 은 pane 가중치가 아니라 클래스 몫으로 나누고 그 몫은 설정값이다 (0098 가중치·aging·설정 노출 정정) | Accepted |
| [0102](0102-claude-usage-probe-headless-pty.md) | Claude 사용량은 레지스트리 밖 headless probe PTY 가 소유한다 | Proposed |
| [0103](0103-usage-view-visible-rows.md) | UsageView 표시 행은 전역 사용량 설정이 소유한다 | Accepted |
| [0104](0104-codex-usage-app-server-probe.md) | Codex 사용량은 app-server rate-limit API로 수집한다 | Accepted |
| [0105](0105-widget-slots-and-status-line.md) | 위젯 배치는 설정의 슬롯 배열이 소유하고 status line 은 슬롯 영역 하나일 뿐이다 | Accepted |
| [0106](0106-github-list-view-repo-registry.md) | GitHub 이슈/PR 목록은 repo 단위 레지스트리가 소유한다 | Proposed |
| [0107](0107-widget-typography-and-usage-bar-width.md) | 위젯 글꼴은 전역 표시 설정이, 사용량 막대 너비는 인스턴스 옵션이 소유한다 | Accepted |
| [0108](0108-windows-ime-editable-focus-relay.md) | Windows IME 복구는 별도 editable focus relay 문맥을 경유한다 (0082 대체) | Proposed |
| [0109](0109-file-viewer-typed-preview-renderers.md) | 파일 뷰어 preview 는 타입별 렌더러로 갈라지고 신뢰 경계가 렌더 방식을 정한다 | Proposed |
| [0110](0110-github-snapshot-stale-while-revalidate.md) | GitHub 스냅샷은 만료돼도 마지막으로 알던 목록을 먼저 내려준다 (0106 확장) | Proposed |
| [0111](0111-github-view-display-settings.md) | GitHubView 행 표시는 전역 `settings.github` 이 소유하고, 색은 이름으로만 받는다 (0107 적용) | Proposed |
| [0112](0112-hex-color-code-authoring.md) | 손으로 적는 색상은 hex 색상 코드(`#rrggbb`/`#rrggbbaa`)로만 표기한다 | Accepted |
| [0113](0113-workspace-clear-activity-owned.md) | 워크스페이스 클리어는 activity handler 가 클리어 방법을 소유하고, 모르는 앱은 건드리지 않는다 | Superseded by 0137 |
| [0114](0114-sleep-prevention-mode.md) | 절전 방지는 설정이 모드를 소유하고 OS 억제는 Rust 단일 지점이 건다 (0116 이 모드 부분 정정) | Proposed |
| [0115](0115-github-view-tab-per-pane-state.md) | GitHubView 의 Issues/PRs 탭은 pane 인스턴스 UI 상태이고 `defaultTab` 은 씨앗일 뿐이다 (0111 후속) | Proposed |
| [0116](0116-sleep-prevention-two-axes.md) | 절전 방지는 수동 스위치와 자동 정책 두 축이고 상단 바 버튼은 수동 축만 표시한다 (0114 정정) | Proposed |
| [0117](0117-codex-session-restore.md) | Codex CLI 세션은 최상위 rollout과 terminal CWD를 연결해 안전한 resume 명령으로 복원 | Superseded by 0118 |
| [0118](0118-codex-session-pid-attribution.md) | Codex 세션은 PTY 자식 PID와 Codex 진단 DB가 함께 증명한 thread로만 복원 | Accepted |
| [0119](0119-settings-type-error-partial-recovery.md) | settings.json 타입 오류는 경로 단위로 드롭해 부분 복구하고, 확인 전까지 파일에 쓰지 않는다 | Proposed |
| [0120](0120-wsl-agent-session-attribution.md) | WSL agent 세션은 distro 내부 terminal 환경 marker와 Linux PID로만 정확히 귀속 | Accepted |
| [0121](0121-single-pane-clear-user-pointed-scope.md) | 단일 pane 클리어는 사용자가 가리킨 pane 하나를 범위로 삼고, dock 을 포함한다 | Superseded by 0137 |
| [0122](0122-terminal-output-server-delivery-expiry.md) | backend receipt·continuation grant expiry는 최장 직렬 복구 경로를 덮는 30초다 | Superseded by ADR-0126 |
| [0123](0123-top-bar-window-controls-outrank-everything.md) | 상단 바에서 창 버튼(최소화·최대화·닫기)은 다른 모든 점유자보다 우선한다 | Accepted |
| [0124](0124-remote-widget-strip-mirrors-desktop.md) | 원격 위젯은 데스크톱 배치의 미러이며 표면은 한 줄 스트립 하나다 (0105 확장) | Accepted |
| [0125](0125-configurable-agent-launch-command.md) | 에이전트 실행 명령은 설정이 소유하고, 복원 override 는 그 설정에서 재도출한다 (0117 확장) | Accepted |
| [0126](0126-terminal-output-repair-timeout-budget.md) | repair watchdog은 15초, backend delivery expiry는 40초로 독립시킨다 | Accepted |
| [0127](0127-terminal-startup-slot-follows-eligibility.md) | 준비 전 terminal startup slot은 현재 eligibility를 따라가며 숨은 owner를 고착하지 않는다 | Accepted |
| [0128](0128-app-global-remote-control-status-coordinator.md) | Remote control listener·snapshot·polling은 desktop window 전역 coordinator 하나가 소유한다 | Accepted |
| [0129](0129-remote-chrome-row-rebases-fit-baseline.md) | 원격 chrome 행의 등장·소멸은 crop 이 아니라 fit 기준선 재설정이다 (0038 정정) | Accepted |
| [0130](0130-spawn-time-cwd-seed.md) | 세션 CWD 는 스폰 시점 시작 디렉터리로 시딩한다 (0003 확장) | Accepted |
| [0131](0131-native-windows-codex-startup-color-reply-guard.md) | 네이티브 Windows Codex 복귀의 최초 색상 응답은 질의 관측에 결합해 차단한다 (0001·0054·0118·0125 확장) | Accepted |
| [0132](0132-remote-widget-strip-device-local-toggle.md) | 원격 위젯 스트립의 표시는 호스트 게이트와 기기-로컬 토글의 논리곱이다 (0124 확장) | Accepted |
| [0133](0133-remote-attach-publishes-one-pty-geometry.md) | Remote attach 는 PTY geometry 를 한 번만 게시한다 (0129 정정) | Accepted |
| [0134](0134-wsl-guest-interactive-app-liveness.md) | WSL pane 의 인터랙티브 앱 liveness 는 게스트 프로브가 권위 (0009 확장·정정) | Accepted |
| [0135](0135-activity-reconcile-backend-diff-push.md) | Activity 는 백엔드가 주기적으로 재판정해 변경분만 push (0009 확장, 0134 관측 게이팅 정정) | Accepted |
| [0136](0136-activity-derivation-stamp-and-scoped-exit.md) | Activity 는 파생 시점 stamp 로 순서화하고 종료 정리는 종료한 앱에만 적용 (0135 4·4-1·4-2 정정) | Accepted |
| [0137](0137-workspace-clear-ctrl-l-broadcast.md) | 워크스페이스 클리어는 activity 판정 없이 Ctrl+L 브로드캐스트로 단순화하고, 단일 pane 클리어는 폐지한다 (0113/0121 대체) | Accepted (partially superseded by 0158) |
| [0138](0138-remote-opens-queued-panes-on-entry.md) | Remote 진입은 아직 열리지 않은 pane 을 focus 로 직접 열고 세션이 생기면 attach 한다 (0039 원칙 확장) | Accepted |
| [0139](0139-cloud-tunnel-tailscale-route-advertisement-and-direct-gate.md) | 클라우드 터널은 Tailscale 직접 경로를 광고하고 Direct Remote는 Tailscale 전용 게이트를 제공한다 (0013·0021·0024 확장) | Accepted |
| [0140](0140-split-pane-inherits-source-cwd.md) | 분할로 생긴 pane 은 분할한 그 pane 의 CWD 에서 첫 세션을 시작한다 (0003·0130 확장) | Accepted |
| [0141](0141-conpty-bootstrap-da-reply.md) | ConPTY 초기 DA 응답은 질의가 증명된 replay 예외로 전달한다 (0054·0068 확장) | Accepted |
| [0142](0142-wheel-scroll-sensitivity-per-surface.md) | 휠 스크롤 민감도는 데스크톱·Remote 표면별로 따로 소유한다 | Accepted |
| [0143](0143-parsed-ack-timeout-in-place-retry.md) | v3 parsed ACK timeout 은 교체 없이 제자리 재시도한다 (0095 Amend) | Accepted |
| [0144](0144-android-signed-hybrid-client-e2e-foundation.md) | Android E2E 기반은 서명된 로컬 웹 클라이언트와 네이티브 키 경계를 사용한다 (Remote UI 소유 결정은 0149가 대체) | Accepted (partially superseded by 0149) |
| [0145](0145-android-pairing-authenticated-one-time-ack.md) | Android 페어링은 만료되는 QR v2와 상호 HMAC ACK로 확정한다 (0024·0030·0144 확장) | Accepted |
| [0146](0146-android-e2e-session-and-encrypted-remote-rpc.md) | Android 데이터 평면은 생체 승인 세션과 순차 AEAD RPC를 사용한다 (APK UI는 0149, output polling은 0159가 대체) | Accepted (partially superseded by 0149·0159) |
| [0147](0147-output-volume-activity-and-app-declared-idle.md) | 출력 볼륨을 앱 협조 없는 활성 신호로 인정하고, 앱이 선언한 유휴는 추론된 활성을 이긴다 (0005 §outputActive 규칙 정정) | Accepted |
| [0148](0148-bounded-multi-path-selection-links.md) | 선택 경로 링크는 bounded maximal-munch 복수 후보를 사용한다 (0045 확장) | Accepted |
| [0149](0149-android-thin-wrapper-runs-desktop-owned-remote-ui.md) | Android는 Cloud 계정 표면과 PC 소유 Remote UI를 분리하는 얇은 E2E wrapper다 (0144·0146 일부 대체) | Accepted |
| [0150](0150-desktop-owned-cloud-remote-access-policy.md) | Cloud Remote 접속 정책은 PC Laymux가 소유하고 터널 입구에서 강제한다 (0024·0149 확장, E2E output WS는 0159가 확장) | Accepted (partially superseded by 0159) |
| [0151](0151-remote-workspace-selector-information-parity.md) | Remote 워크스페이스 목록은 PC selector의 표시 모델을 계속 미러한다 (0018·0020·0039·0047 일부 정정) | Accepted |
| [0152](0152-android-cross-store-signing-and-release.md) | Android 앱 서명 키는 GitHub와 Play 배포에서 공유하고 업로드 키만 분리한다 (0144·0149 확장) | Accepted |
| [0153](0153-remote-hidden-item-visibility-controls.md) | Remote 숨김 항목 편집은 PC 상태 소유자를 재사용한다 (0033·0035·0151 확장) | Accepted |
| [0154](0154-android-multi-instance-pairing-vault.md) | Android pairing vault는 instance별 레코드와 정책별 공유 wrapping key를 사용한다 (0149 정정, 0145·0146 확장) | Accepted |
| [0155](0155-android-background-remote-lease-grace.md) | Android E2E Remote의 설정 가능한 백그라운드 controller lease 유예 | Proposed |
| [0156](0156-grok-first-class-agent.md) | Grok Build는 Claude·Codex와 같은 1급 에이전트다 (0009·0102·0104·0118·0120·0125·0134·0147 확장) | Accepted |
| [0157](0157-android-pairing-sheet-over-live-cloud-webview.md) | Android pairing sheet는 비활성 Cloud WebView 위의 secure overlay다 (0149 확장) | Accepted |
| [0158](0158-activity-aware-single-pane-clear.md) | 단일 pane 실제 클리어는 activity handler가 소유하고 Alt+L로 실행한다 (0137 일부 대체, 0113·0121 재적용) | Accepted |
| [0159](0159-android-e2e-websocket-output-transport.md) | Android E2E 터미널 출력은 스트림별 AEAD WebSocket으로 전송한다 (0146·0150 일부 대체, 0149 확장) | Accepted |
| [0160](0160-android-e2e-tailscale-direct-transport.md) | Android E2E는 Tailscale Direct를 우선 전송 경로로 사용한다 (0139·0146·0149·0159 확장) | Proposed |
| [0161](0161-rendererless-terminal-session-startup.md) | terminal host가 0폭이어도 PTY·rendererless output surface를 시작하고 DOM renderer만 양의 크기를 기다린다 (0043·0127·0138 확장) | Accepted |
| [0162](0162-android-remote-link-opens-os-browser.md) | Android Remote의 터미널 링크는 native bridge를 통해 OS 브라우저로 연다 (0149 확장) | Accepted |

> **번호 계보:** PR #668이 ADR-0093을 `main`의 `d8e43df`로 병합했으며, 이 브랜치는 그 최신 `main`에 rebase해 ADR-0093/0094/0095의 번호 연속성과 충돌 부재를 다시 확인했다. ADR-0094는 미게시 로컬 `fix/659` 브랜치의 Proposed ADR-0094가 기록한 관측된 ACK 결정을 흡수·대체하며, ADR-0095는 미게시 로컬 `fix/661-output-ingress-bound` HEAD `7c47ac4`의 Proposed ADR-0093이 기록한 bounded envelope 결정을 흡수·대체한다. 두 donor 문서는 게시·병합·cherry-pick하지 않고 이 브랜치의 0094/0095만 각 결정의 단일 정본으로 사용한다.

## 새 ADR 추가

1. `0000-template.md` 를 다음 번호로 복사 (`NNNN-kebab-case-제목.md`, 4자리 zero-pad).
2. Context / Decision / Alternatives Considered / Consequences 작성. 리뷰 중에는 Status=Proposed, 방향 승인 후 머지할 때는 Status=Accepted.
3. 이 표에 한 줄 추가.
4. PR 직전 최신 `main` 기준으로 번호 충돌 여부를 다시 확인.
5. 기존 결정을 번복하면 → 새 ADR 작성 + 옛 ADR 의 Status 만 `Superseded by [NNNN]` 로 변경 (본문은 고치지 않는다).

> 초기 ADR(0001–0008)은 구 `ARCHITECTURE.md` 와 `CLAUDE.md` 의 설계 규칙에 흩어져 있던 결정들을 이전한 것이다. 각 ADR 의 `Source` 가 원 출처를 가리킨다.
