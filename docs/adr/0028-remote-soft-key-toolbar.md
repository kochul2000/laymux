# 0028. Remote Soft-Key Toolbar (client-side, customizable)

- Status: Accepted
- Date: 2026-07-13
- Source: 사용자 요청(remote 추가 키보드 표시); ADR-0004(settings vs localStorage), ADR-0013(Direct Remote Mode), ADR-0015(Remote 터미널 상태 소유권)

## Context

Focused Remote UI(`src-tauri/src/remote_server/page.html`)는 모바일 브라우저에서 터미널을 제어한다. 입력 보조는 `Copy` / `Ctrl+C` / `Keyboard`(포커스) 세 버튼뿐이었다. 방향키·Tab·Esc·PgUp/PgDn·Ctrl 조합·F 키처럼 개발에 필수적인 키는 모바일 소프트 키보드에 없거나 키보드 전환을 반복해야 눌러야 했다.

기존 `Ctrl+C` 버튼이 이미 `enqueueInput("\x03")` 로 escape 시퀀스를 `/remote/v1/terminals/{id}/write` 에 보내는 것과 같은 경로를 재사용하면, 새 Remote API 없이 임의의 제어/escape 키를 보낼 수 있다.

## Decision

Remote 페이지에 **클라이언트 전용 소프트 키 툴바**를 추가한다.

- 키 입력은 기존 `enqueueInput` → `/remote/v1/terminals/{id}/write` 경로만 사용한다. **새 Remote API surface·호스트 bridge·settings 스키마를 만들지 않는다.**
- 방향키·Home·End 는 DECCKM(application cursor keys) 모드를 반영한다: `terminal.modes.applicationCursorKeysMode` 가 참이면 SS3(`\x1bO<final>`), 아니면 CSI(`\x1b[<final>`). 나머지 키는 고정 시퀀스(VT220 계열)를 보낸다.
- 표시 여부·선택한 세트·커스텀 키는 **remote 클라이언트 UI 상태**이므로 `localStorage` 키 `laymux.remote.keybar` 에 저장한다(ADR-0004: settings.json 은 사용자 구성만, 표시 상태는 localStorage). 이는 ADR-0015 의 "surface 로컬 상태(drawer/selection 등)는 각 surface 가 보유" 범주에 속한다.
- 사전 정의 세트(Navigation / Editing / Ctrl keys / Function)를 다중 선택할 수 있고, 전체 키 팔레트에서 개별 키를 골라 커스텀 세트를 구성한다. 툴바는 활성 세트 + 커스텀의 정렬된 합집합을 렌더한다.
- 키 버튼은 터미널 포커스를 가져오지 않는다(포커스 시 네이티브 소프트 키보드가 떠서 보조 키의 목적을 무산시키므로).

Remote 페이지는 여전히 focused terminal controller 이며 full workspace editor 가 아니다(ADR-0018). 이 툴바는 입력 보조 표시 계층일 뿐 계약을 넓히지 않는다.

## Consequences

- 모바일에서 키보드 전환 없이 방향키·Tab·Esc·Ctrl 조합·F 키 등을 보낼 수 있다. 기기별로 표시/세트 구성이 유지된다.
- Rust 백엔드·Remote API 계약은 변하지 않는다. 정적 asset(`page.html`) 검증은 `page.rs` 단위 테스트로 커버한다(마크업·기본 세트·시퀀스·DECCKM 분기).
- 시퀀스는 xterm 관례를 따르되 호스트 셸/터미널 앱에 따라 일부 키(F 키·PgUp/PgDn) 해석이 다를 수 있다. 필요 시 세트/시퀀스는 추가·조정 가능하며 이는 계약 변경이 아니다.
- 커스텀 키 저장은 클라이언트 로컬이라 기기 간 동기화되지 않는다. 크로스 기기 동기화가 필요해지면 별도 결정을 만든다.
