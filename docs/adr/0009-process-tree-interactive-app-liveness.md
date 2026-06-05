# 0009. 인터랙티브 앱 인식의 권위 — 프로세스 트리 liveness + 마운트 동기화

- Status: Accepted
- Date: 2026-06-04
- Source: architecture/data-flow.md §8 · §9, ADR-0005, issue #234 · #237 · #239, PR #242

## Context

Claude Code·Codex 같은 인터랙티브 앱의 인식은 그동안 **두 휘발성 신호**에만 의존했다.

1. **리터럴 배너** — OSC 0/2 타이틀 또는 출력 본문의 `"Claude Code"` / `"OpenAI Codex"` 문자열. 단 이는 버퍼의 최근 16KB(`ACTIVITY_SCAN_BYTES`)에서만 스캔되고, 작업 중 타이틀은 스피너뿐이라 세션 시작 후 다시 등장하지 않는다.
2. **인메모리 캐시** — `known_{claude,codex}_terminals` + 5초 grace window. 백엔드 프로세스 수명 동안만 유지되고, 모호한 타이틀에 의해 무효화된다.

이 구조에서 두 가지 재현성 높은 실패가 있었다.

- **대화가 길어지면**: 시작 배너가 16KB 창 밖으로 밀려난 뒤, `process_claude_title`이 `was_detected && !is_claude_title(title)` 를 **"앱 종료"로 오판**한다. 작업 중 끼어드는 비-스피너 타이틀(서브프로세스 OSC, 컴팩션 등) 한 번이면 `claude_detected`·캐시·grace window가 전부 클리어되고 `interactiveAppExited` 가 프론트의 보존 가드까지 무력화한다. 복구는 리터럴 배너(=idle `✳ Claude Code`)가 다시 떠야만 가능하다.
- **resume(webview 리로드) 복원**: 백엔드 `AppState`(캐시·버퍼·PTY)는 리로드에도 살아남지만, 프론트 활동 스토어는 초기화되고 **마운트 시 백엔드 현재 상태를 조회하는 경로가 없다**. 살아있는 앱이 다음 라이브 이벤트 전까지 shell 로 표시된다.

grace window·exit marker·preservation guard 등 누적된 패치는 모두 이 휘발성 신호 위의 증상 완화였고, "타이틀이 앱처럼 안 생기면 종료"라는 근본 오판은 남아 있었다.

관찰: 앱이 실제로 살아있는지는 **PTY 자식 프로세스 트리**가 권위 있게 답한다. Windows 에서 Claude 는 `claude.exe`, Codex 는 `codex.exe` 로 자식 트리에 존재하므로 실행 파일 이름만으로 모호함 없이 식별된다(명령행 introspection 불필요).

## Decision

**인터랙티브 앱의 "살아있는가" 판정 권위를 PTY 자식 프로세스 트리 liveness 로 옮긴다.** 타이틀/버퍼 신호는 앱 식별·작업/유휴 상태·메시지 추출의 보조로 남기되, 캐시 무효화와 종료 단정의 **최종 권위는 프로세스 트리**가 갖는다.

- 프로세스 트리 스캔은 PTY `child_pid` 의 자손 PID 집합에서 `claude.exe`/`codex.exe`(Linux: `claude`/`codex` `comm`)를 찾는다. 전역 스냅샷을 짧은 TTL(≈1s)로 캐시해 타이틀 틱마다의 재열거를 방지한다.
- 타이틀 상태머신이 종료를 보고하거나 버퍼 스캔이 캐시를 lazy-invalidate 하려 할 때, **프로세스가 아직 살아있으면 클리어와 `interactiveAppExited` 를 억제**한다. 프로세스가 사라졌을 때만 종료를 확정한다.
- 버퍼 스캔 인식에 프로세스 트리를 **양성 신호로 추가**한다. 캐시가 차갑거나 타이틀이 스피너뿐이어도 프로세스가 살아있으면 인식한다.

**또한 프론트는 마운트 시 `get_terminal_states` 로 백엔드 현재 인식 상태를 1회 동기화한다.** webview 리로드 후 살아있는 앱이 다음 라이브 이벤트를 기다리지 않고 즉시 복원된다.

