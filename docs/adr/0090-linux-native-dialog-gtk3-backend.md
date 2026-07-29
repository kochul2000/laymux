# 0090. Linux 네이티브 대화상자는 기존 Tauri GTK3 런타임을 재사용한다

- Status: Accepted
- Date: 2026-07-29
- Source: 사용자 요구 · issue [#652](https://github.com/kochul2000/laymux/issues/652) · [architecture/overview.md §2](../architecture/overview.md) · [`rfd` 0.15.4 Linux backend 계약](https://docs.rs/rfd/0.15.4/rfd/#linux--bsd-backends) · [`rfd` 0.15.4 feature 정의](https://docs.rs/crate/rfd/0.15.4/source/Cargo.toml.orig) · [Tauri v2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/)

## Context

laymux는 Windows와 Linux를 지원하고, panic hook의 최후 알림 수단으로
`rfd::MessageDialog`를 사용한다. 그러나 `rfd 0.15.4`를 모든 플랫폼에서
`default-features = false`로 선언해 Linux backend를 하나도 선택하지 않았다. 그 결과
Ubuntu 22.04/WSL2의 `cargo check --locked -p laymux --lib`는 `rfd` build script의
"gtk3 또는 xdg-portal backend가 필요하다"는 오류로 중단된다. Windows는 backend
선택 검사가 없어 이 결함이 드러나지 않았다.

`rfd 0.15.4`의 Linux 선택지는 `gtk3`와 `xdg-portal`이다. `xdg-portal`은
`tokio` 또는 `async-std` feature와 런타임 portal 구현을 요구한다. 또한 이 버전의
`MessageDialog`는 portal API가 아니라 외부 `zenity` 프로세스로 구현되어, 현재
crash reporter의 최후 알림 경로에 새 런타임 의존성과 프로세스 실행 실패면을 만든다.
`gtk3`는 프로세스 외부 의존 없이 `MessageDialog`를 지원하고 `libgtk-3-dev`가 필요하다.
laymux의 Tauri/WebKitGTK Linux
빌드와 배포는 이미 같은 GTK3 개발·런타임 라이브러리를 필수로 하며 README의 Linux
prerequisite에도 이를 명시한다.

이 결정의 범위는 `rfd`의 Linux backend와 빌드·배포 계약이다. crash dialog의 내용,
panic fallback 정책, 일반 UI 또는 새로운 파일 선택 기능은 바꾸지 않는다.

## Decision

**Linux의 `rfd 0.15.4` backend는 `gtk3`로 고정하고, Windows dependency는 backend
feature 없는 기존 계약을 별도 target dependency로 유지한다.**

- 공통 `rfd` dependency를 제거하고 `cfg(target_os = "linux")`에는
  `default-features = false, features = ["gtk3"]`, `cfg(windows)`에는
  `default-features = false`만 선언한다.
- Linux는 Tauri/WebKitGTK가 이미 요구하는 GTK3 system dependency를 재사용한다.
  `xdg-desktop-portal`, portal backend 또는 별도 async executor를 새 필수 런타임으로
  추가하지 않는다.
- panic hook의 `MessageDialog`와 `catch_unwind`/stderr fallback은 유지한다. headless
  unit test는 대화상자를 열지 않고, Linux library compile이 이 API의 존재와 링크
  seam을 검증한다.
- 회귀 테스트는 Cargo metadata로 두 target dependency와 비활성 default feature를
  확인하고, target별 `--locked --filter-platform` resolved dependency graph에서 Linux의
  GTK sys edge와 Windows의 Linux backend edge 부재를 고정한다.
  Linux 검증은 Ubuntu 22.04에서 별도 feature 인자 없이 locked library check를 수행한다.
- Linux 패키징의 system dependency 문서는 Tauri prerequisite와 같은
  `libgtk-3-dev`/GTK3 runtime을 정본으로 삼는다. 지원 배포판이 Tauri의 GTK 계약을
  바꾸면 `rfd` backend도 함께 재검토한다.

## Alternatives Considered

- **`xdg-portal` + `tokio`를 선택한다.** 파일 대화상자는 Wayland sandbox와 desktop
  portal을 따를 수 있지만, `rfd 0.15.4`의 `MessageDialog`는 portal API를 사용하지 않고
  외부 `zenity` 실행에 의존한다. portal runtime과 별도 프로세스 의존성을 crash 알림의
  필수 경로에 추가하므로 기각했다.
- **`rfd` 기본 feature를 다시 켠다.** 기본값은 `xdg-portal`과 `async-std`를 함께
  활성화해 이미 사용하는 Tokio와 별개 executor를 추가하고 `MessageDialog`는 여전히
  외부 `zenity`에 의존한다. dependency 계약을 암묵화하므로 기각했다.
- **Linux crash dialog를 제거하고 stderr만 사용한다.** build는 단순해지지만 GUI로
  실행된 앱의 치명 오류 알림을 Windows와 다르게 약화한다. 이 이슈의 완료 조건과
  기존 기능 보존에 맞지 않아 기각했다.
- **모든 플랫폼에서 `gtk3` feature를 전역 활성화한다.** `rfd`는 Windows에서 그
  feature가 효과 없다고 문서화하지만, target별 의도를 manifest와 metadata에서
  증명하기 어렵다. 향후 feature 변경도 Windows graph에 불필요하게 결합하므로
  target dependency 분리를 선택했다.

## Consequences

- Linux 전체 Rust library build가 backend 선택 오류 없이 진행되고 현재 crash dialog가
  compile된다. Windows의 `rfd` feature와 native dialog 구현은 변하지 않는다.
- Linux 개발/배포는 GTK3가 필요하지만 이는 새 요구사항이 아니라 Tauri/WebKitGTK의
  기존 prerequisite다. headless CI도 링크 단계에는 GTK3 개발 패키지가 필요하다.
- GTK dialog는 portal-native sandbox 통합을 제공하지 않는다. Flatpak처럼 portal이
  필수인 배포를 지원하거나 `rfd`가 portal backend에서 `MessageDialog`를 제공하게 되면
  새 ADR로 backend와 crash 알림 정책을 함께 재평가한다.
- 현재 제품은 파일 선택/저장 대화상자를 호출하지 않는다. 향후 그 기능을 추가할 때는
  GTK backend의 UX와 sandbox 접근 권한을 별도 요구사항으로 검증해야 한다.
