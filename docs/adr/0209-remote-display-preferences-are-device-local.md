# 0209. Remote 표시 선호는 기기 로컬로 소유한다

- Status: Accepted
- Date: 2026-08-27
- Source: 사용자 요구("원격 화면이라는 세팅 섹션 전체를 로컬로 옮기고 PC에서는 제거", "건너뛰기 외 전부 PC 동기화보다 기기별 소유가 나은지 판정") · [architecture/api-contracts.md §10·§13](../architecture/api-contracts.md) · [ADR-0004](0004-settings-vs-ui-state-separation.md) · [ADR-0142](0142-wheel-scroll-sensitivity-per-surface.md) · [ADR-0182](0182-remote-scroll-top-history-expansion.md)
- Supersedes: [ADR-0173](0173-remote-display-settings-pc-owned-and-lease-gated.md), [ADR-0199](0199-remote-menu-font-size-pc-owned.md), [ADR-0200](0200-remote-composer-opacity-state-settings.md)
- Corrects: [ADR-0142](0142-wheel-scroll-sensitivity-per-surface.md)의 Remote 민감도 영속 위치와 [ADR-0182](0182-remote-scroll-top-history-expansion.md)의 최초 checkpoint 예산 소유권

## Context

Remote terminal은 휴대폰, 태블릿, 데스크톱 브라우저처럼 화면 밀도와 포인터가 서로 다른 기기에서 열린다. 그런데 기존 `Remote Display` 설정은 terminal/composer/menu 글자 크기, Composer 불투명도, 스크롤 민감도를 PC의 단일 `settings.remote` 값으로 저장했다. 한 기기에서 맞춘 값이 다른 기기에 즉시 전파되고 마지막 저장자가 모든 Remote 표면의 취향을 덮었다.

이 표시값을 PC가 알아야 terminal을 제어할 수 있는 것은 아니다. Remote는 자기 cell metrics로 fit한 결과인 PTY `cols/rows`만 controller resize 계약으로 PC에 보내면 된다. Composer와 메뉴의 크기·불투명도, wheel·touch 배율은 Remote DOM과 입력 해석에서만 소비된다. 이 값들을 PC에 영속하기 위해 별도 settings projection, controller lease, 전체 설정 revision CAS를 유지하는 비용은 공유할 상태가 없는 데 비해 크다.

반면 폰트 바이너리 제공과 위젯 snapshot 공개는 PC가 네트워크로 무엇을 내보낼지 정하는 호스트 정책이다. 인증·allowlist·Cloud·lease 정책도 Remote 페이지가 자기 저장소로 결정할 수 없다. checkpoint에는 기기별 초기 전송량 취향이 있지만 실제 직렬화 비용과 노출량은 서버 절대 상한이 제한해야 한다.

범위는 PC Settings의 `Remote Display` 섹션, Remote drawer의 표시 설정, terminal appearance payload, checkpoint 초기 예산이다. Remote 입력 문자열의 비영속 경계, terminal runtime 소유권, 폰트 family/theme의 host projection, 위젯 배치 SoT, Remote 인증·lease·Cloud 계약은 비목표다.

## Decision

**Remote 표시·입력 감도·초기 checkpoint 예산은 Remote 문서의 기기 로컬 저장소가 소유하고, PC는 네트워크 접근·데이터 공개·서버 상한만 소유한다.**