## Consequences

- 장시간 세션에서 모호한 타이틀이 끼어들어도 인식이 끊기지 않는다. 종료는 프로세스 소멸이라는 ground truth 로만 확정되므로 오판이 사라진다.
- webview 리로드/복원 직후에도 활동 표시가 백엔드 진실값으로 즉시 채워진다.
- 비용: 전역 프로세스 스냅샷 1회/TTL. 다수 터미널이 있어도 스냅샷은 공유되어 ≈1회/초로 묶인다. PID 가 없는 PTY(직렬 등)나 스냅샷 실패 시에는 기존 타이틀/캐시 신호로 graceful fallback.
- `INTERACTIVE_APP_GRACE_WINDOW`(#237)의 "프로세스 종료 신호 연동" 후속 과제가 이 ADR 로 해소된다. grace window 는 프로세스 PID 가 아직 안 잡힌 초기 splash 구간 보조로만 남는다.
- 인메모리 캐시의 영속화는 채택하지 않는다 — 앱 완전 재시작 시 PTY 가 죽어 감지 대상이 없고, webview 리로드 시 캐시가 이미 생존하므로 영속화는 이득이 없다.
- 프로세스 열거 로직은 `process_tree.rs` 단일 모듈로 통합한다(기존 `claude_session.rs` 의 중복 스냅샷 제거). 현재 감지 경로·계산 규칙은 [architecture/data-flow.md](../architecture/data-flow.md) §8·§9 가 SoT.
- **negative liveness ≠ unknown.** 오라클은 3-state(`PtyAppLiveness`)다: `Running(app)` / `NoneAlive`(PID 확인 + 스냅샷 성공 + 트리에 앱 없음 = **권위 있는 부재**) / `Unknown`(PID 없음·serial·스냅샷 실패 = 신호 없음). `NoneAlive` 는 권위가 있으므로 stale 휴리스틱을 이긴다 — 버퍼 스캔의 강신호 배너 재고정을 건너뛰고 즉시 false. `Unknown` 만 타이틀/버퍼 휴리스틱으로 폴백한다. 이 구분이 없으면 OSC exit title 없이 죽은 경우(SIGKILL·콜백 드롭)에도 최근 16KB 의 `Claude Code`/`OpenAI Codex` 배너가 스크롤아웃될 때까지 앱을 살아있는 것으로 재고정한다.
- **한계 — 네이티브 런처 전제.** 식별은 실행 파일 이름(`claude(.exe)`/`codex(.exe)`)만으로 한다(명령행 introspection 은 Windows 에서 비싸고 깨지기 쉬워 채택하지 않음). laymux 의 지원 설치 형태는 네이티브 바이너리(`~/.local/bin/claude.exe`, `@openai/codex` 의 `codex.exe`)다. npm 전역 설치처럼 shim 이 `node`(`node.exe`)로 떠 트리에 `claude`/`codex` 프로세스가 없는 형태에서는 오라클이 `NoneAlive` 로 분류되어 **버퍼-스캔(본문 배너) 폴백을 받지 못한다** — 다만 `detect_interactive_app_from_title` 의 직접 타이틀 매칭(`Claude Code`/`✳ Claude Code` 등 오라클과 무관)과 grace window 로 여전히 감지되므로, 긴 spinner-only 작업 구간(>grace)에서만 표시가 빠질 수 있다. shim 설치까지 견고히 하려면 부모-자식 명령행 introspection 보강이 별도 후속 과제다.
- **종료 확정은 fresh 스냅샷으로.** 양성 감지(hot path)는 ≤1 TTL stale 스냅샷을 써도 무해하지만(직후 종료를 잠깐 살아있다 보고 후 자기수정), **false-exit 억제 판정**은 막 종료된 프로세스를 stale 스냅샷이 "살아있음"으로 보고해 진짜 종료를 억제할 수 있으므로 TTL 을 우회한 fresh 열거(`interactive_app_in_pty_fresh`)로 한다. 셸 프롬프트 타이틀이 도착하는 시점엔 프로세스가 이미 사라져 fresh 열거가 정확히 `NoneAlive` 를 준다.
