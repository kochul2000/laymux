# 0337. inbox(구형) WSL 클라이언트로 WSL을 쓰면 경고만 띄운다 (0334 후속)

- Status: Proposed
- Date: 2026-10-16
- Source: 사용자 요구("구형 감지해서 경고 띄우는 것만") · [ADR-0334](0334-console-less-wsl-runs.md) 후속 항목 · [api-contracts.md](../architecture/api-contracts.md) §14 프로세스 실행
- 관계: ADR-0334의 "inbox fallback 경로의 콘솔 누수 감지" 후속 항목을 경고로 좁힌다. 감지·차단은 하지 않는다.

## Context

ADR-0334 이후 laymux의 파이프 기반 `wsl.exe` 실행은 lifted WSL이 있으면 콘솔 없이 실행된다. lifted 설치(`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Lxss\MSI` `InstallLocation`)가 없는 PC는 inbox 런처로 되돌아가고, 실행마다 콘솔(`conhost.exe`, USER 3·GDI 10)이 생긴다. 2026-10-16처럼 WSL이 콘솔 정리를 멈추면 이 경로에서는 세션 USER 자원 고갈이 다시 일어날 수 있다.

해결은 사용자 쪽에 있다. `wsl --update`로 lifted WSL을 설치하면 laymux는 다음 실행부터 콘솔 없는 경로를 쓴다. 사용자는 자기 WSL이 구형인지, 그게 laymux에 어떤 위험인지 알 수단이 없다.

모든 Windows 설치에 inbox 런처가 있으므로 "lifted 설치 없음"만으로는 WSL 사용을 뜻하지 않는다. WSL을 쓰지 않는 사용자에게 경고가 뜨면 안 된다.

범위는 Windows 데스크톱 UI의 경고다. 비목표: 남은 콘솔의 감지·자동 정리, WSL probe 중단(circuit breaker), 자동 업데이트, 영구적인 "다시 보지 않기" 설정, Remote·모바일 표시.

## Decision

**WSL 클라이언트가 inbox로 해석되고 WSL 기반 터미널 세션이 열려 있으면, 데스크톱 좌하단에 `wsl --update` 설치를 권하는 경고를 띄우고, 닫으면 그 실행 동안 다시 띄우지 않는다.**

- **판정 SoT는 Rust다.** `crate::process::wsl_client_is_inbox()`는 ADR-0334의 런처 해석을 그대로 쓴다(비Windows는 항상 false). WSL 사용 근거는 `initial_execution_host == Wsl`인 터미널 세션의 존재다. probe를 실행시키는 것이 그 세션이기 때문이다(ADR-0120·0134). 프론트엔드는 프로필로 환경을 추측하지 않는다(ADR-0330과 같은 원칙).
- **계약.** `get_legacy_wsl_notice` IPC(`#[tauri::command(async)]`, 첫 호출에 레지스트리·파일을 읽음, ADR-0202)는 두 조건이 모두 참일 때만 `true`를 돌려준다.
- **조회 시점.** `LegacyWslNotice`는 마운트 때와 준비된(`sessionReady`) 터미널 세션 수가 바뀔 때 조회한다. 한 번 `true`가 되거나 닫히면 더 조회하지 않는다. 조회 실패는 경고 근거가 아니다.
- **표시.** 기존 훅 알림(우하단)과 겹치지 않도록 좌하단 고정 카드로 띄운다. 제목·설명·`wsl --update` 명령·닫기 버튼만 둔다. 설명은 콘솔 누적 위험과, 설치 뒤 laymux를 다시 시작해야 한다는 점(런처 해석은 프로세스 수명 동안 캐시된다)을 알린다.
- **닫기**는 컴포넌트 상태에만 둔다. 저장하지 않으므로 다음 실행에서 조건이 남아 있으면 다시 뜬다.

## Alternatives Considered

- **inbox 경로의 콘솔 누수 감지 후 probe 중단** — 보호 효과는 크지만 남은 콘솔과 자식 수명 추적, 임계값, 중단·재개 정책이 필요하다. 사용자 요구는 경고까지이고, 근본 해결(`wsl --update`)이 간단하다.
- **lifted 설치가 없으면 무조건 경고** — WSL을 쓰지 않는 Windows 사용자에게도 뜬다.
- **기존 훅 알림 패널에 합치기** — 훅·MCP 큐와 무관한 시스템 경고가 섞이고, 패널의 다시 보지 않기 설정(ADR-0330)과 의미가 엉킨다.
- **settings.json의 영구 "다시 보지 않기"** — 설정 스키마가 늘어난다. 조건이 남아 있는 한 위험도 남으므로 실행마다 한 번 보이는 쪽을 택했다.
- **OS 알림** — 앱 밖으로 나가고, 명령 안내를 담기 어렵다.

## Consequences

- inbox WSL로 laymux를 쓰는 사용자는 위험과 해결 명령을 앱 안에서 바로 본다. lifted WSL 사용자와 WSL을 쓰지 않는 사용자에게는 보이지 않는다.
- 조건이 남아 있으면 실행마다 한 번 보인다. 업데이트 직후에도 laymux를 다시 시작하기 전까지는 계속 보일 수 있다(런처 해석 캐시).
- 콘솔 누수 자체는 막지 않는다. inbox 경로의 위험은 ADR-0334 Consequences에 적힌 그대로 남는다.
- 비용: IPC 1개, 레이아웃 컴포넌트 1개, 로케일 문구, CSS. Rust 판정과 컴포넌트 동작을 단위·컴포넌트 테스트로 검증한다.
- 재검토 조건: inbox 사용자에게서 같은 고갈이 신고되면 감지·중단을 다시 검토한다. WSL이 lifted 설치 위치 기록 방식을 바꾸면 ADR-0334와 함께 본다.
