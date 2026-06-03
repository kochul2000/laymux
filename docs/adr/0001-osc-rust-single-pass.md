# 0001. OSC 처리 — Rust 단일 패스, 프론트엔드는 이벤트만

- Status: Accepted
- Date: 2026-06-03
- Source: 구 ARCHITECTURE.md §8.3, CLAUDE.md 규칙

## Context

터미널 OSC 이스케이프 시퀀스(OSC 7 CWD, OSC 133 셸 통합, OSC 9/99/777 알림 등)를 어디서 처리할지 결정이 필요했다. 프론트엔드에서 PTY 출력을 regex 로 파싱하고 훅 조건을 평가하면, OSC 데이터가 IPC 를 라운드트립(Rust→프론트→lx→Rust)하고, 파싱·조건 평가 로직이 프론트와 백엔드에 중복되어 자기모순에 빠지기 쉽다.

## Decision

OSC 의 **파싱·훅 매칭·액션 디스패치를 모두 Rust PTY 콜백의 단일 패스에서 처리**한다.

- 파싱: `osc.rs` 의 `iter_osc_events()` 가 PTY 출력에서 모든 OSC 를 한 번에 추출.
- 훅 매칭: `osc_hooks.rs` 의 선언적 `OscCondition`/`OscAction` 모델 + `match_hooks()`.
- 디스패치: `dispatch_osc_action()` 이 `do_sync_cwd()`/`do_notify()` 등 공유 함수를 직접 호출 (IPC 라운드트립 없음).
- 프론트엔드는 Rust 가 발행한 구조화 Tauri 이벤트(`terminal-title-changed`, `terminal-cwd-changed`, `sync-cwd`, `lx-notify` 등)만 구독한다.

## Consequences

- 새 OSC 동작은 `osc_hooks.rs` 에 프리셋(`OscHookDef`)을 추가하고 `dispatch_osc_action()` 에 분기를 추가한다. 프론트는 새 이벤트만 소비.
- 프론트엔드에서 OSC regex 파싱, `new Function()` 기반 훅 조건 평가, IPC 라운드트립 OSC 처리는 **금지**.
- 현재 흐름과 프리셋 목록은 living doc [architecture/data-flow.md](../architecture/data-flow.md) §8.3 이 SoT.
