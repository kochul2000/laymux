# 0031. Extension viewer 실행 프로필과 경로 변환 책임

- Status: Accepted
- Date: 2026-07-13
- Source: issue #446, architecture/api-contracts.md §10·§14, architecture/data-flow.md §8

## Context

확장자별 외부 viewer는 지금까지 파일 경로 모양과 현재 기본 프로필을 보고 프론트엔드가 실행 프로필을 암묵 추론한 뒤, `command + shellEscape(path)` 문자열을 만들어 일반 터미널의 startup command override로 전달했다. 이 방식은 여러 WSL distro 중 어느 환경에서 실행할지 표현할 수 없고, Windows 경로를 WSL viewer에 넘기거나 Linux 경로를 Windows viewer에 넘길 때 경로 변환 책임과 shell quoting이 프론트엔드에 섞인다. 또한 문자열 override allowlist는 구조화된 설정 mapping과 실제 실행 요청의 관계를 충분히 검증하지 못한다.

## Decision

각 `ExtensionViewer` mapping은 실행할 터미널 `profile` 이름을 명시적으로 참조한다. 빈 profile은 이전 설정 역직렬화를 위해 허용하되 실행 가능한 기본값으로 추론하지 않고 UI와 런타임에서 설정 필요 오류로 처리한다.

프론트엔드는 viewer `command`와 원본 `path`를 구조화된 IPC 인자로 전달하며 startup command 문자열이나 shell quoting을 만들지 않는다. Rust는 요청의 확장자·command·profile 조합이 `settings.fileExplorer.extensionViewers`와 정확히 일치하고 profile이 존재하는지 검증한다. 선택 profile의 `commandLine`으로 WSL/Windows 실행 환경을 판별하고, 기존 `path_utils`를 통해 Windows drive path와 `/mnt/<drive>` path를 변환하며 pure Linux path를 Windows에서 열 때 explicit/default WSL distro의 UNC path를 사용한다. 변환된 단일 path 인자는 대상 shell 규칙에 맞게 Rust에서 quote한 뒤 whitelisted command에 결합한다.

일반 `startupCommandOverride`는 Claude session resume 전용으로 제한하고 extension viewer 실행 우회로 사용하지 않는다.

## Consequences

- 여러 WSL distro와 Windows profile을 mapping별로 정확히 선택할 수 있다.
- 경로 변환·quoting·allowlist 검증이 Rust 단일 경계에 모여 프론트엔드와 backend의 shell 해석 차이가 사라진다.
- profile 이름 변경·삭제 시 이를 참조하는 mapping은 자동 추론하지 않고 명시 오류가 된다.
- 기존 `profile` 누락 설정은 마이그레이션하지 않으며 사용자가 Settings에서 실행 profile을 지정해야 한다.
- 새 shell 환경을 지원할 때 Rust의 환경 판별·path conversion·quoting 정책을 함께 확장해야 한다.
