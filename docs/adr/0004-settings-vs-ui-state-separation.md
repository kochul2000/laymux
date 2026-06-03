# 0004. settings.json(구성) vs localStorage(UI 상태) 분리 + 오버라이드 레이어

- Status: Accepted
- Date: 2026-06-03
- Source: 구 ARCHITECTURE.md §4.2 · §10

## Context

재시작 간 보존돼야 하는 값에는 두 종류가 섞인다 — (1) 사용자가 의도적으로 편집·공유하는 **구성**(프로파일, 키바인딩, 워크스페이스 레이아웃)과 (2) 설정 UI 를 거치지 않고 즉흥적으로 바꾸는 **UI 상태**(컨트롤 바 모드, 폰트 줌). 둘을 한 파일에 섞으면 `settings.json` 이 휘발성 상태로 오염되고, Windows Terminal 호환 교집합도 깨진다.

## Decision

**구성은 `settings.json`, UI 상태는 localStorage** 로 엄격히 분리하고, 그 사이에 두 개의 일급 오버라이드 공간을 둔다.

- `paneOverrides` — 레이아웃 **슬롯**에 귀속(예: `controlBarMode`). 슬롯 안 view 가 바뀌어도 유지.
- `viewOverrides` — 슬롯 **콘텐츠(view)**에 귀속(예: TerminalView `fontSize`). view 타입이 바뀌면 자동 리셋.
- 둘 다 `useOverridesStore` 에서 관리. 해석 우선순위: `profileDefaults → profile → paneOverrides → viewOverrides`.

## Consequences

- 새 필드는 "슬롯 속성인가 콘텐츠 속성인가"로 override 종류를 정하고, 설정 UI 기본값이 있으면 해석 체인에 기본값 경로를 둔다.
- 라이프사이클: pane 삭제 시 `clearAll`, view 타입 전환 시 `clearViewOverride`, 기동 시 `gcStale`.
- 내부 개발 단계이므로 설정 스키마 변경에 마이그레이션을 구현하지 않는다(기존 데이터는 수동 처리).
- 현재 필드/해석 계층은 [architecture/overview.md](../architecture/overview.md) §4.2 가 SoT.