- Remote 문서는 `localStorage["laymux.remote.displaySettings"]` 한 객체에 `terminalFontSize`, `composerFontSize`, `menuFontSize`, `composerIdleOpacity`, `composerFocusedOpacity`, `composerActiveOpacity`, `snapshotMaxKib`, `scrollSensitivity`, `fastScrollSensitivity`, `touchScrollSensitivity`, `twoFingerScrollSensitivity`를 저장한다. 저장소가 없거나 값이 손상되면 기존 기본값과 범위 정규화를 적용하며 문서 runtime에서는 계속 동작한다.
- 이 값들은 연결·인증·controller lease 없이 편집할 수 있다. 저장 즉시 현재 xterm options/CSS/gesture 상태에 적용하고 terminal 글자 크기 변경은 기존 Remote fit→PTY resize 경로를 사용한다. 기기 설정 자체는 Remote API로 보내지 않는다.
- `settings.remote`와 PC Settings에서 위 11개 필드를 제거하고 PC의 `Remote Display` 내비게이션도 없앤다. 기존 설정 파일의 알 수 없는 필드는 내부 개발 단계의 무마이그레이션 정책대로 load에서 무시하고 다음 저장에서 사라진다.
- Remote terminal appearance payload는 PC가 소유하는 font family/선택적 font asset, cursor, theme만 전달한다. 클라이언트는 자기 font size와 네 scroll multiplier를 결합해 xterm과 gesture layer에 적용한다.
- `/remote/v1/display-settings` GET/PUT과 Android E2E exact allowlist 항목을 제거한다. 표시 선호 변경은 host mutation이 아니므로 lease·settings revision CAS도 없다.
- `snapshotMaxKib`는 bundled Remote가 output attach의 `historyKib`로 매번 보낸다. 서버는 설정값 대신 기존 기본 floor 4 KiB와 요청값의 최댓값을 사용하고 기존 1..1024 KiB clamp 및 1 MiB checkpoint 절대 상한을 유지한다. Android connector가 history budget capability를 광고하지 않으면 요청을 생략하고 서버 기본 floor로 동작한다.
- `settings.remote.serveTerminalFont`와 `settings.remote.widgets`는 호스트의 데이터 공개 게이트로 유지하며 PC `Remote Connection`의 고급 호스트 정책에 둔다. Remote의 위젯 바 표시 토글은 기존대로 별도 기기 로컬 게이트이며 두 게이트의 논리곱을 유지한다.
- 입력 action 배치, composer 기능 토글·scope, 입력 모드, navigation 건너뛰기처럼 이미 기기 로컬인 상태는 현재 저장 키와 수명 계약을 유지한다. 입력 초안과 history 문자열도 계속 메모리 전용이다.

## Alternatives Considered

- **navigation 건너뛰기만 기기 로컬에 두고 나머지를 모두 PC에 동기화한다.** 단일 백업 위치는 생기지만 휴대폰·태블릿·마우스 브라우저가 서로 다른 크기와 배율을 필요로 한다. 단일 PC 값은 동기화가 아니라 마지막 저장자 전역 덮어쓰기가 되므로 선택하지 않았다.
- **PC 값을 공통 기본값으로 두고 기기 override를 추가한다.** 새 기기의 seed를 중앙에서 정할 수 있지만 모든 필드에 default/override 해석과 reset UI가 생기고 두 설정 표면이 계속 중복된다. 현재 요구에는 기기 기본값만으로 충분해 선택하지 않았다.
- **모든 `Remote Display` 항목을 무조건 기기 로컬로 옮긴다.** 폰트 바이너리 재배포와 위젯 데이터 공개까지 원격 요청자가 켤 수 있어 호스트의 보안·라이선스 정책을 잃는다. 표시 취향과 host 공개 권한을 분리한다.
- **기기 식별자를 발급해 PC가 기기별 map을 저장한다.** origin을 넘어 선호를 복구할 수 있지만 안정적 identity, 삭제 UI, stale device 정리, Cloud/Direct 병합 정책이 새로 필요하다. 브라우저 origin별 localStorage 수명으로 충분한 동안 도입하지 않는다.

## Consequences

- 같은 PC에 붙은 Remote 기기들이 각자 화면 밀도와 입력 장치에 맞는 값을 유지하며 서로 덮어쓰지 않는다. 연결 전에도 설정할 수 있고 display-settings mutation 경로가 사라진다.
- 브라우저 localStorage는 origin별이므로 LAN·Tailscale·Cloud origin이 다르면 선호도 별개다. site data를 지우면 기본값으로 돌아간다. origin 간 동기화 요구가 생기면 기기 identity 기반 저장을 새 ADR로 검토한다.
- PC Settings의 Remote 그룹에는 연결·보안·Cloud와 호스트 공개 정책만 남는다. `settings.json`, Automation/MCP schema에서도 기기 표시 필드가 사라진다.
- client가 큰 초기 checkpoint를 고르면 attach 비용이 늘지만 서버 clamp와 절대 상한은 유지된다. 값 변경은 다음 attach부터 적용하며 이미 받은 scrollback을 즉시 버리거나 재attach하지 않는다.
- Direct browser와 Android E2E는 PC가 제공한 같은 문서 코드를 쓰지만 localStorage 구현은 각 origin/WebView가 제공한다. 저장 실패 fallback과 Android history-budget capability gate를 자동화 테스트로 고정한다.
- 검증은 Rust 설정 schema/appearance/route allowlist, Remote page source 계약, PC Settings UI, Playwright의 localStorage 복원·즉시 적용·attach 예산·서버 요청 부재를 포함한다.
